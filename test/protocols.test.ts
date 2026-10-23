// One test per protocol family, each against a real local server.
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Aedes } from "aedes";
import { buildSchema, graphql } from "graphql";
import * as soap from "soap";
import { createServer } from "../src/output/server.ts";
import { fakeClaude, fixtures, listen, makeApp, status, until, wait } from "./helpers.ts";

test("graphql: introspection → tools; mutations need approval; raw tool rejects mutations", async () => {
  const schema = buildSchema(`
    type Item { id: ID! name: String! tags: [String!]! owner: User }
    type User { id: ID! email: String }
    type Query { hello(name: String!): String! items(limit: Int = 10): [Item!]! }
    type Mutation { addItem(name: String!): Item! }
  `);
  const items = [{ id: "1", name: "Lampa", tags: ["el"], owner: { id: "u1", email: "a@b.se" } }];
  const root = {
    hello: ({ name }: any) => `Hej ${name}`,
    items: ({ limit }: any) => items.slice(0, limit),
    addItem: ({ name }: any) => ({ id: "2", name, tags: [] }),
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { query, variables } = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(await graphql({ schema, source: query, variableValues: variables, rootValue: root })));
  });
  const url = await listen(server);
  const t = await makeApp({ shop: `id: shop\nname: Shop\nkind: graphql\nendpoint: ${url}/graphql\n` });
  try {
    assert.equal(status(t.app, "shop")?.status, "ready");
    assert.ok(t.app.registry.get("shop__mutate_addItem")!.confirm);
    assert.equal(t.app.registry.get("shop__hello")!.confirm, false);

    const hello = await t.app.registry.call("shop__hello", { name: "Ada" });
    assert.match(hello.text, /Hej Ada/);
    const list = await t.app.registry.call("shop__items", {});
    assert.match(list.text, /Lampa/);
    assert.match(list.text, /a@b\.se/, "nested object fields are selected");

    const raw = await t.app.registry.call("shop__graphql", { query: "mutation { addItem(name: \"x\") { id } }" });
    assert.ok(raw.isError);
    const search = await t.app.registry.call("shop__schema_search", { term: "item" });
    assert.match(search.text, /Item/);
  } finally {
    await t.cleanup();
    server.close();
  }
});

test("grpc: unary, server-streaming and write-verb approval", async () => {
  const def = protoLoader.loadSync(path.join(fixtures, "greeter.proto"), { keepCase: true });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const server = new grpc.Server();
  server.addService(pkg.demo.Greeter.service, {
    SayHello: (call: any, cb: any) => cb(null, { message: `Hej ${call.request.name} (${call.request.mood})` }),
    CreateGreeting: (call: any, cb: any) => cb(null, { message: "skapad" }),
    ListGreetings: (call: any) => {
      for (let i = 0; i < call.request.times; i++) call.write({ message: `#${i}` });
      call.end();
    },
  });
  const port = await new Promise<number>((r, j) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? j(e) : r(p))));
  const t = await makeApp({
    greet: `id: greet\nname: Greeter\nkind: grpc\naddress: 127.0.0.1:${port}\ntls: false\nprotoFiles: [${path.join(fixtures, "greeter.proto")}]\n`,
  });
  try {
    assert.equal(status(t.app, "greet")?.status, "ready", status(t.app, "greet")?.message);
    const say = t.app.registry.get("greet__Greeter_SayHello")!;
    assert.deepEqual(Object.keys((say.inputSchema.properties as any)), ["name", "times", "mood"]);
    assert.deepEqual((say.inputSchema.properties as any).mood.enum, ["NEUTRAL", "HAPPY"]);
    assert.ok(t.app.registry.get("greet__Greeter_CreateGreeting")!.confirm);

    const out = await t.app.registry.call("greet__Greeter_SayHello", { name: "Ada", mood: "HAPPY" });
    assert.match(out.text, /Hej Ada \(1\)/); // test server sees the enum as its number
    const stream = await t.app.registry.call("greet__Greeter_ListGreetings", { name: "x", times: 3 });
    assert.equal(JSON.parse(stream.text).length, 3);
  } finally {
    await t.cleanup();
    server.forceShutdown();
  }
});

