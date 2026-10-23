// HTTP surface: chat UI, chat API (SSE), integration management and /mcp.
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkInboundToken } from "../core/auth.ts";
import { handleMcpRequest } from "../core/mcp-gateway.ts";
import { ManifestSchema } from "../input/manifest.ts";
import type { App } from "../app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1_000_000;

// Integrations that run code on this machine can only be added as files, not via the API.
const API_ALLOWED = (m: { kind: string; transport?: { type: string } }) =>
  process.env.BYOI_ALLOW_CODE_INTEGRATIONS === "1" ||
  m.kind === "http" || m.kind === "openapi" || (m.kind === "mcp" && m.transport?.type === "http");

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "För stor request");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Ogiltig JSON");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function publicIntegration(i: App["registry"]["integrations"][number], app: App) {
  return {
    id: i.id,
    name: i.name,
    kind: i.kind,
    description: i.description,
    status: i.status,
    message: i.message,
    missingSecrets: i.missingSecrets,
    tools: app.registry.list().filter((t) => t.integrationId === i.id).map((t) => ({
      name: t.name,
      description: t.description,
      confirm: t.confirm,
    })),
  };
}

export function createServer(app: App): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /" || route === "GET /index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await fs.readFile(path.join(here, "public", "index.html")));
        return;
      }
      if (route === "GET /health") return json(res, 200, { ok: true });

      if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
        if (!checkInboundToken(req.headers.authorization)) throw new HttpError(401, "Saknar eller fel token");
      }

      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        return await handleMcpRequest(app.registry, req, res, body);
      }

      switch (route) {
        case "GET /api/integrations":
          return json(res, 200, app.registry.integrations.map((i) => publicIntegration(i, app)));

        case "POST /api/integrations": {
          // BYOI: send a manifest (YAML or JSON as text), we validate, save and connect it.
          const { manifest } = await readBody(req);
          if (typeof manifest !== "string") throw new HttpError(400, "Fältet 'manifest' (text) saknas");
          const parsed = ManifestSchema.safeParse(YAML.parse(manifest));
          if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          }
          if (!API_ALLOWED(parsed.data as any)) {
            throw new HttpError(403, "Integrationer som kör kod lokalt (module, mcp/stdio) läggs till som fil i integrations/.");
          }
          await fs.writeFile(path.join(app.integrationsDir, `${parsed.data.id}.yaml`), manifest);
          await app.reload();
          const loaded = app.registry.integrations.find((i) => i.id === parsed.data.id);
          return json(res, 201, loaded ? publicIntegration(loaded, app) : null);
        }

        case "POST /api/integrations/reload":
          await app.reload();
          return json(res, 200, app.registry.integrations.map((i) => publicIntegration(i, app)));

        case "POST /api/secrets": {
          const { name, value } = await readBody(req);
          if (!/^[A-Za-z0-9_]+$/.test(name ?? "") || typeof value !== "string" || !value) {
            throw new HttpError(400, "Ange name (A-Z, 0-9, _) och value");
          }
          app.secrets.set(name, value);
          await app.reload();
          return json(res, 200, { ok: true });
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
          const convId = typeof conversationId === "string" && conversationId ? conversationId : crypto.randomUUID();
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
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
}
