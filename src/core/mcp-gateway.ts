// MCP gateway: exposes every connected integration as ONE MCP server at /mcp.
// So the same integrations also work in Claude Desktop, Claude Code, IDEs, etc.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Registry } from "./registry.ts";

function buildServer(registry: Registry): Server {
  const server = new Server({ name: "byoi-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { destructiveHint: t.confirm, readOnlyHint: !t.confirm },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const out = await registry.call(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text: out.text }], isError: Boolean(out.isError) };
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server+transport per request. */
export async function handleMcpRequest(
  registry: Registry,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = buildServer(registry);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
