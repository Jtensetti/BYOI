// Wires the three layers together: input → core → output.
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import YAML from "yaml";
import { Agent, Approvals, type AgentEvent, type LlmClient } from "./core/agent.ts";
import { AuthApplier, SecretStore } from "./core/auth.ts";
import { ConnectorHub } from "./core/connector-hub.ts";
import { EventBus } from "./core/events.ts";
import { generateIntegration } from "./core/generator.ts";
import { Registry, type BuiltinTool } from "./core/registry.ts";
import { loadSkills, skillTool, type Skill } from "./core/skills.ts";
import { loadIntegrations } from "./input/loader.ts";
import { ManifestSchema, runsLocalCode } from "./input/manifest.ts";

export interface AppOptions {
  integrationsDir?: string;
  skillsDir?: string;
  secretsFile?: string;
  llmClient?: LlmClient;
  /** Client for the generator's structured-output call. */
  anthropic?: Anthropic;
}

export class InstallError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function createApp(opts: AppOptions = {}) {
  const integrationsDir = path.resolve(opts.integrationsDir ?? "integrations");
  const skillsDir = path.resolve(opts.skillsDir ?? "skills");
  const secrets = new SecretStore(opts.secretsFile);
  const auth = new AuthApplier(secrets);
  const events = new EventBus();

  let skills: Skill[] = [];
  const builtins: BuiltinTool[] = [skillTool(() => skills)];
  const registry = new Registry(builtins);
  const agent = new Agent(registry, () => skills, new Approvals(), opts.llmClient);

  const connectorIntegration = (connectorId: string) =>
    registry.integrations.find((i) => i.manifest?.kind === "connector" && i.manifest.connectorId === connectorId);

  const hub = new ConnectorHub(
    (connectorId) => {
      const m = connectorIntegration(connectorId)?.manifest;
      return m?.kind === "connector" && secrets.has(m.token) ? secrets.get(m.token) : undefined;
    },
    (connectorId, source, payload) => {
      const i = connectorIntegration(connectorId);
      if (i) events.publish(i.id, source, payload, 500);
    },
  );

  let rebuildTimer: NodeJS.Timeout | undefined;
  const toolsChanged = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void registry.rebuild(), 50);
  };

  /** Validates and saves a manifest, then reconnects. Code-running kinds only when allowed. */
  async function install(manifestText: string, allowCode = process.env.BYOI_ALLOW_CODE_INTEGRATIONS === "1") {
    let raw: unknown;
    try {
      raw = YAML.parse(manifestText);
    } catch (err) {
      throw new InstallError(400, `Ogiltig YAML: ${(err as Error).message}`);
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) throw new InstallError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (runsLocalCode(parsed.data as any) && !allowCode) {
      throw new InstallError(403, `Integrationer av typen ${parsed.data.kind} kör kod eller öppnar resurser på servern och läggs till som fil i integrations/ (eller sätt BYOI_ALLOW_CODE_INTEGRATIONS=1).`);
    }
    await fs.writeFile(path.join(integrationsDir, `${parsed.data.id}.yaml`), manifestText);
    await app.reload();
    return registry.integrations.find((i) => i.id === parsed.data.id)!;
  }

  builtins.push(
    {
      name: "propose_integration",
      description:
        "Tar fram ett utkast till integration för ett nytt system. Källan kan vara en URL (API, OpenAPI/Swagger, GraphQL, MCP-server, WSDL, dokumentationssida), en anslutningssträng (postgres://, mysql://, mqtt://, amqp://, kafka://) eller fri text (curl-exempel, klistrad dokumentation, en beskrivning). Visa utkastet för användaren innan det installeras.",
      inputSchema: {
        type: "object",
        properties: { source: { type: "string" }, name: { type: "string", description: "Valfritt namn" } },
        required: ["source"],
      },
      async run(input) {
        try {
          const guide = skills.find((s) => s.name === "skapa-integration")?.body;
          const d = await generateIntegration(String(input.source), { hint: input.name as string | undefined, client: opts.anthropic, guide });
          return { text: [`Identifierat: ${d.detected}`, "```yaml", d.manifest.trim(), "```", d.secrets.length ? `Hemligheter att fylla i: ${d.secrets.map((s) => `${s.name} (${s.description})`).join(", ")}` : "", ...d.notes].filter(Boolean).join("\n") };
        } catch (err) {
          return { text: `Kunde inte ta fram en integration: ${(err as Error).message}`, isError: true };
        }
      },
    },
    {
      name: "install_integration",
      description: "Installerar och ansluter en integration från ett YAML-manifest (t.ex. från propose_integration). Dess verktyg blir tillgängliga direkt.",
      inputSchema: { type: "object", properties: { manifest_yaml: { type: "string" } }, required: ["manifest_yaml"] },
      confirm: true,
      async run(input) {
        try {
          const i = await install(String(input.manifest_yaml));
          const tools = registry.list().filter((t) => t.integrationId === i.id).map((t) => t.name);
          return { text: `Integrationen ${i.id} har status ${i.status}${i.message ? ` (${i.message})` : ""}.${tools.length ? ` Verktyg: ${tools.join(", ")}` : ""}${i.needsLogin ? " Användaren behöver logga in via knappen i sidopanelen." : ""}` };
        } catch (err) {
          return { text: (err as Error).message, isError: true };
        }
      },
    },
  );

  // Automations: an event with a trigger starts an unattended agent run.
  events.onEvent((event, trigger) => {
    if (!trigger) return;
    const conversationId = `auto-${event.integrationId}-${event.id}`;
    event.run = { conversationId, status: "running" };
    let text = "";
    const collect = (e: AgentEvent) => {
      if (e.type === "text") text += e.delta;
      if (e.type === "error" && event.run) event.run.status = "error";
    };
    const prompt = `${trigger.prompt}\n\nHändelse från ${event.integrationId} (${event.source}), mottagen ${event.receivedAt}:\n<event>\n${JSON.stringify(event.payload, null, 1)}\n</event>`;
    void agent.run(conversationId, prompt, collect, { unattended: true, autoApprove: trigger.autoApprove }).then(() => {
      if (event.run) {
        if (event.run.status === "running") event.run.status = "done";
        event.run.summary = text.slice(0, 2000);
      }
    });
  });

  const app = {
    integrationsDir,
    secrets,
    auth,
    events,
    hub,
    registry,
    agent,
    install,
    get skills() {
      return skills;
    },
    async reload() {
      skills = await loadSkills(skillsDir);
      await registry.setIntegrations(await loadIntegrations(integrationsDir, { secrets, auth, events, hub, toolsChanged }));
    },
    async close() {
      clearTimeout(rebuildTimer);
      hub.close();
      await registry.closeAll();
    },
  };
  await app.reload();
  return app;
}

export type App = Awaited<ReturnType<typeof createApp>>;
