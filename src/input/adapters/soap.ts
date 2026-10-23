// SOAP adapter: read the WSDL; every operation becomes a tool.
import path from "node:path";
import * as soap from "soap";
import type { ManifestOf } from "../manifest.ts";
import { clip } from "./http.ts";
import type { Adapter, AdapterContext, ToolDef, ToolOutput } from "./types.ts";

const WRITE_VERBS = /^(create|update|delete|remove|set|add|put|insert|upsert|write|send|cancel|submit|register)/i;

function xsdToSchema(desc: unknown, depth = 0): Record<string, unknown> {
  if (typeof desc === "string") {
    const t = desc.split(":").pop()!.split("|")[0].toLowerCase();
    if (/^(int|integer|long|short|byte|unsigned|nonnegativeinteger|positiveinteger)/.test(t)) return { type: "integer" };
    if (/^(decimal|double|float)/.test(t)) return { type: "number" };
    if (t === "boolean") return { type: "boolean" };
    return { type: "string", description: t !== "string" ? `xsd:${t}` : undefined };
  }
  if (!desc || typeof desc !== "object" || depth > 6) return {};
  const properties: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(desc as Record<string, unknown>)) {
    if (rawKey.startsWith("targetNS") || rawKey === "targetNamespace") continue;
    const isArray = rawKey.endsWith("[]");
    const key = rawKey.replace(/\[\]$/, "").split("|")[0];
    const schema = xsdToSchema(value, depth + 1);
    properties[key] = isArray ? { type: "array", items: schema } : schema;
  }
  return { type: "object", properties };
}

export class SoapAdapter implements Adapter {
  private client!: soap.Client;
  private tools: ToolDef[] = [];
  private ops = new Map<string, string>(); // tool name -> "Service.Port.Operation"

  constructor(private manifest: ManifestOf<"soap">, private ctx: AdapterContext) {}

  async connect(): Promise<void> {
    const wsdl = /^https?:/.test(this.manifest.wsdl) ? this.manifest.wsdl : path.resolve(this.ctx.baseDir, this.manifest.wsdl);
    this.client = await soap.createClientAsync(wsdl, {}, this.manifest.endpoint);
    await this.applyAuth();

    const description = this.client.describe() as Record<string, Record<string, Record<string, { input: unknown }>>>;
    const multiPort = Object.values(description).reduce((n, ports) => n + Object.keys(ports).length, 0) > 1;
    for (const [service, ports] of Object.entries(description)) {
      for (const [port, operations] of Object.entries(ports)) {
        for (const [op, spec] of Object.entries(operations)) {
          const name = (multiPort ? `${port}_${op}` : op).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
          if (this.ops.has(name)) continue;
          this.ops.set(name, `${service}.${port}.${op}`);
          const readOnlyListed = this.manifest.readOnly?.includes(op);
          this.tools.push({
            name,
            description: `SOAP ${service}/${port}/${op}`,
            inputSchema: { ...(xsdToSchema(spec.input) as object), type: "object" },
            confirm: this.manifest.confirm.includes(op) || (this.manifest.readOnly ? !readOnlyListed : WRITE_VERBS.test(op)),
          });
        }
      }
    }
  }

  private async applyAuth(): Promise<void> {
    const auth = this.manifest.auth;
    const s = (n: string) => this.ctx.secrets.get(n);
    if (auth.type === "basic") this.client.setSecurity(new soap.BasicAuthSecurity(auth.username, s(auth.secret)));
    else if (auth.type === "bearer") this.client.setSecurity(new soap.BearerSecurity(s(auth.secret)));
    else if (auth.type === "api_key" && auth.in === "header") this.client.addHttpHeader(auth.name, auth.prefix + s(auth.secret));
    else if (auth.type.startsWith("oauth2")) {
      this.client.setSecurity(new soap.BearerSecurity(await this.ctx.auth.accessToken(auth, this.ctx.integrationId)));
    } else if (auth.type !== "none") throw new Error(`Auth-typen ${auth.type} stöds inte för SOAP`);
    if (this.manifest.wsSecurity) {
      const { username, secret, digest } = this.manifest.wsSecurity;
      this.client.setSecurity(new soap.WSSecurity(username, s(secret), { passwordType: digest ? "PasswordDigest" : "PasswordText" }));
    }
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const target = this.ops.get(name);
    if (!target) return { text: `Okänd operation: ${name}`, isError: true };
    const [service, port, op] = target.split(".");
    if (this.manifest.auth.type.startsWith("oauth2")) await this.applyAuth(); // refresh token
    const method = (this.client as any)[service]?.[port]?.[op] as Function | undefined;
    if (!method) return { text: `Operationen saknas i klienten: ${target}`, isError: true };
    try {
      const result = await new Promise((resolve, reject) => method.call(this.client, input, (err: any, res: unknown) => (err ? reject(err) : resolve(res))));
      return { text: clip(JSON.stringify(result, null, 1)) };
    } catch (err: any) {
      const fault = err?.root?.Envelope?.Body?.Fault;
      return { text: `SOAP-fel: ${fault ? JSON.stringify(fault) : err.message}`, isError: true };
    }
  }

  async close(): Promise<void> {}
}
