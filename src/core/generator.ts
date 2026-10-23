// Integration generator: turns "anything" into a manifest.
//   1. Connection strings (postgres://, mqtt://, …)   → deterministic manifest
//   2. URLs: probe for MCP, OpenAPI/Swagger, GraphQL, WSDL → deterministic manifest
//   3. Everything else (docs pages, curl examples, a description) → Claude writes
//      the manifest, we validate it and feed errors back until it is valid.
// Nothing is installed here – the result is a draft the user reviews.
import { lookup } from "node:dns/promises";
import net from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import YAML from "yaml";
import { z } from "zod";
import { ManifestSchema, type Manifest } from "../input/manifest.ts";
import { MODEL } from "./agent.ts";

export interface Draft {
  manifest: string; // YAML
  detected: string; // how we recognised it
  secrets: { name: string; description: string }[];
  notes: string[];
}

const MAX_DOC_CHARS = 400_000;

// ---------- helpers ----------

export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return /^[a-z0-9]/.test(s) ? s : `int-${s || "ny"}`.slice(0, 30);
}

const secretName = (id: string, what: string) => `${id}_${what}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:127.") || v6.startsWith("::ffff:10.") || v6.startsWith("::ffff:192.168.");
}

/**
 * Blocks requests to internal addresses (SSRF). Systems on private networks
 * are reached through an on-prem connector instead.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Endast http(s)-adresser");
  if (process.env.BYOI_ALLOW_PRIVATE_NETWORK === "1") return;
  const { address } = await lookup(url.hostname);
  if (isPrivateIp(address)) {
    throw new Error("Adressen pekar på ett internt nät. Använd en on-prem-connector (kind: connector) för interna system.");
  }
}

async function probe(url: URL, init: RequestInit = {}): Promise<{ status: number; type: string; text: string; headers: Headers } | null> {
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type") ?? "", text, headers: res.headers };
  } catch {
    return null;
  }
}

function parseStructured(text: string): any {
  try {
    return YAML.parse(text);
  } catch {
    return null;
  }
}

/** Maps an OpenAPI security scheme to our auth config + secrets. */
function authFromOpenApi(spec: any, id: string): { auth: any; secrets: Draft["secrets"]; notes: string[] } {
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  for (const scheme of Object.values<any>(schemes)) {
    const SECRET = secretName(id, "token");
    if ((scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer") || scheme.type === "oauth2" && !scheme.flows?.authorizationCode) {
      if (scheme.type === "oauth2" && scheme.flows?.clientCredentials) {
        const SECRET_CS = secretName(id, "client_secret");
        return {
          auth: { type: "oauth2_client_credentials", tokenUrl: scheme.flows.clientCredentials.tokenUrl, clientId: "FYLL_I_CLIENT_ID", clientSecret: SECRET_CS },
          secrets: [{ name: SECRET_CS, description: "OAuth2 client secret" }],
          notes: ["Fyll i clientId."],
        };
      }
      return { auth: { type: "bearer", secret: SECRET }, secrets: [{ name: SECRET, description: "API-token (Bearer)" }], notes: [] };
    }
    if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
      const S = secretName(id, "password");
      return { auth: { type: "basic", username: "FYLL_I", secret: S }, secrets: [{ name: S, description: "Lösenord" }], notes: ["Fyll i användarnamn."] };
    }
    if (scheme.type === "apiKey" && scheme.in !== "cookie") {
      const S = secretName(id, "api_key");
      return { auth: { type: "api_key", in: scheme.in, name: scheme.name, secret: S }, secrets: [{ name: S, description: `API-nyckel (${scheme.in}: ${scheme.name})` }], notes: [] };
    }
    if (scheme.type === "oauth2" && scheme.flows?.authorizationCode) {
      const f = scheme.flows.authorizationCode;
      return {
        auth: { type: "oauth2_authorization_code", authorizeUrl: f.authorizationUrl, tokenUrl: f.tokenUrl, clientId: "FYLL_I_CLIENT_ID", scopes: Object.keys(f.scopes ?? {}).slice(0, 10) },
        secrets: [],
        notes: ["Registrera en OAuth-app hos leverantören med redirect-URL <din BYOI-adress>/oauth/callback och fyll i clientId (och clientSecret om appen inte är publik)."],
      };
    }
  }
  return { auth: { type: "none" }, secrets: [], notes: [] };
}

function draft(m: Record<string, unknown>, detected: string, secrets: Draft["secrets"] = [], notes: string[] = []): Draft {
  ManifestSchema.parse(m); // our own drafts must always be valid
  return { manifest: YAML.stringify(m), detected, secrets, notes };
}

// ---------- 1. connection strings ----------

function fromConnectionString(source: string, hint?: string): Draft | null {
  const m = source.trim().match(/^(postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|sqlite|mqtts?|amqps?|kafka):\/\/(.*)$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const url = new URL(source.trim().replace(/^sqlite:\/\//i, "sqlite://local/"));
  const id = slug(hint ?? (url.pathname.replace(/^\//, "") || url.hostname || scheme));
  const secrets: Draft["secrets"] = [];
  let connection = source.trim();
  if (url.password) {
    const S = secretName(id, "password");
    connection = connection.replace(`:${url.password}@`, `:\${secret:${S}}@`);
    secrets.push({ name: S, description: `Lösenord för ${url.username}@${url.hostname}` });
  }
  const notes = ["Lösenordet flyttades ut ur manifestet till en hemlighet."].filter(() => secrets.length > 0);

  if (/^(postgres|mysql|mariadb|mssql|sqlserver|sqlite)/.test(scheme)) {
    const driver = scheme.startsWith("postgres") ? "postgres" : scheme === "sqlite" ? "sqlite" : /mssql|sqlserver/.test(scheme) ? "mssql" : "mysql";
    if (driver === "sqlite") connection = source.trim().replace(/^sqlite:\/\//i, "");
    return draft(
      { id, name: hint ?? `Databas ${url.pathname.replace(/^\//, "") || url.hostname}`, kind: "sql", driver, connection, allowWrite: false },
      `${driver}-anslutningssträng`,
      secrets,
      [...notes, "Endast läsning är påslaget (allowWrite: false). Använd gärna en databasanvändare med bara läsrättigheter."],
    );
  }
  const driver = scheme.startsWith("mqtt") ? "mqtt" : scheme.startsWith("amqp") ? "amqp" : "kafka";
  if (driver === "kafka") connection = url.host;
  return draft(
    { id, name: hint ?? `${driver.toUpperCase()} ${url.hostname}`, kind: "queue", driver, url: connection, subscribe: ["#"].filter(() => driver === "mqtt"), publish: [] },
    `${driver}-broker`,
    secrets,
    [...notes, "Ange vilka topics/köer som ska prenumereras på (subscribe) och vilka modellen får publicera till (publish)."],
  );
}

