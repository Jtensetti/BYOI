// GraphQL adapter: introspects the schema; each Query/Mutation root field becomes
// a tool with a generated selection set. A raw `graphql` tool covers the rest.
import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isScalarType,
  parse,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import type { ManifestOf } from "../manifest.ts";
import { clip } from "./http.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

const MAX_FIELD_TOOLS = 60; // past this, only the raw tool + schema search are exposed

function inputToJsonSchema(type: GraphQLInputType, depth = 0): Record<string, unknown> {
  if (isNonNullType(type)) return inputToJsonSchema(type.ofType, depth);
  if (isListType(type)) return { type: "array", items: inputToJsonSchema(type.ofType, depth) };
  if (isEnumType(type)) return { type: "string", enum: type.getValues().map((v) => v.name) };
  if (isInputObjectType(type)) {
    if (depth > 4) return { type: "object" };
    const fields = type.getFields();
    return {
      type: "object",
      description: type.description ?? undefined,
      properties: Object.fromEntries(Object.values(fields).map((f) => [f.name, { ...inputToJsonSchema(f.type, depth + 1), description: f.description ?? undefined }])),
      required: Object.values(fields).filter((f) => isNonNullType(f.type)).map((f) => f.name),
    };
  }
  switch (type.name) {
    case "Int":
      return { type: "integer" };
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "String":
    case "ID":
      return { type: "string" };
    default:
      return {}; // custom scalar: anything
  }
}

/** Builds a selection set: all scalar fields, plus nested objects down to `depth`. */
function selection(type: GraphQLOutputType, depth: number): string {
  const named = getNamedType(type);
  if (isScalarType(named) || isEnumType(named)) return "";
  if (isUnionType(named)) {
    const parts = named.getTypes().map((t) => `... on ${t.name} ${selection(t, depth) || "{ __typename }"}`);
    return `{ __typename ${parts.join(" ")} }`;
  }
  if (!isObjectType(named) && !isInterfaceType(named)) return "";
  const fields: string[] = [];
  for (const f of Object.values(named.getFields())) {
    if (f.args.some((a) => isNonNullType(a.type))) continue; // needs arguments we can't guess
    const inner = getNamedType(f.type);
    if (isScalarType(inner) || isEnumType(inner)) fields.push(f.name);
    else if (depth > 1) {
      const sub = selection(f.type, depth - 1);
      if (sub) fields.push(`${f.name} ${sub}`);
    }
  }
  return fields.length ? `{ ${fields.join(" ")} }` : "{ __typename }";
}

function printType(type: GraphQLInputType | GraphQLOutputType): string {
  return type.toString();
}

export class GraphqlAdapter implements Adapter {
  private schema!: GraphQLSchema;
  private tools: ToolDef[] = [];
  private fields = new Map<string, { op: "query" | "mutation"; field: GraphQLField<unknown, unknown> }>();

  constructor(private manifest: ManifestOf<"graphql">, private ctx: AdapterContext) {}

