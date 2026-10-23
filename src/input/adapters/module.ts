// Module adapter: the escape hatch. Any integration you can write in a few
// lines of TypeScript (SDKs, databases, queues, legacy systems) plugs in here.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest } from "../manifest.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

export interface ModuleTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  confirm?: boolean;
  run(
    input: Record<string, unknown>,
    ctx: { config: Record<string, unknown>; secret(name: string): string },
  ): Promise<unknown> | unknown;
}

export interface IntegrationModule {
  tools: ModuleTool[];
  connect?(config: Record<string, unknown>): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** Helper for authors of module integrations (gives type checking). */
export function defineIntegration(mod: IntegrationModule): IntegrationModule {
  return mod;
}

export class ModuleAdapter implements Adapter {
  private mod!: IntegrationModule;

  constructor(
    private manifest: Extract<Manifest, { kind: "module" }>,
    private ctx: AdapterContext,
  ) {}

  async connect(): Promise<void> {
    const file = pathToFileURL(path.resolve(this.ctx.baseDir, this.manifest.module)).href;
    const loaded = await import(file);
    this.mod = loaded.default ?? loaded;
    if (!Array.isArray(this.mod.tools)) throw new Error("Modulen exporterar inga tools");
    await this.mod.connect?.(this.manifest.config);
  }

  listTools(): ToolDef[] {
    return this.mod.tools.map(({ name, description, inputSchema, confirm }) => ({
      name,
      description,
      inputSchema,
      confirm,
    }));
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const tool = this.mod.tools.find((t) => t.name === name);
    if (!tool) return { text: `Okänt verktyg: ${name}`, isError: true };
    const result = await tool.run(input, {
      config: this.manifest.config,
      secret: (n) => this.ctx.secrets.get(n),
    });
    return { text: typeof result === "string" ? result : JSON.stringify(result, null, 1) };
  }

  async close(): Promise<void> {
    await this.mod?.close?.();
  }
}
