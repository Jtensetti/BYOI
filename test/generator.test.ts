// "Bring anything": the generator recognises protocols itself and falls back to Claude.
// Also: conversations keep a frozen tool list and learn about new integrations by appending.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import YAML from "yaml";
import { generateIntegration } from "../src/core/generator.ts";
import { ManifestSchema } from "../src/input/manifest.ts";
import { createServer } from "../src/output/server.ts";
import { fakeClaude, fixtures, listen, makeApp } from "./helpers.ts";

let server: http.Server;
let base = "";

before(async () => {
  process.env.BYOI_ALLOW_PRIVATE_NETWORK = "1"; // the test servers run on localhost
  const spec = {
    openapi: "3.0.0",
    info: { title: "Lagerkoll", version: "1", description: "Lagersaldo och artiklar" },
    paths: { "/items": { get: { operationId: "listItems", responses: {} } } },
    components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  };
  const wsdl = fs.readFileSync(path.join(fixtures, "calculator.wsdl"), "utf8");
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = req.url ?? "/";
    if (u === "/graphql" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: { __typename: "Query" } }));
    }
    if (u === "/openapi.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(spec));
    }
    if (u === "/calc?wsdl") {
      res.setHeader("content-type", "text/xml");
      return res.end(wsdl);
    }
    if (u === "/docs") {
      res.setHeader("content-type", "text/html");
      return res.end("<html><body><h1>Väder-API</h1><p>GET https://vader.example/v1/now?city=Stockholm returnerar temperatur.</p><script>x()</script></body></html>");
    }
    res.statusCode = 404;
    res.end("nope");
  });
  base = await listen(server);
});

after(() => {
  delete process.env.BYOI_ALLOW_PRIVATE_NETWORK;
  server.close();
});

test("generator: finds an OpenAPI spec from just the site URL, maps its auth", async () => {
  const d = await generateIntegration(`${base}/`);
  const m = YAML.parse(d.manifest);
  assert.equal(m.kind, "openapi");
  assert.equal(m.spec, `${base}/openapi.json`);
  assert.equal(m.id, "lagerkoll");
  assert.deepEqual({ type: m.auth.type, name: m.auth.name }, { type: "api_key", name: "X-Api-Key" });
  assert.equal(d.secrets[0].name, "LAGERKOLL_API_KEY");
});

test("generator: recognises GraphQL, WSDL and MCP endpoints", async () => {
  assert.equal(YAML.parse((await generateIntegration(`${base}/graphql`)).manifest).kind, "graphql");
  assert.equal(YAML.parse((await generateIntegration(`${base}/calc?wsdl`)).manifest).kind, "soap");

  // Our own MCP gateway is a perfectly good MCP server to detect.
  const t = await makeApp({});
  const gw = createServer(t.app);
  const gwUrl = await listen(gw);
  try {
    const d = await generateIntegration(`${gwUrl}/mcp`);
    const m = YAML.parse(d.manifest);
    assert.equal(m.kind, "mcp");
    assert.equal(m.transport.url, `${gwUrl}/mcp`);
    assert.equal(m.name, "byoi-gateway");
  } finally {
    gw.close();
    await t.cleanup();
  }
});

test("generator: connection strings → sql/queue, password moved to a secret", async () => {
  const d = await generateIntegration("postgres://reader:hemligt@db.intern:5432/ekonomi");
  const m = YAML.parse(d.manifest);
  assert.equal(m.kind, "sql");
  assert.equal(m.driver, "postgres");
  assert.equal(m.allowWrite, false);
  assert.equal(m.connection, "postgres://reader:${secret:EKONOMI_PASSWORD}@db.intern:5432/ekonomi");
  assert.doesNotMatch(d.manifest, /hemligt/);

  const q = YAML.parse((await generateIntegration("amqp://guest@rabbit:5672")).manifest);
  assert.deepEqual([q.kind, q.driver], ["queue", "amqp"]);
});