test("soap: WSDL operations become tools", async () => {
  const wsdl = fs.readFileSync(path.join(fixtures, "calculator.wsdl"), "utf8");
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const url = await listen(server);
  soap.listen(server, "/calc", { CalculatorService: { CalculatorPort: { Add: (args: any) => ({ result: Number(args.a) + Number(args.b) }) } } }, wsdl);
  const t = await makeApp({ calc: `id: calc\nname: Kalkylator\nkind: soap\nwsdl: ${url}/calc?wsdl\nendpoint: ${url}/calc\n` });
  try {
    assert.equal(status(t.app, "calc")?.status, "ready", status(t.app, "calc")?.message);
    const add = t.app.registry.get("calc__Add")!;
    assert.equal((add.inputSchema.properties as any).a.type, "integer");
    const out = await t.app.registry.call("calc__Add", { a: 2, b: 40 });
    assert.match(out.text, /42/);
  } finally {
    await t.cleanup();
    server.close();
  }
});

test("sql (sqlite): read-only by default, params, writes blocked", async () => {
  const t = await makeApp({});
  const dbFile = path.join(t.dir, "shop.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec("create table orders (id integer primary key, customer text, total real); insert into orders (customer, total) values ('Ada', 100), ('Bo', 250);");
  db.close();
  fs.writeFileSync(path.join(t.integrationsDir, "shop.yaml"), `id: shopdb\nname: Ordrar\nkind: sql\ndriver: sqlite\nconnection: ${dbFile}\n`);
  await t.app.reload();
  try {
    assert.equal(status(t.app, "shopdb")?.status, "ready", status(t.app, "shopdb")?.message);
    assert.equal(t.app.registry.get("shopdb__execute"), undefined, "no write tool unless allowWrite");
    assert.match((await t.app.registry.call("shopdb__list_tables", {})).text, /orders/);
    assert.match((await t.app.registry.call("shopdb__describe_table", { table: "orders" })).text, /customer/);
    const q = await t.app.registry.call("shopdb__query", { sql: "select customer from orders where total > ?", params: [200] });
    assert.match(q.text, /Bo/);
    assert.doesNotMatch(q.text, /Ada/);
    const write = await t.app.registry.call("shopdb__query", { sql: "delete from orders" });
    assert.ok(write.isError);
  } finally {
    await t.cleanup();
  }
});

test("cli: placeholders become separate argv entries – no shell injection", async () => {
  const t = await makeApp({
    tool: `id: tool
name: Verktyg
kind: cli
commands:
  - name: echo
    description: Skriver ut argument
    command: ${process.execPath}
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "{text}", "{extra}"]
    params:
      - { name: text, required: true }
      - { name: extra, type: array }
`,
  });
  try {
    const out = await t.app.registry.call("tool__echo", { text: "hej; rm -rf / $(whoami)" });
    const argv = JSON.parse(out.text.match(/\[.*\]/)![0]);
    assert.deepEqual(argv, ["hej; rm -rf / $(whoami)"]);
    const many = await t.app.registry.call("tool__echo", { text: "a", extra: ["b", "c"] });
    assert.match(many.text, /\["a","b","c"\]/);
  } finally {
    await t.cleanup();
  }
});

test("webhook: HMAC verified, stored as events, triggers an unattended agent run", async () => {
  const calls: any[] = [];
  const llm = fakeClaude(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "install_integration", input: { manifest_yaml: "id: x\nname: X\nkind: http\nbaseUrl: https://x.se\noperations: [{name: a, description: a, path: /}]" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ordern registrerad." }] },
    ],
    calls,
  );
  const t = await makeApp(
    {
      shop: `id: shop
name: Webbshop
kind: webhook
verify: { type: hmac, secret: SHOP_HOOK_SECRET, header: X-Signature, prefix: "sha256=" }
trigger:
  prompt: En ny order kom in. Sammanfatta den.
`,
    },
    { llmClient: llm },
  );
  t.app.secrets.set("SHOP_HOOK_SECRET", "s3cret");
  await t.app.reload();
  const server = createServer(t.app);
  const url = await listen(server);
  try {
    const body = JSON.stringify({ order: 42, total: 199 });
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    const bad = await fetch(`${url}/hooks/shop/orders`, { method: "POST", headers: { "content-type": "application/json", "x-signature": "sha256=fel" }, body });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${url}/hooks/shop/orders`, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body });
    assert.equal(ok.status, 202);

    const [event] = t.app.events.recent("shop");
    assert.deepEqual(event.payload, { order: 42, total: 199 });
    assert.equal(event.source, "/orders");
    await until(() => event.run?.status === "done");
    assert.match(event.run!.summary!, /Ordern registrerad/);
    // install_integration needs approval → denied in an unattended run.
    const result = calls[1].messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.type === "tool_result").content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /mänskligt godkännande/);
    assert.match(calls[0].messages[0].content, /"order": 42/);
    assert.match((await t.app.registry.call("shop__recent_events", {})).text, /199/);
  } finally {
    server.close();
    await t.cleanup();
  }
});

test("queue (mqtt): subscribed messages become events; publish needs approval", async () => {
  const broker = await Aedes.createBroker();
  const tcp = net.createServer(broker.handle as any);
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  const port = (tcp.address() as net.AddressInfo).port;
  const t = await makeApp({
    iot: `id: iot\nname: Sensorer\nkind: queue\ndriver: mqtt\nurl: mqtt://127.0.0.1:${port}\nsubscribe: ["sensors/#"]\npublish: ["commands/fan"]\n`,
  });
  try {
    assert.equal(status(t.app, "iot")?.status, "ready", status(t.app, "iot")?.message);
    assert.ok(t.app.registry.get("iot__publish")!.confirm);
    const forbidden = await t.app.registry.call("iot__publish", { topic: "other", message: "x" });
    assert.ok(forbidden.isError);
    // Publish to a subscribed topic from a second client.
    const mqtt = await import("mqtt");
    const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
    await client.publishAsync("sensors/temp", JSON.stringify({ celsius: 21.5 }));
    await until(() => t.app.events.count("iot") > 0);
    assert.match((await t.app.registry.call("iot__recent_events", {})).text, /21\.5/);
    await client.endAsync();
    const pub = await t.app.registry.call("iot__publish", { topic: "commands/fan", message: { on: true } });
    assert.ok(!pub.isError, pub.text);
  } finally {
    await t.cleanup();
    tcp.close();
    await new Promise((r) => broker.close(r as any));
  }
});

