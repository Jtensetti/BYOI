// MCP adapter: plug in any existing MCP server (local stdio or remote HTTP).
// This is the widest door in the universal port – databases, SaaS, files, etc.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Manifest } from "../manifest.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

export class McpAdapter implements Adapter {
  private client = new Client({ name: "byoi", version: "0.1.0" });
  private tools: ToolDef[] = [];

  constructor(
    private manifest: Extract<Manifest, { kind: "mcp" }>,
    private ctx: AdapterContext,
  ) {}

  async connect(): Promise<void> {
    const t = this.manifest.transport;
    const transport =
      t.type === "stdio"
        ? new StdioClientTransport({
            command: t.command,
            args: t.args,
            env: { ...(process.env as Record<string, string>), ...t.env },
            cwd: this.ctx.baseDir,
            stderr: "inherit", // MCP server logs show up in our console
          })
        : new StreamableHTTPClientTransport(new URL(t.url), {
            requestInit: { headers: t.headers },
          });
    await this.client.connect(transport);

    const { tools } = await this.client.listTools();
    this.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as JsonSchema,
      confirm:
        this.manifest.confirm.includes(tool.name) ||
        tool.annotations?.destructiveHint === true,
    }));
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const result = await this.client.callTool({ name, arguments: input });
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((p: any) =>
        p.type === "text" ? p.text : p.type === "resource" ? (p.resource?.text ?? "") : `[${p.type}]`,
      )
      .join("\n");
    return {
      text: text || JSON.stringify(result.structuredContent ?? result),
      isError: Boolean(result.isError),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