// ---------- 2. URL probing ----------

async function fromUrl(url: URL, hint?: string): Promise<{ draft?: Draft; pageText?: string }> {
  const id = slug(hint ?? url.hostname.replace(/^(www|api)\./, "").split(".")[0]);

  // MCP (Streamable HTTP): answer an initialize request.
  const mcp = await probe(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "byoi-probe", version: "1" } } }),
  });
  if (mcp && (/"protocolVersion"/.test(mcp.text) || (mcp.status === 401 && /resource_metadata/i.test(mcp.headers.get("www-authenticate") ?? "")))) {
    const name = mcp.text.match(/"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/)?.[1] ?? hint ?? url.hostname;
    const notes = mcp.status === 401 ? ["Servern kräver inloggning (MCP OAuth). Lägg till auth: oauth2_authorization_code med leverantörens OAuth-uppgifter."] : [];
    return { draft: draft({ id: slug(hint ?? name), name, kind: "mcp", transport: { type: "http", url: url.toString() } }, "MCP-server (Streamable HTTP)", [], notes) };
  }

  // GraphQL: answer { __typename }.
  const gql = await probe(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) });
  if (gql && /"__typename"\s*:/.test(gql.text)) {
    return { draft: draft({ id, name: hint ?? `${url.hostname} (GraphQL)`, kind: "graphql", endpoint: url.toString() }, "GraphQL-endpoint", [], ["Kräver API:t inloggning: lägg till auth (t.ex. bearer)."]) };
  }

  const page = await probe(url, { headers: { Accept: "application/json, application/yaml, text/xml, text/html;q=0.8, */*;q=0.5" } });
  if (page && page.status < 400) {
    if (/schemas\.xmlsoap\.org\/wsdl|<(wsdl:)?definitions[\s>]/.test(page.text)) {
      return { draft: draft({ id, name: hint ?? `${url.hostname} (SOAP)`, kind: "soap", wsdl: url.toString() }, "WSDL (SOAP)") };
    }
    const spec = /json|yaml|yml|text\/plain/.test(page.type) || /^\s*[{]|^\s*(openapi|swagger):/m.test(page.text) ? parseStructured(page.text) : null;
    if (spec && (spec.openapi || spec.swagger) && spec.paths) {
      const specId = slug(hint ?? spec.info?.title ?? id);
      const { auth, secrets, notes } = authFromOpenApi(spec, specId);
      const opCount = Object.values<any>(spec.paths).reduce((n, p) => n + Object.keys(p).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)).length, 0);
      return {
        draft: draft(
          { id: specId, name: hint ?? spec.info?.title ?? url.hostname, description: String(spec.info?.description ?? "").split("\n")[0].slice(0, 200), kind: "openapi", spec: url.toString(), auth },
          `${spec.openapi ? "OpenAPI " + spec.openapi : "Swagger " + spec.swagger} (${opCount} operationer)`,
          secrets,
          [...notes, ...(opCount > 30 ? [`${opCount} operationer – modellen hittar dem via verktygssökning, eller begränsa med include: [...]`] : [])],
        ),
      };
    }
  }

  // Common spec locations on the same origin.
  for (const p of ["/openapi.json", "/swagger.json", "/openapi.yaml", "/v3/api-docs", "/api/openapi.json", "/swagger/v1/swagger.json", "/api-docs"]) {
    const candidate = new URL(p, url.origin);
    if (candidate.toString() === url.toString()) continue;
    const res = await probe(candidate, { headers: { Accept: "application/json, application/yaml" } });
    const spec = res && res.status < 400 ? parseStructured(res.text) : null;
    if (spec && (spec.openapi || spec.swagger) && spec.paths) return fromUrl(candidate, hint);
  }

  return { pageText: page?.text };
}