test("connector: on-prem tools show up in the hub, calls are relayed, bad tokens rejected", async () => {
  const { startConnector } = await import("../src/connector/index.ts");
  const hubSide = await makeApp({ onprem: "id: onprem\nname: Kundens datacenter\nkind: connector\nconnectorId: acme-dc1\ntoken: ACME_CONNECTOR_TOKEN\n" });
  hubSide.app.secrets.set("ACME_CONNECTOR_TOKEN", "tok-123");
  await hubSide.app.reload();
  const server = createServer(hubSide.app);
  const url = await listen(server);

  // The customer side: its own folder, its own secrets, a local sqlite "ERP".
  const siteDir = fs.mkdtempSync(path.resolve("test/.tmp-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(siteDir, "erp.db"));
  db.exec("create table invoices (no text, amount real); insert into invoices values ('F-1', 1200);");
  db.close();
  fs.writeFileSync(path.join(siteDir, "erp.yaml"), `id: erp\nname: ERP\nkind: sql\ndriver: sqlite\nconnection: ./erp.db\n`);

  const logs: string[] = [];
  const bad = await startConnector({ hubUrl: url.replace("http", "ws") + "/connect", connectorId: "acme-dc1", token: "fel", integrationsDir: siteDir, secretsFile: path.join(siteDir, "s.json"), log: (m) => logs.push(m) });
  try {
    await until(() => logs.some((l) => l.includes("4401")));
    await bad.stop();
    assert.equal(hubSide.app.registry.get("onprem__erp__query"), undefined);

    const site = await startConnector({ hubUrl: url.replace("http", "ws") + "/connect", connectorId: "acme-dc1", token: "tok-123", integrationsDir: siteDir, secretsFile: path.join(siteDir, "s.json"), log: () => {} });
    await until(() => Boolean(hubSide.app.registry.get("onprem__erp__query")));
    const out = await hubSide.app.registry.call("onprem__erp__query", { sql: "select * from invoices" });
    assert.match(out.text, /F-1/);

    await site.stop();
    await until(() => !hubSide.app.registry.get("onprem__erp__query"));
    assert.match(hubSide.app.registry.integrations.find((i) => i.id === "onprem")!.adapter!.statusMessage!()!, /offline/);
  } finally {
    server.close();
    await hubSide.cleanup();
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
});

test("oauth2 authorization code: PKCE login, bearer on calls, refresh when expired", async () => {
  const issued: string[] = [];
  const authServer = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    let body = "";
    for await (const c of req) body += c;
    if (u.pathname === "/token") {
      const p = new URLSearchParams(body);
      const token = `at-${issued.length + 1}`;
      issued.push(`${p.get("grant_type")}:${p.get("code_verifier") ? "pkce" : ""}`);
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ access_token: token, refresh_token: "rt", expires_in: issued.length === 1 ? 1 : 3600 }));
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ auth: req.headers.authorization }));
  });
  const url = await listen(authServer);
  const t = await makeApp({
    crm: `id: crm
name: CRM
kind: http
baseUrl: ${url}
auth: { type: oauth2_authorization_code, authorizeUrl: ${url}/authorize, tokenUrl: ${url}/token, clientId: byoi, scopes: [read] }
operations: [{ name: me, description: Vem är jag, path: /me }]
`,
  });
  try {
    assert.equal(status(t.app, "crm")?.needsLogin, true);
    const loginUrl = new URL(t.app.auth.startLogin("crm", status(t.app, "crm")!.manifest!.kind === "http" ? (status(t.app, "crm")!.manifest as any).auth : null, "http://byoi/oauth/callback"));
    assert.equal(loginUrl.searchParams.get("code_challenge_method"), "S256");
    await t.app.auth.finishLogin(loginUrl.searchParams.get("state")!, "code-abc");
    await t.app.reload();
    assert.equal(status(t.app, "crm")?.status, "ready");
    await wait(1100); // first token expires after 1s → refresh
    const me = await t.app.registry.call("crm__me", {});
    assert.match(me.text, /Bearer at-2/);
    assert.deepEqual(issued, ["authorization_code:pkce", "refresh_token:"]);
  } finally {
    await t.cleanup();
    authServer.close();
  }
});

