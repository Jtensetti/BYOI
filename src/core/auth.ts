// Auth: where secrets live and how they are attached to outbound requests.
// Secrets never appear in manifests – only their names do.
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthConfig } from "../input/manifest.ts";

export class MissingSecretError extends Error {
  constructor(public secret: string) {
    super(`Saknar hemlighet "${secret}". Sätt miljövariabeln eller lägg den i .secrets.json.`);
  }
}

/** Reads secrets from env vars first, then from a local .secrets.json file. */
export class SecretStore {
  private file: Record<string, string> = {};

  constructor(private filePath = path.resolve(".secrets.json")) {
    if (fs.existsSync(filePath)) {
      this.file = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  }

  has(name: string): boolean {
    return Boolean(process.env[name] ?? this.file[name]);
  }

  get(name: string): string {
    const value = process.env[name] ?? this.file[name];
    if (!value) throw new MissingSecretError(name);
    return value;
  }

  set(name: string, value: string): void {
    this.file[name] = value;
    fs.writeFileSync(this.filePath, JSON.stringify(this.file, null, 2), { mode: 0o600 });
  }
}

/** Secret names an auth config depends on (used to report "needs auth"). */
export function requiredSecrets(auth: AuthConfig): string[] {
  switch (auth.type) {
    case "none":
      return [];
    case "oauth2_client_credentials":
      return [auth.clientSecret];
    default:
      return [auth.secret];
  }
}

/** Replaces ${secret:NAME} and ${env:NAME} in every string of a value. */
export function interpolate<T>(value: T, secrets: SecretStore): T {
  if (typeof value === "string") {
    return value.replace(/\$\{(secret|env):([A-Za-z0-9_]+)\}/g, (_, kind, name) =>
      kind === "secret" ? secrets.get(name) : (process.env[name] ?? ""),
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, secrets)]),
    ) as T;
  }
  return value;
}

/** Attaches credentials to an outgoing HTTP request. */
export class AuthApplier {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private secrets: SecretStore) {}

  async apply(auth: AuthConfig, headers: Headers, url: URL): Promise<void> {
    switch (auth.type) {
      case "none":
        return;
      case "bearer":
        headers.set("Authorization", `Bearer ${this.secrets.get(auth.secret)}`);
        return;
      case "api_key": {
        const key = this.secrets.get(auth.secret);
        if (auth.in === "query") url.searchParams.set(auth.name, key);
        else headers.set(auth.name, key);
        return;
      }
      case "basic": {
        const raw = `${auth.username}:${this.secrets.get(auth.secret)}`;
        headers.set("Authorization", `Basic ${Buffer.from(raw).toString("base64")}`);
        return;
      }
      case "oauth2_client_credentials":
        headers.set("Authorization", `Bearer ${await this.clientCredentialsToken(auth)}`);
        return;
    }
  }

  private async clientCredentialsToken(
    auth: Extract<AuthConfig, { type: "oauth2_client_credentials" }>,
  ): Promise<string> {
    const key = `${auth.tokenUrl}|${auth.clientId}|${auth.scope ?? ""}`;
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: this.secrets.get(auth.clientSecret),
    });
    if (auth.scope) body.set("scope", auth.scope);
    const res = await fetch(auth.tokenUrl, { method: "POST", body });
    if (!res.ok) throw new Error(`OAuth2-tokenförfrågan misslyckades: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.tokenCache.set(key, {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }
}

/**
 * Inbound auth for the product's own API (/api, /mcp).
 * If BYOI_API_TOKEN is unset, the server runs open (local dev only).
 */
export function checkInboundToken(authorizationHeader: string | undefined): boolean {
  const expected = process.env.BYOI_API_TOKEN;
  if (!expected) return true;
  const a = Buffer.from(authorizationHeader ?? "");
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