test("generator: docs pages go to Claude; invalid output is fed back until valid", async () => {
  const requests: any[] = [];
  const replies = [
    { manifest_yaml: "id: Väder API\nkind: http", secrets: [], notes: [] }, // invalid
    {
      manifest_yaml: "id: vader\nname: Väder\nkind: http\nbaseUrl: https://vader.example/v1\noperations:\n  - { name: now, description: Aktuellt väder, path: /now, params: [{ name: city, required: true }] }\n",
      secrets: [],
      notes: ["Ingen auth hittades i dokumentationen."],
    },
  ];
  const anthropic = {
    messages: {
      parse: async (params: any) => {
        requests.push(params);
        const out = replies.shift()!;
        return { stop_reason: "end_turn", parsed_output: out, content: [{ type: "text", text: JSON.stringify(out) }] };
      },
    },
  } as any;
  // A site with docs but no machine-readable spec anywhere.
  const docs = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/docs") return void ((res.statusCode = 404), res.end());
    res.setHeader("content-type", "text/html");
    res.end("<html><body><h1>Väder-API</h1><p>GET https://vader.example/v1/now?city=Stockholm returnerar temperatur.</p><script>x()</script></body></html>");
  });
  const docsUrl = await listen(docs);
  const d = await generateIntegration(`${docsUrl}/docs`, { client: anthropic }).finally(() => docs.close());
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /GET https:\/\/vader\.example\/v1\/now/);
  assert.doesNotMatch(requests[0].messages[0].content, /x\(\)/, "scripts are stripped");
  assert.match(requests[1].messages.at(-1).content, /validerade inte/);
  assert.ok(ManifestSchema.safeParse(YAML.parse(d.manifest)).success);
  assert.deepEqual(d.notes, ["Ingen auth hittades i dokumentationen."]);
});

test("generator: internal addresses are refused unless explicitly allowed", async () => {
  delete process.env.BYOI_ALLOW_PRIVATE_NETWORK;
  try {
    await assert.rejects(generateIntegration(`${base}/openapi.json`), /internt nät/);
  } finally {
    process.env.BYOI_ALLOW_PRIVATE_NETWORK = "1";
  }
});

test("agent: tools are frozen per conversation; new integrations are appended and announced", async () => {
  const calls: any[] = [];
  const t = await makeApp({}, { llmClient: fakeClaude([], calls) });
  try {
    await t.app.agent.run("c", "hej", () => {});
    const first = calls[0].tools.map((x: any) => x.name);
    assert.deepEqual(first, ["tool_search_tool_bm25", "install_integration", "load_skill", "propose_integration"]);

    await t.app.install("id: kalle\nname: Kalle\nkind: http\nbaseUrl: https://k.se\noperations: [{ name: ping, description: Ping, path: /ping }]\n");
    await t.app.agent.run("c", "nu då?", () => {});
    const second = calls[1];
    assert.deepEqual(second.tools.slice(0, 4), calls[0].tools, "earlier definitions are unchanged");
    assert.deepEqual(second.tools.at(-1), { ...second.tools.at(-1), name: "kalle__ping", defer_loading: true });
    const announce = second.messages.at(-1);
    assert.equal(announce.role, "system");
    assert.deepEqual(announce.content, [{ type: "tool_addition", tool: { type: "tool_reference", name: "kalle__ping" } }]);

    fs.rmSync(path.join(t.integrationsDir, "kalle.yaml"));
    await t.app.reload();
    await t.app.agent.run("c", "och nu?", () => {});
    const third = calls[2];
    assert.ok(third.tools.some((x: any) => x.name === "kalle__ping"), "definition stays");
    assert.deepEqual(third.messages.at(-1).content, [{ type: "tool_removal", tool: { type: "tool_reference", name: "kalle__ping" } }]);
  } finally {
    await t.cleanup();
  }
});

test("agent: big catalogues start deferred behind tool search", async () => {
  const ops = Array.from({ length: 40 }, (_, i) => `  - { name: op${i}, description: Operation ${i}, path: /op${i} }`).join("\n");
  const calls: any[] = [];
  const t = await makeApp({ big: `id: big\nname: Stort API\nkind: http\nbaseUrl: https://big.example\noperations:\n${ops}\n` }, { llmClient: fakeClaude([], calls) });
  try {
    await t.app.agent.run("c", "hej", () => {});
    const tools = calls[0].tools;
    assert.equal(tools.filter((x: any) => x.name.startsWith("big__") && x.defer_loading).length, 40);
    assert.ok(tools.filter((x: any) => !x.defer_loading).length >= 2, "built-ins stay loaded");
  } finally {
    await t.cleanup();
  }
});