  private async request(query: string, variables?: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const headers = new Headers({ ...this.manifest.headers, "Content-Type": "application/json", Accept: "application/json" });
    const res = await this.ctx.auth.fetch(
      { auth: this.manifest.auth, tls: this.manifest.tls, integrationId: this.ctx.integrationId },
      new URL(this.manifest.endpoint),
      { method: "POST", headers, body: JSON.stringify({ query, variables }) },
    );
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      throw new Error(`Svaret var inte JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async connect(): Promise<void> {
    const { json } = await this.request(getIntrospectionQuery());
    if (!json.data) throw new Error(`Introspection misslyckades: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
    this.schema = buildClientSchema(json.data as IntrospectionQuery);

    const roots: ["query" | "mutation", ReturnType<GraphQLSchema["getQueryType"]>][] = [
      ["query", this.schema.getQueryType()],
      ["mutation", this.manifest.allowMutations ? this.schema.getMutationType() : null],
    ];
    const candidates: ToolDef[] = [];
    for (const [op, root] of roots) {
      if (!root) continue;
      for (const field of Object.values(root.getFields())) {
        const name = `${op === "query" ? "" : "mutate_"}${field.name}`;
        if (this.manifest.include && !this.manifest.include.includes(field.name)) continue;
        this.fields.set(name, { op, field });
        candidates.push({
          name,
          description: `${op === "mutation" ? "Mutation" : "Query"} ${field.name}: ${printType(field.type)}${field.description ? ` – ${field.description}` : ""}`.slice(0, 1000),
          inputSchema: {
            type: "object",
            properties: {
              ...Object.fromEntries(field.args.map((a) => [a.name, { ...inputToJsonSchema(a.type), description: a.description ?? undefined }])),
              _selection: { type: "string", description: "Valfri egen selection set, t.ex. \"{ id name }\". Standard: genereras automatiskt." },
            },
            required: field.args.filter((a) => isNonNullType(a.type) && a.defaultValue === undefined).map((a) => a.name),
          },
          confirm: op === "mutation",
        });
      }
    }

    const raw: ToolDef[] = [
      {
        name: "graphql",
        description: "Kör en egen GraphQL-query (inte mutation) med variabler.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, variables: { type: "object" } },
          required: ["query"],
        },
      },
      {
        name: "schema_search",
        description: "Söker i GraphQL-schemat efter typer och fält som matchar ett ord. Visar typdefinitionerna.",
        inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
      },
    ];
    this.tools = candidates.length <= MAX_FIELD_TOOLS || this.manifest.include ? [...candidates, ...raw] : raw;
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    if (name === "schema_search") return this.searchSchema(String(input.term ?? ""));
    if (name === "graphql") {
      const query = String(input.query ?? "");
      try {
        const doc = parse(query);
        if (doc.definitions.some((d) => d.kind === "OperationDefinition" && d.operation !== "query")) {
          return { text: "Det råa verktyget kör bara queries. Använd mutate_-verktygen för ändringar.", isError: true };
        }
      } catch (err) {
        return { text: `Ogiltig GraphQL: ${(err as Error).message}`, isError: true };
      }
      return this.run(query, input.variables as Record<string, unknown> | undefined);
    }

    const entry = this.fields.get(name);
    if (!entry) return { text: `Okänt fält: ${name}`, isError: true };
    const { op, field } = entry;
    const { _selection, ...args } = input;
    const used = field.args.filter((a) => args[a.name] !== undefined);
    const varDefs = used.map((a) => `$${a.name}: ${printType(a.type)}`).join(", ");
    const argList = used.map((a) => `${a.name}: $${a.name}`).join(", ");
    const sel = typeof _selection === "string" && _selection.trim() ? _selection : selection(field.type, this.manifest.selectionDepth);
    const query = `${op}${varDefs ? `(${varDefs})` : ""} { ${field.name}${argList ? `(${argList})` : ""} ${sel} }`;
    return this.run(query, args);
  }

  private async run(query: string, variables?: Record<string, unknown>): Promise<ToolOutput> {
    const { status, json } = await this.request(query, variables);
    const isError = status >= 400 || (Array.isArray(json.errors) && json.errors.length > 0 && !json.data);
    return { text: clip(JSON.stringify(json, null, 1)), isError };
  }

  private searchSchema(term: string): ToolOutput {
    const t = term.toLowerCase();
    const hits: string[] = [];
    for (const type of Object.values(this.schema.getTypeMap())) {
      if (type.name.startsWith("__")) continue;
      const fields = "getFields" in type ? Object.values((type as any).getFields()) as any[] : [];
      const matches = type.name.toLowerCase().includes(t) || fields.some((f) => f.name.toLowerCase().includes(t));
      if (!matches) continue;
      const body = fields.map((f) => `  ${f.name}${f.args?.length ? `(${f.args.map((a: any) => `${a.name}: ${a.type}`).join(", ")})` : ""}: ${f.type}`).join("\n");
      hits.push(`${type.constructor.name.replace("GraphQL", "").replace("Type", "")} ${type.name}${body ? ` {\n${body}\n}` : ""}`);
      if (hits.length >= 15) break;
    }
    return { text: hits.length ? clip(hits.join("\n\n")) : `Inget i schemat matchar "${term}".` };
  }

  async close(): Promise<void> {}
}
