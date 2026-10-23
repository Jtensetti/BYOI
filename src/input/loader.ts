// Loads every manifest in the integrations folder and connects its adapter.
// One broken integration never takes the others down: it just gets a status.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { AuthApplier, LoginRequiredError, MissingSecretError, SecretStore, interpolate, requiredSecrets, tlsSecrets } from "../core/auth.ts";
import type { ConnectorHub } from "../core/connector-hub.ts";
import type { EventBus } from "../core/events.ts";
import { BrowserAdapter } from "./adapters/browser.ts";
import { CliAdapter } from "./adapters/cli.ts";
import { ConnectorAdapter } from "./adapters/connector.ts";
import { GraphqlAdapter } from "./adapters/graphql.ts";
import { GrpcAdapter } from "./adapters/grpc.ts";
import { HttpAdapter } from "./adapters/http.ts";
import { McpAdapter } from "./adapters/mcp.ts";
import { ModuleAdapter } from "./adapters/module.ts";
import { OpenApiAdapter } from "./adapters/openapi.ts";
import { QueueAdapter } from "./adapters/queue.ts";
import { SoapAdapter } from "./adapters/soap.ts";
import { SqlAdapter } from "./adapters/sql.ts";
import type { Adapter, AdapterContext } from "./adapters/types.ts";
import { WebhookAdapter } from "./adapters/webhook.ts";
import { ManifestSchema, type Manifest } from "./manifest.ts";

export type IntegrationStatus = "ready" | "needs_auth" | "error" | "disabled";

export interface LoadedIntegration {
  id: string;
  name: string;
  kind: string;
  description: string;
  file: string;
  status: IntegrationStatus;
  message?: string;
  missingSecrets: string[];
  /** True when the user must log in via OAuth (authorization code). */
  needsLogin?: boolean;
  manifest?: Manifest;
  adapter?: Adapter;
}

export interface LoaderDeps {
  secrets: SecretStore;
  auth: AuthApplier;
  events: EventBus;
  hub: ConnectorHub;
  /** Called when an adapter's tool list changes after load. */
  toolsChanged(): void;
}

const CONNECT_TIMEOUT_MS = 20_000;

export function createAdapter(m: Manifest, ctx: AdapterContext): Adapter {
  switch (m.kind) {
    case "http":
      return new HttpAdapter(m, ctx);
    case "openapi":
      return new OpenApiAdapter(m, ctx);
    case "graphql":
      return new GraphqlAdapter(m, ctx);
    case "grpc":
      return new GrpcAdapter(m, ctx);
    case "soap":
      return new SoapAdapter(m, ctx);
    case "mcp":
      return new McpAdapter(m, ctx);
    case "sql":
      return new SqlAdapter(m, ctx);
    case "webhook":
      return new WebhookAdapter(m, ctx);
    case "queue":
      return new QueueAdapter(m, ctx);
    case "browser":
      return new BrowserAdapter(m, ctx);
    case "cli":
      return new CliAdapter(m, ctx);
    case "module":
      return new ModuleAdapter(m, ctx);
    case "connector":
      return new ConnectorAdapter(m, ctx);
  }
}

/** Secret names referenced anywhere in the raw manifest. */
function referencedSecrets(raw: unknown): string[] {
  const names = new Set<string>();
  for (const [, name] of JSON.stringify(raw).matchAll(/\$\{secret:([A-Za-z0-9_]+)\}/g)) names.add(name);
  return [...names];
}

/** Every secret name a manifest needs before it can connect. */
export function manifestSecrets(raw: unknown, m: Manifest): string[] {
  const names = new Set(referencedSecrets(raw));
  if ("auth" in m && m.auth) for (const s of requiredSecrets(m.auth)) names.add(s);
  if ("tls" in m && typeof m.tls === "object") for (const s of tlsSecrets(m.tls)) names.add(s);
  if (m.kind === "webhook" && m.verify.type !== "none") names.add(m.verify.secret);
  if (m.kind === "soap" && m.wsSecurity) names.add(m.wsSecurity.secret);
  if (m.kind === "connector") names.add(m.token);
  return [...names];
}

export async function loadIntegration(file: string, deps: LoaderDeps): Promise<LoadedIntegration> {
  const base = { file, id: path.basename(file).replace(/\.\w+$/, ""), name: path.basename(file), kind: "?", description: "", missingSecrets: [] as string[] };
  let raw: any;
  try {
    raw = YAML.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    return { ...base, status: "error", message: `Kunde inte läsa manifestet: ${(err as Error).message}` };
  }

  const shape = ManifestSchema.safeParse(raw);
  if (!shape.success) {
    const issues = shape.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ...base, status: "error", message: `Ogiltigt manifest – ${issues}` };
  }
  const m = shape.data;
  const info = { ...base, id: m.id, name: m.name, kind: m.kind, description: m.description };
  if (!m.enabled) return { ...info, status: "disabled" };

  const missing = manifestSecrets(raw, m).filter((s) => !deps.secrets.has(s));
  if (missing.length) {
    return { ...info, status: "needs_auth", missingSecrets: missing, message: `Saknar: ${missing.join(", ")}` };
  }
  if ("auth" in m && m.auth?.type === "oauth2_authorization_code" && !deps.auth.isLoggedIn(m.id)) {
    return { ...info, manifest: m, status: "needs_auth", needsLogin: true, message: "Logga in för att ansluta" };
  }

  const manifest = ManifestSchema.parse(interpolate(raw, deps.secrets));
  const adapter = createAdapter(manifest, {
    integrationId: m.id,
    secrets: deps.secrets,
    auth: deps.auth,
    events: deps.events,
    hub: deps.hub,
    baseDir: path.dirname(file),
    toolsChanged: deps.toolsChanged,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      adapter.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout vid anslutning")), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    await adapter.close().catch(() => {});
    if (err instanceof MissingSecretError) return { ...info, status: "needs_auth", missingSecrets: [err.secret], message: err.message };
    if (err instanceof LoginRequiredError) return { ...info, manifest, status: "needs_auth", needsLogin: true, message: err.message };
    return { ...info, status: "error", message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
  return { ...info, status: "ready", manifest, adapter };
}

export async function loadIntegrations(dir: string, deps: LoaderDeps): Promise<LoadedIntegration[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const files = entries.filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
  return Promise.all(files.map((f) => loadIntegration(path.join(dir, f), deps)));
}