test("service-account JWT and AWS SigV4 are signed correctly", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let seenAssertion = "";
  let seenAws = "";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      seenAssertion = new URLSearchParams(body).get("assertion")!;
      return res.end(JSON.stringify({ access_token: "sa-token", expires_in: 3600 }));
    }
    if (req.url?.startsWith("/aws")) seenAws = String(req.headers.authorization);
    res.end(JSON.stringify({ auth: req.headers.authorization }));
  });
  const url = await listen(server);
  const t = await makeApp({
    gsa: `id: gsa\nname: SA\nkind: http\nbaseUrl: ${url}\nauth: { type: oauth2_jwt_bearer, tokenUrl: ${url}/token, issuer: bot@proj.iam, privateKey: GSA_KEY, scope: read }\noperations: [{ name: me, description: x, path: /me }]\n`,
    s3: `id: s3\nname: S3\nkind: http\nbaseUrl: ${url}/aws\nauth: { type: aws_sigv4, service: s3, region: eu-north-1, accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET }\noperations: [{ name: list, description: x, path: /bucket }]\n`,
  });
  t.app.secrets.set("GSA_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  t.app.secrets.set("AWS_ID", "AKIDEXAMPLE");
  t.app.secrets.set("AWS_SECRET", "wJalrXUtnFEMI");
  await t.app.reload();
  try {
    assert.match((await t.app.registry.call("gsa__me", {})).text, /Bearer sa-token/);
    const [h, p, sig] = seenAssertion.split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
    assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).iss, "bot@proj.iam");
    await t.app.registry.call("s3__list", {});
    assert.match(seenAws, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/s3\/aws4_request/);
  } finally {
    await t.cleanup();
    server.close();
  }
});

test("browser (RPA): snapshot, domain lock, click with approval flag", { skip: !fs.existsSync("/opt/pw-browsers/chromium") && !process.env.BYOI_CHROMIUM_PATH }, async () => {
  process.env.BYOI_CHROMIUM_PATH ??= "/opt/pw-browsers/chromium";
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/done") return res.end("<h1>Beställning skickad</h1>");
    res.end(`<h1>Gammalt affärssystem</h1><p>Saldo: 4 711 kr</p><a href="/done">Skicka beställning</a>`);
  });
  const url = await listen(server);
  const t = await makeApp({ legacy: `id: legacy\nname: Legacy\nkind: browser\nstartUrl: ${url}/\n` });
  try {
    assert.ok(t.app.registry.get("legacy__click")!.confirm);
    const snap = await t.app.registry.call("legacy__snapshot", {});
    assert.match(snap.text, /Saldo: 4 711 kr/);
    const blocked = await t.app.registry.call("legacy__open", { url: "https://example.com/" });
    assert.ok(blocked.isError);
    const clicked = await t.app.registry.call("legacy__click", { role: "link", name: "Skicka beställning" });
    assert.match(clicked.text, /Beställning skickad/);
    const shot = await t.app.registry.call("legacy__screenshot", {});
    assert.equal(shot.images?.[0].mediaType, "image/png");
  } finally {
    await t.cleanup();
    server.close();
  }
});
