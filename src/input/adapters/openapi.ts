// OpenAPI adapter: point it at a spec and every operation becomes a tool.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ManifestOf } from "../manifest.ts";
import { executeRequest, type ParamLocation, type RequestSpec } from "./http.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

type Spec = Record<string, any>;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

async function loadSpec(source: string, baseDir: string): Promise<Spec> {
  const raw = /^https?:\/\//.test(source)
    ? await (await fetch(source, { signal: AbortSignal.timeout(30_000) })).text()
    : await fs.readFile(path.resolve(baseDir, source), "utf8");
  return YAML.parse(raw); // YAML is a superset of JSON
}

/** Inlines local "#/..." references. Cycles are cut after a few levels. */
function deref(node: unknown, spec: Spec, depth = 0): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, spec, depth));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
    if (depth > 6) return { type: "object", description: "(rekursiv struktur)" };
    const target = obj.$ref
      .slice(2)
      .split("/")
      .reduce<any>((acc, key) => acc?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return deref(target, spec, depth + 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deref(v, spec, depth)]));
}

function toolName(method: string, route: string, operationId?: string): string {
  const base = operationId ?? `${method}_${route}`;
  return base.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

export class OpenApiAdapter implements Adapter {
  private tools: ToolDef[] = [];
  private requests = new Map<string, RequestSpec>();

  constructor(
    private manifest: ManifestOf<"openapi">,
    private ctx: AdapterContext,
  ) {}

  async connect(): Promise<void> {
    const spec = await loadSpec(this.manifest.spec, this.ctx.baseDir);
    const swagger2 = spec.swagger && spec.host ? `${(spec.schemes ?? ["https"])[0]}://${spec.host}${spec.basePath ?? ""}` : undefined;
    let baseUrl: string | undefined = this.manifest.baseUrl ?? spec.servers?.[0]?.url ?? swagger2;
    // Relative server URLs ("/api/v3") are relative to where the spec came from.
    if (baseUrl && !/^https?:/.test(baseUrl) && /^https?:/.test(this.manifest.spec)) baseUrl = new URL(baseUrl, this.manifest.spec).toString();
    if (!baseUrl) throw new Error("Ingen baseUrl: ange den i manifestet eller i specens servers[]");

    for (const [route, item] of Object.entries<Spec>(spec.paths ?? {})) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const name = toolName(method, route, op.operationId);
        if (this.manifest.include && !this.manifest.include.includes(name)) continue;

        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        const locations: Record<string, ParamLocation> = {};

        const params = deref([...(item.parameters ?? []), ...(op.parameters ?? [])], spec);
        for (const p of params) {
          if (p.in === "body" && p.schema) {
            // Swagger 2.0 body parameter
            op.requestBody ??= { required: p.required, content: { "application/json": { schema: p.schema } } };
            continue;
          }
          if (!["query", "path", "header"].includes(p.in)) continue;
          properties[p.name] = { ...(p.schema ?? { type: p.type ?? "string" }), description: p.description };
          locations[p.name] = p.in;
          if (p.required || p.in === "path") required.push(p.name);
        }

        const bodySchema = deref(op.requestBody?.content?.["application/json"]?.schema, spec);
        if (bodySchema) {
          if (bodySchema.type === "object" || bodySchema.properties) {
            for (const [k, v] of Object.entries(bodySchema.properties ?? {})) {
              if (k in properties) continue; // a path/query param wins on name clash
              properties[k] = v;
              locations[k] = "body";
            }
            for (const r of bodySchema.required ?? []) if (!required.includes(r)) required.push(r);
          } else {
            properties.body = bodySchema;
            locations.body = "rawBody";
            if (op.requestBody?.required) required.push("body");
          }
        }

        const description = [op.summary, op.description].filter(Boolean).join("\n\n") ||
          `${method.toUpperCase()} ${route}`;
        const inputSchema: JsonSchema = { type: "object", properties, required };

        this.tools.push({
          name,
          description: description.slice(0, 1000),
          inputSchema,
          confirm: this.manifest.confirmMethods.includes(method.toUpperCase()),
        });
        this.requests.set(name, {
          baseUrl,
          method: method.toUpperCase(),
          path: route,
          locations,
          headers: this.manifest.headers,
          auth: this.manifest.auth,
          tls: this.manifest.tls,
        });
      }
    }
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const spec = this.requests.get(name);
    if (!spec) return { text: `Okänd operation: ${name}`, isError: true };
    return executeRequest(spec, input, this.ctx);
  }

  async close(): Promise<void> {}
}
