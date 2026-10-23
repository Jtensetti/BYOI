// Loads every manifest in the integrations folder and connects its adapter.
// One broken integration never takes the others down: it just gets a status.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { AuthApplier, MissingSecretError, SecretStore, interpolate, requiredSecrets } from "../core/auth.ts";
import { HttpAdapter } from "./adapters/http.ts";
import { McpAdapter } from "./adapters/mcp.ts";
import { ModuleAdapter } from "./adapters/module.ts";
import { OpenApiAdapter } from "./adapters/openapi.ts";
import type { Adapter, AdapterContext } from "./adapters/types.ts";
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
  manifest?: Manifest;
  adapter?: Adapter;
}

const CONNECT_TIMEOUT_MS = 20_000;

function createAdapter(m: Manifest, ctx: AdapterContext): Adapter {
  switch (m.kind) {
    case "http":
      return new HttpAdapter(m, ctx);
    case "openapi":
      return new OpenApiAdapter(m, ctx);
    case "mcp":
      return new McpAdapter(m, ctx);
    case "module":
      return new ModuleAdapter(m, ctx);
  }
}

/** Secret names referenced anywhere in the raw manifest. */
function referencedSecrets(raw: unknown): string[] {
  const names = new Set<string>();
  for (const [, name] of JSON.stringify(raw).matchAll(/\$\{secret:([A-Za-z0-9_]+)\}/g)) names.add(name);
  return [...names];
}

export async function loadIntegration(
  file: string,
  secrets: SecretStore,
  auth: AuthApplier,
): Promise<LoadedIntegration> {
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
  const info = { ...base, id: shape.data.id, name: shape.data.name, kind: shape.data.kind, description: shape.data.description };
  if (!shape.data.enabled) return { ...info, status: "disabled" };

  const needed = [
    ...referencedSecrets(raw),
    ...("auth" in shape.data ? requiredSecrets(shape.data.auth) : []),
  ];
  const missing = needed.filter((s) => !secrets.has(s));
  if (missing.length) {
    return { ...info, status: "needs_auth", missingSecrets: missing, message: `Saknar: ${missing.join(", ")}` };
  }

  const manifest = ManifestSchema.parse(interpolate(raw, secrets));
  const adapter = createAdapter(manifest, { secrets, auth, baseDir: path.dirname(file) });
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
    if (err instanceof MissingSecretError) {
      return { ...info, status: "needs_auth", missingSecrets: [err.secret], message: err.message };
    }
    return { ...info, status: "error", message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
  return { ...info, status: "ready", manifest, adapter };
}

export async function loadIntegrations(
  dir: string,
  secrets: SecretStore,
  auth: AuthApplier,
): Promise<LoadedIntegration[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const files = entries.filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
  return Promise.all(files.map((f) => loadIntegration(path.join(dir, f), secrets, auth)));
}
