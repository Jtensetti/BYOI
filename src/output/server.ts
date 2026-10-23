// HTTP surface: chat UI, chat API (SSE), integration management, OAuth login,
// inbound webhooks (/hooks), on-prem connectors (/connect, WebSocket) and /mcp.
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstallError, type App } from "../app.ts";
import { checkInboundToken } from "../core/auth.ts";
import { generateIntegration } from "../core/generator.ts";
import { handleMcpRequest } from "../core/mcp-gateway.ts";
import { WebhookAdapter } from "../input/adapters/webhook.ts";
import type { LoadedIntegration } from "../input/loader.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 5_000_000;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "För stor request");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const text = (await readRaw(req)).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Ogiltig JSON");
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function publicUrl(req: IncomingMessage): string {
  if (process.env.BYOI_PUBLIC_URL) return process.env.BYOI_PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

function publicIntegration(i: LoadedIntegration, app: App) {
  return {
    id: i.id,
    name: i.name,
    kind: i.kind,
    description: i.description,
    status: i.status,
    message: i.adapter?.statusMessage?.() ?? i.message,
    missingSecrets: i.missingSecrets,
    needsLogin: Boolean(i.needsLogin),
    canLogout: i.manifest && "auth" in i.manifest && i.manifest.auth?.type === "oauth2_authorization_code" && app.auth.isLoggedIn(i.id),
    tools: app.registry.list().filter((t) => t.integrationId === i.id).map((t) => ({ name: t.name, description: t.description, confirm: t.confirm })),
  };
}

export function createServer(app: App): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /" || route === "GET /index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await fs.readFile(path.join(here, "public", "index.html")));
        return;
      }
      if (route === "GET /health") return json(res, 200, { ok: true });

      // Inbound webhooks: authenticated by each integration's own signature check.
      const hook = url.pathname.match(/^\/hooks\/([a-z0-9_-]+)(\/.*)?$/);
      if (hook && req.method === "POST") {
        const integration = app.registry.integrations.find((i) => i.id === hook[1]);
        if (!(integration?.adapter instanceof WebhookAdapter)) throw new HttpError(404, "Ingen webhook med det id:t");
        const result = integration.adapter.receive(req.headers, await readRaw(req), hook[2] ?? "");
        return json(res, result.status, { message: result.message });
      }

      // OAuth callback: protected by the unguessable one-time state.
      if (route === "GET /oauth/callback") {
        const error = url.searchParams.get("error");
        if (error) throw new HttpError(400, `Inloggningen avbröts: ${error}`);
        const id = await app.auth.finishLogin(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
        await app.reload();
        res.writeHead(302, { Location: `/?connected=${encodeURIComponent(id)}` });
        res.end();
        return;
      }

      if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
        if (!checkInboundToken(req.headers.authorization)) throw new HttpError(401, "Saknar eller fel token");
      }

      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        return await handleMcpRequest(app.registry, req, res, body);
      }

      const oauth = url.pathname.match(/^\/api\/oauth\/(start|logout)\/([a-z0-9_-]+)$/);
      if (oauth && req.method === "POST") {
        const integration = app.registry.integrations.find((i) => i.id === oauth[2]);
        if (!integration?.manifest || !("auth" in integration.manifest)) throw new HttpError(404, "Okänd integration");
        if (oauth[1] === "logout") {
          app.auth.logout(integration.id);
          await app.reload();
          return json(res, 200, { ok: true });
        }
        const loginUrl = app.auth.startLogin(integration.id, integration.manifest.auth!, `${publicUrl(req)}/oauth/callback`);
        return json(res, 200, { url: loginUrl });
      }

      const remove = url.pathname.match(/^\/api\/integrations\/([a-z0-9_-]+)$/);
      if (remove && req.method === "DELETE") {
        const integration = app.registry.integrations.find((i) => i.id === remove[1]);
        if (!integration) throw new HttpError(404, "Okänd integration");
        await fs.rm(integration.file);
        await app.reload();
        return json(res, 200, { ok: true });
      }

      switch (route) {
        case "GET /api/integrations":
          return json(res, 200, app.registry.integrations.map((i) => publicIntegration(i, app)));

        case "POST /api/integrations/generate": {
          // BYOI for anything: URL, connection string or free text → draft manifest.
          const { source, name } = await readBody(req);
          if (typeof source !== "string" || !source.trim()) throw new HttpError(400, "Ange source");
          try {
            const guide = app.skills.find((s) => s.name === "skapa-integration")?.body;
            return json(res, 200, await generateIntegration(source, { hint: name, guide }));
          } catch (err) {
            throw new HttpError(422, (err as Error).message);
          }
        }

        case "POST /api/integrations": {
          const { manifest } = await readBody(req);
          if (typeof manifest !== "string") throw new HttpError(400, "Fältet 'manifest' (text) saknas");
          try {
            return json(res, 201, publicIntegration(await app.install(manifest), app));
          } catch (err) {
            if (err instanceof InstallError) throw new HttpError(err.status, err.message);
            throw err;
          }
        }

        case "POST /api/integrations/reload":
          await app.reload();
          return json(res, 200, app.registry.integrations.map((i) => publicIntegration(i, app)));

        case "POST /api/secrets": {
          const { name, value } = await readBody(req);
          if (!/^[A-Za-z0-9_]+$/.test(name ?? "") || typeof value !== "string" || !value) throw new HttpError(400, "Ange name (A-Z, 0-9, _) och value");
          app.secrets.set(name, value);
          await app.reload();
          return json(res, 200, { ok: true });
        }

        case "GET /api/events": {
          const id = url.searchParams.get("integration") ?? "";
          return json(res, 200, app.events.recent(id, Number(url.searchParams.get("limit") ?? 20)));
        }

        case "GET /api/tools":
          return json(res, 200, app.registry.list().map(({ name, description, inputSchema, confirm }) => ({ name, description, inputSchema, confirm })));

        case "GET /api/skills":
          return json(res, 200, app.skills.map(({ name, description, integrations }) => ({ name, description, integrations })));

        case "POST /api/approve": {
          const { id, approved } = await readBody(req);
          const ok = app.agent.approvals.resolve(String(id), approved === true);
          return json(res, ok ? 200 : 404, { ok });
        }

        case "POST /api/chat": {
          const { conversationId, message } = await readBody(req);
          if (typeof message !== "string" || !message.trim()) throw new HttpError(400, "Tomt meddelande");
          const convId = typeof conversationId === "string" && conversationId && !conversationId.startsWith("auto-") ? conversationId : crypto.randomUUID();
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
          send({ type: "conversation", id: convId });
          await app.agent.run(convId, message, send);
          res.end();
          return;
        }
      }
      throw new HttpError(404, "Hittades inte");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
      else res.end();
    }
  });

  // On-prem connectors dial in here.
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/connect") app.hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  return server;
}
