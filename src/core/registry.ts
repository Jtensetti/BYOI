// Capability registry: the single list of tools the rest of the product sees.
// Tools from every integration get a namespace: "<integration>__<tool>".
import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchema, ToolOutput } from "../input/adapters/types.ts";
import type { LoadedIntegration } from "../input/loader.ts";

export interface RegisteredTool {
  /** Globally unique, API-safe name. */
  name: string;
  integrationId: string;
  localName: string;
  description: string;
  inputSchema: JsonSchema;
  confirm: boolean;
  validate: ValidateFunction;
  run(input: Record<string, unknown>): Promise<ToolOutput>;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(input: Record<string, unknown>): Promise<ToolOutput>;
}

const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });

function safeName(integrationId: string, tool: string): string {
  const name = `${integrationId}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.slice(0, 64);
}

function compile(schema: JsonSchema): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch {
    // Some third-party schemas use features Ajv rejects; accept any object then.
    return ajv.compile({ type: "object" });
  }
}

export class Registry {
  private tools = new Map<string, RegisteredTool>();
  integrations: LoadedIntegration[] = [];

  constructor(private builtins: BuiltinTool[] = []) {}

  async setIntegrations(list: LoadedIntegration[]): Promise<void> {
    const old = this.integrations;
    this.integrations = list;
    this.tools.clear();

    for (const b of this.builtins) {
      this.tools.set(b.name, {
        ...b,
        integrationId: "byoi",
        localName: b.name,
        confirm: false,
        validate: compile(b.inputSchema),
      });
    }
    for (const integration of list) {
      if (integration.status !== "ready" || !integration.adapter) continue;
      const adapter = integration.adapter;
      const excluded = new Set(integration.manifest?.exclude ?? []);
      for (const t of adapter.listTools()) {
        if (excluded.has(t.name)) continue;
        const name = safeName(integration.id, t.name);
        if (this.tools.has(name)) continue; // first one wins on collision
        const inputSchema: JsonSchema = { ...t.inputSchema, type: "object" };
        this.tools.set(name, {
          name,
          integrationId: integration.id,
          localName: t.name,
          description: `[${integration.name}] ${t.description}`,
          inputSchema,
          confirm: Boolean(t.confirm),
          validate: compile(inputSchema),
          run: (input) => adapter.callTool(t.name, input),
        });
      }
    }

    // Close adapters that were replaced by this reload.
    for (const prev of old) {
      if (prev.adapter && !list.some((n) => n.adapter === prev.adapter)) {
        await prev.adapter.close().catch(() => {});
      }
    }
  }

  /** Sorted, so the tool list is byte-stable (keeps the prompt cache warm). */
  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Validates input against the tool's schema, then runs it. Never throws. */
  async call(name: string, input: unknown): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) return { text: `Okänt verktyg: ${name}`, isError: true };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { text: "Indata måste vara ett JSON-objekt", isError: true };
    }
    if (!tool.validate(input)) {
      return { text: `Ogiltig indata: ${ajv.errorsText(tool.validate.errors)}`, isError: true };
    }
    try {
      return await tool.run(input as Record<string, unknown>);
    } catch (err) {
      return { text: `Fel: ${(err as Error).message}`, isError: true };
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.integrations.map((i) => i.adapter?.close().catch(() => {})));
  }
}
