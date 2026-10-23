import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../src/app.ts";
import type { AgentEvent, LlmClient } from "../src/core/agent.ts";
import { createServer } from "../src/output/server.ts";

// A scripted stand-in for Claude: returns one canned message per call.
function fakeClaude(script: any[], calls: any[]): LlmClient {
  return {
    beta: {
      messages: {
        stream(params: any) {
          calls.push(structuredClone(params));
          const message = script.shift();
          const events = message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: b.text } }));
          return {
            async *[Symbol.asyncIterator]() { yield* events; },
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as LlmClient;
}

// Inside the project so integrations can resolve node_modules.
const tmp = fs.mkdtempSync(path.resolve("test/.tmp-"));
const integrationsDir = path.join(tmp, "integrations");
const calls: any[] = [];
const script: any[] = [];
let app: App;

before(async () => {
  fs.mkdirSync(integrationsDir);
  fs.cpSync("integrations/src", path.join(integrationsDir, "src"), { recursive: true });
  fs.copyFileSync("integrations/notes.yaml", path.join(integrationsDir, "notes.yaml"));
  fs.copyFileSync("integrations/clock.yaml", path.join(integrationsDir, "clock.yaml"));
  fs.copyFileSync("integrations/petstore.yaml", path.join(integrationsDir, "petstore.yaml"));
  // notes.ts imports ../../src/..., so point it at the real source tree.
  fs.symlinkSync(path.resolve("src"), path.join(tmp, "src"));
  fs.writeFileSync(path.join(integrationsDir, "secured.yaml"),
    "id: secured\nname: Secured\nkind: http\nbaseUrl: https://example.com\nauth: { type: bearer, secret: BYOI_TEST_TOKEN_XYZ }\noperations:\n  - { name: ping, description: Ping, path: /ping }\n");
  fs.writeFileSync(path.join(integrationsDir, "broken.yaml"), "id: Broken Id\nkind: http\n");
  app = await createApp({ integrationsDir, skillsDir: "skills", secretsFile: path.join(tmp, "secrets.json"), llmClient: fakeClaude(script, calls) });
});

after(async () => {
  await app.registry.closeAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("input: each manifest gets a status, one bad file doesn't stop the rest", () => {
  const status = Object.fromEntries(app.registry.integrations.map((i) => [i.id, i.status]));
  assert.equal(status.notes, "ready");
  assert.equal(status.clock, "ready");
  assert.equal(status.petstore, "ready");
  assert.equal(status.secured, "needs_auth");
  assert.equal(status.broken, "error");
  assert.deepEqual(app.registry.integrations.find((i) => i.id === "secured")!.missingSecrets, ["BYOI_TEST_TOKEN_XYZ"]);
});

test("input: OpenAPI spec becomes tools with merged body schema", () => {
  const add = app.registry.get("petstore__addPet")!;
  assert.ok(add.confirm, "POST should require approval");
  assert.deepEqual(add.inputSchema.required, ["name"]);
  assert.equal(app.registry.get("petstore__getPetById")!.confirm, false);
});

test("core: registry validates input before running a tool", async () => {
  const bad = await app.registry.call("petstore__getPetById", {});
  assert.ok(bad.isError);
  assert.match(bad.text, /petId/);
  const clock = await app.registry.call("clock__now", { timezone: "UTC" });
  assert.ok(!clock.isError);
  assert.match(clock.text, /^UTC:/);
});

test("core: adding a secret moves an integration from needs_auth to ready", async () => {
  app.secrets.set("BYOI_TEST_TOKEN_XYZ", "abc");
  await app.reload();
  assert.equal(app.registry.integrations.find((i) => i.id === "secured")!.status, "ready");
  assert.ok(app.registry.get("secured__ping"));
});

test("core: agent runs tools, waits for approval and returns results to Claude", async () => {
  script.push(
    { stop_reason: "tool_use", content: [
      { type: "text", text: "Jag sparar den." },
      { type: "tool_use", id: "tu_1", name: "notes__create", input: { title: "Test", text: "Hej" } },
    ] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Klart!" }] },
  );
  const events: AgentEvent[] = [];
  const run = app.agent.run("c1", "Spara en anteckning", (e) => {
    events.push(e);
    if (e.type === "approval_required") app.agent.approvals.resolve(e.id, true);
  });
  await run;

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["text", "tool_call", "approval_required", "tool_result", "text", "done"]);
  const second = calls.at(-1);
  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "tu_1");
  assert.match(toolResult.content, /"title": "Test"/);
  assert.ok(second.tools.some((t: any) => t.name === "notes__create" && t.eager_input_streaming));
  assert.match(second.system, /notes: Anteckningar/);
  assert.equal(app.agent.history("c1").length, 4);
});

test("core: a denied approval is reported to Claude as an error result", async () => {
  script.push(
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_2", name: "notes__create", input: { title: "X", text: "Y" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Okej." }] },
  );
  await app.agent.run("c2", "Spara", (e) => {
    if (e.type === "approval_required") app.agent.approvals.resolve(e.id, false);
  });
  const result = calls.at(-1).messages.at(-1).content[0];
  assert.equal(result.is_error, true);
});

test("output: HTTP API and MCP gateway expose the same tools", async () => {
  const server = createServer(app).listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const list = await (await fetch(`http://localhost:${port}/api/integrations`)).json();
    assert.ok(list.some((i: any) => i.id === "notes" && i.tools.length === 3));

    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), app.registry.list().map((t) => t.name).sort());
    const res: any = await mcp.callTool({ name: "notes__list", arguments: {} });
    assert.match(res.content[0].text, /Test/);
    await mcp.close();
  } finally {
    server.close();
  }
});
