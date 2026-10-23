// gRPC adapter: load .proto files; every RPC (unary and streaming) becomes a tool.
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ManifestOf } from "../manifest.ts";
import { clip } from "./http.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

const MAX_STREAM_MESSAGES = 100;
const WRITE_VERBS = /^(create|update|delete|remove|set|add|put|patch|insert|upsert|write|send|cancel|start|stop)/i;

type FieldDescriptor = { name: string; type: string; label: string; typeName?: string; jsonName?: string };
type MessageDescriptor = { name: string; field: FieldDescriptor[] };

const SCALARS: Record<string, Record<string, unknown>> = {
  TYPE_DOUBLE: { type: "number" },
  TYPE_FLOAT: { type: "number" },
  TYPE_INT64: { type: "string", description: "64-bitars heltal" },
  TYPE_UINT64: { type: "string", description: "64-bitars heltal" },
  TYPE_SINT64: { type: "string" },
  TYPE_FIXED64: { type: "string" },
  TYPE_SFIXED64: { type: "string" },
  TYPE_INT32: { type: "integer" },
  TYPE_UINT32: { type: "integer" },
  TYPE_SINT32: { type: "integer" },
  TYPE_FIXED32: { type: "integer" },
  TYPE_SFIXED32: { type: "integer" },
  TYPE_BOOL: { type: "boolean" },
  TYPE_STRING: { type: "string" },
  TYPE_BYTES: { type: "string", description: "base64" },
};

export class GrpcAdapter implements Adapter {
  private tools: ToolDef[] = [];
  private methods = new Map<string, { client: grpc.Client; method: string; def: protoLoader.MethodDefinition<object, object> }>();
  private clients: grpc.Client[] = [];
  private def!: protoLoader.PackageDefinition;

  constructor(private manifest: ManifestOf<"grpc">, private ctx: AdapterContext) {}

  private messageSchema(typeName: string, depth = 0): Record<string, unknown> {
    const entry = this.def[typeName.replace(/^\./, "")] as any;
    if (!entry?.type) return { type: "object" };
    if (entry.format?.includes("EnumDescriptorProto")) return { type: "string", enum: entry.type.value.map((v: any) => v.name) };
    if (depth > 5) return { type: "object" };
    const msg = entry.type as MessageDescriptor;
    const properties: Record<string, unknown> = {};
    for (const f of msg.field) {
      let schema: Record<string, unknown> =
        f.type === "TYPE_MESSAGE" || f.type === "TYPE_ENUM" ? this.messageSchema(this.resolveRef(f.typeName ?? "", typeName), depth + 1) : (SCALARS[f.type] ?? {});
      if (f.label === "LABEL_REPEATED") schema = { type: "array", items: schema };
      properties[f.name] = schema;
    }
    return { type: "object", properties };
  }

  /** Resolves a field's type reference (absolute ".pkg.T" or relative "T") from inside `fromType`. */
  private resolveRef(ref: string, fromType: string): string {
    if (ref.startsWith(".")) return ref.slice(1);
    const scope = fromType.replace(/^\./, "").split(".");
    for (let i = scope.length; i >= 0; i--) {
      const candidate = [...scope.slice(0, i), ref].join(".");
      if (this.def[candidate]) return candidate;
    }
    return ref;
  }

  /** Full name of a message type, preferring the service's own package. */
  private findType(shortName: string, serviceName: string): string {
    const pkg = serviceName.split(".").slice(0, -1).join(".");
    const preferred = pkg ? `${pkg}.${shortName}` : shortName;
    if (this.def[preferred]) return preferred;
    return Object.keys(this.def).find((k) => k === shortName || k.endsWith(`.${shortName}`)) ?? shortName;
  }

  async connect(): Promise<void> {
    this.def = await protoLoader.load(
      this.manifest.protoFiles.map((f) => path.resolve(this.ctx.baseDir, f)),
      {
        includeDirs: this.manifest.includeDirs.map((d) => path.resolve(this.ctx.baseDir, d)),
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      },
    );
    const creds = this.manifest.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();

    for (const [serviceName, service] of Object.entries(this.def)) {
      if ((service as any).format) continue; // a message/enum, not a service
      const Ctor = grpc.makeGenericClientConstructor(service as grpc.ServiceDefinition, serviceName);
      const client = new Ctor(this.manifest.address, creds);
      this.clients.push(client);
      const shortService = serviceName.split(".").at(-1)!;

      for (const [methodName, m] of Object.entries(service as Record<string, protoLoader.MethodDefinition<object, object>>)) {
        const toolName = `${shortService}_${methodName}`.slice(0, 48);
        const reqSchema = this.messageSchema(this.findType((m.requestType as any).type?.name ?? "", serviceName));
        const inputSchema: JsonSchema = m.requestStream
          ? { type: "object", properties: { messages: { type: "array", items: reqSchema, description: "Meddelanden som strömmas till servern" } }, required: ["messages"] }
          : { ...(reqSchema as JsonSchema), type: "object" };
        const kind = m.requestStream && m.responseStream ? "bidi-stream" : m.requestStream ? "client-stream" : m.responseStream ? "server-stream" : "unary";
        this.tools.push({
          name: toolName,
          description: `gRPC ${serviceName}/${methodName} (${kind})`,
          inputSchema,
          confirm: this.manifest.confirm.includes(`${shortService}/${methodName}`) || WRITE_VERBS.test(methodName),
        });
        this.methods.set(toolName, { client, method: methodName, def: m });
      }
    }
    if (!this.tools.length) throw new Error("Hittade inga tjänster i proto-filerna");
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const entry = this.methods.get(name);
    if (!entry) return { text: `Okänd metod: ${name}`, isError: true };
    const { client, method, def } = entry;
    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries(this.manifest.metadata)) metadata.set(k, v);
    const deadline = new Date(Date.now() + 30_000);
    const fn = (client as any)[method].bind(client);
    const messages = def.requestStream ? ((input.messages as object[]) ?? []) : [input];

    return new Promise<ToolOutput>((resolve) => {
      const done = (err: grpc.ServiceError | null, payload?: unknown) =>
        resolve(err ? { text: `gRPC-fel ${err.code} (${grpc.status[err.code]}): ${err.details}`, isError: true } : { text: clip(JSON.stringify(payload, null, 1)) });

      if (!def.responseStream) {
        if (!def.requestStream) return fn(input, metadata, { deadline }, done);
        const call = fn(metadata, { deadline }, done);
        for (const m of messages) call.write(m);
        call.end();
        return;
      }
      const out: unknown[] = [];
      const call = def.requestStream ? fn(metadata, { deadline }) : fn(input, metadata, { deadline });
      call.on("data", (d: unknown) => {
        out.push(d);
        if (out.length >= MAX_STREAM_MESSAGES) call.cancel();
      });
      call.on("end", () => done(null, out));
      call.on("error", (err: grpc.ServiceError) => (err.code === grpc.status.CANCELLED ? done(null, out) : done(err)));
      if (def.requestStream) {
        for (const m of messages) call.write(m);
        call.end();
      }
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.close();
  }
}
