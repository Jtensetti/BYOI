// Wires the three layers together: input → core → output.
import path from "node:path";
import { Agent, Approvals, type LlmClient } from "./core/agent.ts";
import { AuthApplier, SecretStore } from "./core/auth.ts";
import { Registry } from "./core/registry.ts";
import { loadSkills, skillTool, type Skill } from "./core/skills.ts";
import { loadIntegrations } from "./input/loader.ts";

export interface AppOptions {
  integrationsDir?: string;
  skillsDir?: string;
  secretsFile?: string;
  llmClient?: LlmClient;
}

export async function createApp(opts: AppOptions = {}) {
  const integrationsDir = path.resolve(opts.integrationsDir ?? "integrations");
  const skillsDir = path.resolve(opts.skillsDir ?? "skills");
  const secrets = new SecretStore(opts.secretsFile);
  const auth = new AuthApplier(secrets);

  let skills: Skill[] = [];
  const registry = new Registry([skillTool(() => skills)]);
  const agent = new Agent(registry, () => skills, new Approvals(), opts.llmClient);

  const app = {
    integrationsDir,
    secrets,
    registry,
    agent,
    get skills() {
      return skills;
    },
    async reload() {
      skills = await loadSkills(skillsDir);
      await registry.setIntegrations(await loadIntegrations(integrationsDir, secrets, auth));
    },
  };
  await app.reload();
  return app;
}

export type App = Awaited<ReturnType<typeof createApp>>;
