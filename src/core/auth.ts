// Auth: where secrets live and how they are attached to outbound requests.
// Secrets never appear in manifests – only their names do.
import { createHash, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import aws4 from "aws4";
import { Agent, fetch as undiciFetch } from "undici";
import type { AuthConfig, TlsConfig } from "../input/manifest.ts";

export class MissingSecretError extends Error {
  constructor(public secret: string) {
    super(`Saknar hemlighet "${secret}". Sätt miljövariabeln eller lägg den i .secrets.json.`);
  }
}

export class LoginRequiredError extends Error {
  constructor(public integrationId: string) {
    super(`Integrationen "${integrationId}" kräver inloggning.`);
  }
}

/** Reads secrets from env vars first, then from a local .secrets.json file. */
export class SecretStore {
  private file: Record<string, string> = {};

  constructor(private filePath = path.resolve(".secrets.json")) {
    if (fs.existsSync(filePath)) this.file = JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  delete(name: string): void {
    delete this.file[name];
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
    case "oauth2_authorization_code":
      return auth.clientSecret ? [auth.clientSecret] : [];
    case "oauth2_jwt_bearer":
      return [auth.privateKey];
    case "aws_sigv4":
      return [auth.accessKeyId, auth.secretAccessKey, ...(auth.sessionToken ? [auth.sessionToken] : [])];
    default:
      return [auth.secret];
  }
}

export function tlsSecrets(tls: TlsConfig): string[] {
  return tls ? [tls.cert, tls.key, tls.ca].filter((s): s is string => Boolean(s)) : [];
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
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, secrets)])) as T;
  }
  return value;
}

export interface OutboundRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

const tokenKey = (integrationId: string) => `oauth_token__${integrationId.replace(/-/g, "_")}`;
const b64url = (buf: Buffer) => buf.toString("base64url");

/** Attaches credentials to an outgoing HTTP request, and runs OAuth flows. */
export class AuthApplier {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private pendingLogins = new Map<string, { integrationId: string; verifier: string; redirectUri: string; auth: AuthConfig; createdAt: number }>();

  constructor(private secrets: SecretStore) {}

