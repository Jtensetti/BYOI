// A minimal MCP server, to show that any MCP server plugs straight in.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "clock", version: "1.0.0" });

server.registerTool(
  "now",
  {
    description: "Returnerar aktuell tid i en IANA-tidszon, t.ex. Europe/Stockholm.",
    inputSchema: { timezone: z.string().default("Europe/Stockholm") },
    annotations: { readOnlyHint: true },
  },
  async ({ timezone }) => {
    const text = new Intl.DateTimeFormat("sv-SE", { dateStyle: "full", timeStyle: "long", timeZone: timezone }).format(new Date());
    return { content: [{ type: "text", text: `${timezone}: ${text}` }] };
  },
);

await server.connect(new StdioServerTransport());
