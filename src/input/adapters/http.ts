// Declarative REST adapter: each operation in the manifest becomes a tool.
import type { AuthConfig, HttpOperation, HttpParam, Manifest } from "../manifest.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

const MAX_RESPONSE_CHARS = 60_000;

/** "rawBody" sends the value itself as the JSON body (non-object request bodies). */
export type ParamLocation = "query" | "path" | "header" | "body" | "rawBody";

export interface RequestSpec {
  baseUrl: string;
  method: string;
  path: string;
  /** Where each top-level input field goes. Unlisted fields go to the body. */
  locations: Record<string, ParamLocation>;
  headers: Record<string, string>;
  auth: AuthConfig;
}

/** Runs one HTTP call built from tool input. Shared by the http and openapi adapters. */
export async function executeRequest(
  spec: RequestSpec,
  input: Record<string, unknown>,
  ctx: AdapterContext,
): Promise<ToolOutput> {
  let path = spec.path;
  const query: [string, string][] = [];
  const headers = new Headers(spec.headers);
  const body: Record<string, unknown> = {};
  let rawBody: unknown;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const where = spec.locations[key] ?? "body";
    if (where === "path") {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else if (where === "query") {
      for (const v of Array.isArray(value) ? value : [value]) query.push([key, String(v)]);
    } else if (where === "header") {
      headers.set(key, String(value));
    } else if (where === "rawBody") {
      rawBody = value;
    } else {
      body[key] = value;
    }
  }

  const url = new URL(spec.baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of query) url.searchParams.append(k, v);
  await ctx.auth.apply(spec.auth, headers, url);

  const payload = rawBody !== undefined ? rawBody : Object.keys(body).length > 0 ? body : undefined;
  const hasBody = payload !== undefined && spec.method !== "GET";
  if (hasBody) headers.set("Content-Type", "application/json");
  headers.set("Accept", headers.get("Accept") ?? "application/json, text/plain;q=0.9, */*;q=0.5");

  const res = await fetch(url, {
    method: spec.method,
    headers,
    body: hasBody ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  let text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      // keep raw text
    }
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[svaret kortades: ${text.length} tecken totalt]`;
  }
  return { text: `HTTP ${res.status}\n${text}`, isError: !res.ok };
}

function paramToSchema(p: HttpParam): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: p.type };
  if (p.description) schema.description = p.description;
  if (p.enum) schema.enum = p.enum;
  if (p.items) schema.items = p.items;
  if (p.default !== undefined) schema.default = p.default;
  return schema;
}

function operationSchema(op: HttpOperation): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(op.params.map((p) => [p.name, paramToSchema(p)])),
    required: op.params.filter((p) => p.required || p.in === "path").map((p) => p.name),
  };
}

export class HttpAdapter implements Adapter {
  private ops = new Map<string, HttpOperation>();

  constructor(
    private manifest: Extract<Manifest, { kind: "http" }>,
    private ctx: AdapterContext,
  ) {
    for (const op of manifest.operations) this.ops.set(op.name, op);
  }

  async connect(): Promise<void> {}

  listTools(): ToolDef[] {
    return this.manifest.operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: operationSchema(op),
      confirm: op.confirm ?? op.method !== "GET",
    }));
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const op = this.ops.get(name);
    if (!op) return { text: `Okänd operation: ${name}`, isError: true };
    return executeRequest(
      {
        baseUrl: this.manifest.baseUrl,
        method: op.method,
        path: op.path,
        locations: Object.fromEntries(op.params.map((p) => [p.name, p.in])),
        headers: this.manifest.headers,
        auth: this.manifest.auth,
      },
      input,
      this.ctx,
    );
  }

  async close(): Promise<void> {}
}