  async apply(auth: AuthConfig, req: OutboundRequest, integrationId: string): Promise<void> {
    const { headers, url } = req;
    switch (auth.type) {
      case "none":
        return;
      case "bearer":
        headers.set("Authorization", `Bearer ${this.secrets.get(auth.secret)}`);
        return;
      case "api_key": {
        const key = auth.prefix + this.secrets.get(auth.secret);
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
      case "oauth2_jwt_bearer":
      case "oauth2_authorization_code":
        headers.set("Authorization", `Bearer ${await this.accessToken(auth, integrationId)}`);
        return;
      case "aws_sigv4": {
        const signed = aws4.sign(
          {
            host: url.host,
            path: url.pathname + url.search,
            method: req.method,
            service: auth.service,
            region: auth.region,
            headers: Object.fromEntries(headers.entries()),
            body: req.body,
          },
          {
            accessKeyId: this.secrets.get(auth.accessKeyId),
            secretAccessKey: this.secrets.get(auth.secretAccessKey),
            sessionToken: auth.sessionToken ? this.secrets.get(auth.sessionToken) : undefined,
          },
        );
        for (const [k, v] of Object.entries(signed.headers ?? {})) headers.set(k, String(v));
        return;
      }
    }
  }

  /** Access token for any of the OAuth2 flows, cached until shortly before expiry. */
  async accessToken(auth: AuthConfig, integrationId: string): Promise<string> {
    if (auth.type === "oauth2_authorization_code") return this.userToken(auth, integrationId);

    const key = `${integrationId}|${auth.type}`;
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

    let body: URLSearchParams;
    let tokenUrl: string;
    if (auth.type === "oauth2_client_credentials") {
      tokenUrl = auth.tokenUrl;
      body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: auth.clientId,
        client_secret: this.secrets.get(auth.clientSecret),
      });
      if (auth.scope) body.set("scope", auth.scope);
      if (auth.audience) body.set("audience", auth.audience);
    } else if (auth.type === "oauth2_jwt_bearer") {
      tokenUrl = auth.tokenUrl;
      body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: this.signJwt(auth),
      });
    } else {
      throw new Error(`Auth-typen ${auth.type} ger ingen token`);
    }

    const json = await postForm(tokenUrl, body);
    this.tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }

  private signJwt(auth: Extract<AuthConfig, { type: "oauth2_jwt_bearer" }>): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims: Record<string, unknown> = {
      iss: auth.issuer,
      aud: auth.audience ?? auth.tokenUrl,
      iat: now,
      exp: now + 3600,
    };
    if (auth.scope) claims.scope = auth.scope;
    if (auth.subject) claims.sub = auth.subject;
    const payload = b64url(Buffer.from(JSON.stringify(claims)));
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.secrets.get(auth.privateKey));
    return `${header}.${payload}.${b64url(signature)}`;
  }

  // ----- per-user login (authorization code + PKCE) -----

  isLoggedIn(integrationId: string): boolean {
    return this.secrets.has(tokenKey(integrationId));
  }

  logout(integrationId: string): void {
    this.secrets.delete(tokenKey(integrationId));
  }

  startLogin(integrationId: string, auth: AuthConfig, redirectUri: string): string {
    if (auth.type !== "oauth2_authorization_code") throw new Error("Integrationen använder inte OAuth-inloggning");
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    this.pendingLogins.set(state, { integrationId, verifier, redirectUri, auth, createdAt: Date.now() });
    const url = new URL(auth.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", auth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    if (auth.scopes.length) url.searchParams.set("scope", auth.scopes.join(" "));
    for (const [k, v] of Object.entries(auth.extraAuthorizeParams)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** Completes a login. Returns the integration id. */
  async finishLogin(state: string, code: string): Promise<string> {
    const pending = this.pendingLogins.get(state);
    this.pendingLogins.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("Ogiltig eller gammal inloggning – försök igen");
    const auth = pending.auth as Extract<AuthConfig, { type: "oauth2_authorization_code" }>;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: auth.clientId,
      code_verifier: pending.verifier,
    });
    if (auth.clientSecret) body.set("client_secret", this.secrets.get(auth.clientSecret));
    this.storeToken(pending.integrationId, await postForm(auth.tokenUrl, body));
    return pending.integrationId;
  }

  private async userToken(auth: Extract<AuthConfig, { type: "oauth2_authorization_code" }>, integrationId: string): Promise<string> {
    if (!this.secrets.has(tokenKey(integrationId))) throw new LoginRequiredError(integrationId);
    const stored = JSON.parse(this.secrets.get(tokenKey(integrationId))) as StoredToken;
    if (stored.expires_at > Date.now() + 30_000) return stored.access_token;
    if (!stored.refresh_token) throw new LoginRequiredError(integrationId);

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: auth.clientId,
    });
    if (auth.clientSecret) body.set("client_secret", this.secrets.get(auth.clientSecret));
    try {
      const json = await postForm(auth.tokenUrl, body);
      return this.storeToken(integrationId, { refresh_token: stored.refresh_token, ...json }).access_token;
    } catch {
      this.logout(integrationId);
      throw new LoginRequiredError(integrationId);
    }
  }

  private storeToken(integrationId: string, json: { access_token: string; refresh_token?: string; expires_in?: number }): StoredToken {
    const token: StoredToken = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    this.secrets.set(tokenKey(integrationId), JSON.stringify(token));
    return token;
  }

  // ----- transport -----

  private agents = new Map<string, Agent>();

  /** fetch() that applies auth and, when configured, client certificates. */
  async fetch(
    opts: { auth: AuthConfig; tls?: TlsConfig; integrationId: string },
    url: URL,
    init: { method: string; headers?: Headers; body?: string; timeoutMs?: number },
  ): Promise<Response> {
    const headers = init.headers ?? new Headers();
    await this.apply(opts.auth, { method: init.method, url, headers, body: init.body }, opts.integrationId);
    const signal = AbortSignal.timeout(init.timeoutMs ?? 30_000);
    if (!opts.tls) return fetch(url, { method: init.method, headers, body: init.body, signal });

    let agent = this.agents.get(opts.integrationId);
    if (!agent) {
      const s = (name?: string) => (name ? this.secrets.get(name) : undefined);
      agent = new Agent({
        connect: { cert: s(opts.tls.cert), key: s(opts.tls.key), ca: s(opts.tls.ca), rejectUnauthorized: opts.tls.rejectUnauthorized },
      });
      this.agents.set(opts.integrationId, agent);
    }
    const res = await undiciFetch(url, {
      method: init.method,
      headers: Object.fromEntries(headers.entries()),
      body: init.body,
      dispatcher: agent,
      signal,
    });
    return res as unknown as Response;
  }
}

async function postForm(url: string, body: URLSearchParams): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tokenförfrågan misslyckades (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Tokensvaret saknar access_token");
  return json;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Inbound auth for the product's own API (/api, /mcp).
 * If BYOI_API_TOKEN is unset, the server runs open (local dev only).
 */
export function checkInboundToken(authorizationHeader: string | undefined): boolean {
  const expected = process.env.BYOI_API_TOKEN;
  if (!expected) return true;
  return safeEqual(authorizationHeader ?? "", `Bearer ${expected}`);
}
