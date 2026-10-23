// Declarative REST adapter: each operation in the manifest becomes a tool.
import type { AuthConfig, HttpOperation, HttpParam, ManifestOf, TlsConfig } from "../manifest.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

export const MAX_RESPONSE_CHARS = 60_000;

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
  tls?: TlsConfig;
}

export function clip(text: string): string {
  return text.length > MAX_RESPONSE_CHARS
    ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[svaret kortades: ${text.length} tecken totalt]`
    : text;
}

/** Turns a fetch Response into tool output (pretty JSON when possible). */
export async function responseToOutput(res: Response): Promise<ToolOutput> {
  const type = res.headers.get("content-type") ?? "";
  if (/^image\/(png|jpeg)/.test(type)) {
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { text: `HTTP ${res.status} (${type})`, images: [{ mediaType: type.startsWith("image/png") ? "image/png" : "image/jpeg", data }], isError: !res.ok };
  }
  let text = await res.text();
  if (type.includes("json")) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      // keep raw text
    }
  }
  return { text: `HTTP ${res.status}\n${clip(text)}`, isError: !res.ok };
}

/** Runs one HTTP call built from tool input. Shared by the http and openapi adapters. */
export async function executeRequest(spec: RequestSpec, input: Record<string, unknown>, ctx: AdapterContext): Promise<ToolOutput> {
  let path = spec.path;
  const query: [string, string][] = [];
  const headers = new Headers(spec.headers);
  const body: Record<string, unknown> = {};
  let rawBody: unknown;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const where = spec.locations[key] ?? "body";
    if (where === "path") path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    else if (where === "query") for (const v of Array.isArray(value) ? value : [value]) query.push([key, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    else if (where === "header") headers.set(key, String(value));
    else if (where === "rawBody") rawBody = value;
    else body[key] = value;
  }

  const url = new URL(spec.baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of query) url.searchParams.append(k, v);

  const payload = rawBody !== undefined ? rawBody : Object.keys(body).length > 0 ? body : undefined;
  const hasBody = payload !== undefined && !["GET", "HEAD"].includes(spec.method);
  if (hasBody) headers.set("Content-Type", "application/json");
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain;q=0.9, */*;q=0.5");

  const res = await ctx.auth.fetch(
    { auth: spec.auth, tls: spec.tls, integrationId: ctx.integrationId },
    url,
    { method: spec.method, headers, body: hasBody ? JSON.stringify(payload) : undefined },
  );
  return responseToOutput(res);
}

function paramToSchema(p: Omit<HttpParam, "in">): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: p.type };
  if (p.description) schema.description = p.description;
  if (p.enum) schema.enum = p.enum;
  if (p.items) schema.items = p.items;
  else if (p.type === "array") schema.items = {};
  if (p.default !== undefined) schema.default = p.default;
  return schema;
}

export function paramsSchema(params: (Omit<HttpParam, "in"> & { in?: string })[]): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, paramToSchema(p)])),
    required: params.filter((p) => p.required || p.in === "path").map((p) => p.name),
  };
}

export class HttpAdapter implements Adapter {
  private ops = new Map<string, HttpOperation>();

  constructor(private manifest: ManifestOf<"http">, private ctx: AdapterContext) {
    for (const op of manifest.operations) this.ops.set(op.name, op);
  }

  async connect(): Promise<void> {}

  listTools(): ToolDef[] {
    return this.manifest.operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: paramsSchema(op.params),
      confirm: op.confirm ?? !["GET", "HEAD"].includes(op.method),
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
        tls: this.manifest.tls,
      },
      input,
      this.ctx,
    );
  }

  async close(): Promise<void> {}
}
