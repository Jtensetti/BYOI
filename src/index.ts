import { createApp } from "./app.ts";
import { createServer } from "./output/server.ts";

const port = Number(process.env.PORT ?? 3000);
const app = await createApp();
const server = createServer(app);

server.listen(port, () => {
  console.log(`BYOI kör på http://localhost:${port}  (MCP-gateway: /mcp)`);
  for (const i of app.registry.integrations) {
    const tools = app.registry.list().filter((t) => t.integrationId === i.id).length;
    const msg = i.adapter?.statusMessage?.() ?? i.message;
    console.log(`  ${i.status.padEnd(10)} ${i.id} (${i.kind}) – ${tools} verktyg${msg ? ` · ${msg}` : ""}`);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("  OBS: ANTHROPIC_API_KEY saknas – chatten fungerar inte förrän den är satt (MCP-gatewayen fungerar ändå).");
  }
  if (!process.env.BYOI_API_TOKEN) console.log("  OBS: BYOI_API_TOKEN är inte satt – API:t är öppet (bara för lokal utveckling).");
});

const shutdown = async () => {
  server.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