// ---------- 3. Claude writes it ----------

const GeneratedSchema = z.object({
  manifest_yaml: z.string().describe("Komplett YAML-manifest"),
  secrets: z.array(z.object({ name: z.string(), description: z.string() })).describe("Hemligheter användaren måste fylla i"),
  notes: z.array(z.string()).describe("Korta saker användaren behöver veta eller fylla i"),
});

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function withClaude(client: Anthropic, material: string, hint: string | undefined, guide: string): Promise<Draft> {
  const notes: string[] = [];
  if (material.length > MAX_DOC_CHARS) {
    notes.push(`Dokumentationen var ${material.length} tecken; bara de första ${MAX_DOC_CHARS} lästes.`);
    material = material.slice(0, MAX_DOC_CHARS);
  }
  const system = [
    "Du skriver integrationsmanifest för BYOI. Svara med ett giltigt YAML-manifest enligt JSON-schemat nedan.",
    "Regler: hemligheter anges bara med namn (auth.secret eller ${secret:NAMN}), aldrig med värden.",
    "Hemlighetsnamn: VERSALER_MED_UNDERSTRECK, prefixade med integrationens id.",
    "Välj den mest direkta kind: openapi om en spec-URL nämns, graphql för GraphQL, mcp för MCP-servrar,",
    "sql för databaser, queue för meddelandeköer, webhook för inkommande händelser, soap för WSDL,",
    "http för vanliga REST-anrop (lista bara operationer som dokumentationen faktiskt beskriver),",
    "browser bara när systemet saknar API. Operationer som ändrar data ska ha confirm: true.",
    "Hitta inte på endpoints. Saknas något, lämna en tydlig platshållare (FYLL_I) och nämn det i notes.",
    "",
    "## Guide",
    guide,
    "",
    "## JSON-schema för manifestet",
    JSON.stringify(z.toJSONSchema(ManifestSchema, { io: "input", unrepresentable: "any" })),
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${hint ? `Integrationens namn: ${hint}\n\n` : ""}Underlag:\n<underlag>\n${material}\n</underlag>` },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(GeneratedSchema) },
      system,
      messages,
    });
    if (res.stop_reason === "refusal") throw new Error("Modellen avböjde att skriva manifestet.");
    const out = res.parsed_output;
    if (!out) throw new Error("Modellen gav inget tolkbart svar.");

    let parsed: unknown;
    let issues: string;
    try {
      parsed = YAML.parse(out.manifest_yaml);
      const check = ManifestSchema.safeParse(parsed);
      if (check.success) return { manifest: out.manifest_yaml, detected: "skrivet av Claude från underlaget", secrets: out.secrets, notes: [...notes, ...out.notes] };
      issues = check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    } catch (err) {
      issues = `YAML-fel: ${(err as Error).message}`;
    }
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    messages.push({ role: "user", content: `Manifestet validerade inte:\n${issues}\nRätta och svara igen.` });
  }
  throw new Error("Kunde inte få fram ett giltigt manifest efter tre försök.");
}

export async function generateIntegration(source: string, opts: { client?: Anthropic; hint?: string; guide?: string } = {}): Promise<Draft> {
  source = source.trim();
  if (!source) throw new Error("Ange en URL, anslutningssträng eller beskrivning");

  const conn = fromConnectionString(source, opts.hint);
  if (conn) return conn;

  let material = source;
  if (/^https?:\/\/\S+$/.test(source)) {
    const url = new URL(source);
    await assertPublicUrl(url);
    const found = await fromUrl(url, opts.hint);
    if (found.draft) return found.draft;
    material = `Källa: ${source}\n\n${found.pageText && /<html|<body|<div/i.test(found.pageText) ? htmlToText(found.pageText) : (found.pageText ?? "(kunde inte hämtas)")}`;
  }
  return withClaude(opts.client ?? new Anthropic(), material, opts.hint, opts.guide ?? "");
}

export type { Manifest };
