// BYOI on-prem connector. Runs inside the customer's network, loads local
// integration manifests (any kind: SQL, SOAP, internal REST, files via MCP, …)
// and dials OUT to the BYOI hub. No inbound ports; secrets never leave this machine.
//
//   BYOI_HUB_URL=wss://byoi.example.com/connect \
//   BYOI_CONNECTOR_ID=acme-dc1 BYOI_CONNECTOR_TOKEN=... \
//   BYOI_INTEGRATIONS_DIR=./integrations npm run connector
import path from "node:path";
import WebSocket from "ws";
import { AuthApplier, SecretStore } from "../core/auth.ts";
import type { HubMessage } from "../core/connector-hub.ts";
import { EventBus } from "../core/events.ts";
import { Registry } from "../core/registry.ts";
import type { ToolDef } from "../input/adapters/types.ts";
import { loadIntegrations } from "../input/loader.ts";

export interface ConnectorOptions {
  hubUrl: string;
  connectorId: string;
  token: string;
  integrationsDir: string;
  secretsFile?: string;
  log?: (msg: string) => void;
}

export async function startConnector(opts: ConnectorOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[connector] ${m}`));
  const secrets = new SecretStore(opts.secretsFile);
  const auth = new AuthApplier(secrets);
  const events = new EventBus();
  const registry = new Registry();
  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = 1000;

  const tools = (): ToolDef[] =>
    registry.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, confirm: t.confirm }));
  const send = (msg: HubMessage) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  let timer: NodeJS.Timeout | undefined;
  const hub = { onChange: () => () => {}, tools: () => [], isOnline: () => false, call: async () => ({ text: "Nästlade connectorer stöds inte", isError: true }) } as any;
  await registry.setIntegrations(
    await loadIntegrations(path.resolve(opts.integrationsDir), {
      secrets,
      auth,
      events,
      hub,
      toolsChanged: () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await registry.rebuild();
          send({ type: "tools", tools: tools() });
        }, 50);
      },
    }),
  );
  for (const i of registry.integrations) log(`${i.status.padEnd(10)} ${i.id} (${i.kind})${i.message ? ` – ${i.message}` : ""}`);

  // Forward local events (on-prem webhooks, queues) to the hub.
  events.onEvent((e) => send({ type: "event", source: `${e.integrationId}${e.source.startsWith("/") ? "" : ":"}${e.source}`, payload: e.payload }));

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(opts.hubUrl);
    ws.on("open", () => {
      backoff = 1000;
      ws!.send(JSON.stringify({ type: "hello", connectorId: opts.connectorId, token: opts.token, tools: tools(), version: "0.2.0" } satisfies HubMessage));
    });
    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString()) as HubMessage;
      if (msg.type === "welcome") log(`ansluten till ${opts.hubUrl} med ${tools().length} verktyg`);
      if (msg.type === "call") {
        // The hub enforces approvals; we still validate input against the schema.
        const output = await registry.call(msg.tool, msg.input);
        send({ type: "result", id: msg.id, output });
      }
    });
    ws.on("close", (code, reason) => {
      if (stopped) return;
      log(`frånkopplad (${code} ${reason}), försöker igen om ${backoff / 1000}s`);
      if (code === 4401) log("hubben nekade token – kontrollera BYOI_CONNECTOR_TOKEN");
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
    ws.on("error", () => {}); // close follows
  };
  connect();

  return {
    registry,
    async stop() {
      stopped = true;
      ws?.close();
      await registry.closeAll();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`Sätt ${name}`);
    return v;
  };
  const c = await startConnector({
    hubUrl: env("BYOI_HUB_URL"),
    connectorId: env("BYOI_CONNECTOR_ID"),
    token: env("BYOI_CONNECTOR_TOKEN"),
    integrationsDir: process.env.BYOI_INTEGRATIONS_DIR ?? "integrations",
  });
  const stop = async () => {
    await c.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
