// Integration manifest: the one format every "bring your own integration" uses.
// A manifest is a YAML/JSON file in integrations/. The `kind` picks the adapter.
//
// Coverage strategy: adapters per *protocol family*, not per vendor.
//   request/response  http · openapi · graphql · grpc · soap
//   native agent      mcp
//   data              sql
//   events            webhook (inbound) · queue (mqtt/amqp/kafka)
//   no API at all     browser (RPA) · cli
//   anything else     module (own code)
//   behind firewalls  connector (on-prem agent runs any of the above)
import { z } from "zod";

// ---------- auth ----------

export const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), secret: z.string() }),
  z.object({
    type: z.literal("api_key"),
    secret: z.string(),
    in: z.enum(["header", "query"]).default("header"),
    name: z.string().default("X-API-Key"),
    prefix: z.string().default(""), // e.g. "Token "
  }),
  z.object({ type: z.literal("basic"), username: z.string(), secret: z.string() }),
  z.object({
    type: z.literal("oauth2_client_credentials"),
    tokenUrl: z.string().url(),
    clientId: z.string(),
    clientSecret: z.string(), // secret name
    scope: z.string().optional(),
    audience: z.string().optional(),
  }),
  // Per-user login (Google, Microsoft, Salesforce, HubSpot, …). PKCE always on.
  z.object({
    type: z.literal("oauth2_authorization_code"),
    authorizeUrl: z.string().url(),
    tokenUrl: z.string().url(),
    clientId: z.string(),
    clientSecret: z.string().optional(), // secret name; omit for public clients
    scopes: z.array(z.string()).default([]),
    extraAuthorizeParams: z.record(z.string(), z.string()).default({}),
  }),
  // Service accounts (e.g. Google): sign a JWT, swap it for an access token.
  z.object({
    type: z.literal("oauth2_jwt_bearer"),
    tokenUrl: z.string().url(),
    issuer: z.string(),
    privateKey: z.string(), // secret name, PEM
    scope: z.string().optional(),
    subject: z.string().optional(),
    audience: z.string().optional(),
  }),
  z.object({
    type: z.literal("aws_sigv4"),
    service: z.string(),
    region: z.string(),
    accessKeyId: z.string(), // secret names
    secretAccessKey: z.string(),
    sessionToken: z.string().optional(),
  }),
]);
export type AuthConfig = z.infer<typeof AuthSchema>;

// Client certificates (mTLS) and custom CAs, as secret names holding PEM text.
export const TlsSchema = z
  .object({
    cert: z.string().optional(),
    key: z.string().optional(),
    ca: z.string().optional(),
    rejectUnauthorized: z.boolean().default(true),
  })
  .optional();
export type TlsConfig = z.infer<typeof TlsSchema>;

// ---------- shared pieces ----------

const ParamSchema = z.object({
  name: z.string(),
  in: z.enum(["query", "path", "header", "body"]).default("query"),
  type: z.enum(["string", "number", "integer", "boolean", "array", "object"]).default("string"),
  description: z.string().optional(),
  required: z.boolean().default(false),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  items: z.record(z.string(), z.unknown()).optional(),
  default: z.unknown().optional(),
});

const HttpOperationSchema = z.object({
  name: z.string(),
  description: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  path: z.string(),
  params: z.array(ParamSchema).default([]),
  // Write operations should ask the user before running.
  confirm: z.boolean().optional(),
});

const Common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/, "får bara innehålla a-z, 0-9, _ och - (max 31 tecken)"),
  name: z.string(),
  description: z.string().default(""),
  enabled: z.boolean().default(true),
  // Tools to hide from the model (exact names).
  exclude: z.array(z.string()).default([]),
};

const HttpCommon = {
  headers: z.record(z.string(), z.string()).default({}),
  auth: AuthSchema.default({ type: "none" }),
  tls: TlsSchema,
};

// Run the agent automatically when an event arrives (automations).
const TriggerSchema = z
  .object({
    prompt: z.string(), // the event JSON is appended
    // Without a human present, tools that need approval are denied unless listed here.
    autoApprove: z.array(z.string()).default([]),
  })
  .optional();

// ---------- kinds ----------

export const ManifestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...Common,
    ...HttpCommon,
    kind: z.literal("http"),
    baseUrl: z.string().url(),
    operations: z.array(HttpOperationSchema).min(1),
  }),
  z.object({
    ...Common,
    ...HttpCommon,
    kind: z.literal("openapi"),
    spec: z.string(), // URL or path relative to the manifest
    baseUrl: z.string().url().optional(), // overrides servers[0]
    include: z.array(z.string()).optional(), // operationIds to keep
    confirmMethods: z.array(z.string()).default(["POST", "PUT", "PATCH", "DELETE"]),
  }),
  z.object({
    ...Common,
    ...HttpCommon,
    kind: z.literal("graphql"),
    endpoint: z.string().url(),
    include: z.array(z.string()).optional(), // root fields to expose as tools
    allowMutations: z.boolean().default(true), // mutations always need approval
    selectionDepth: z.number().int().min(1).max(4).default(2),
  }),
  z.object({
    ...Common,
    kind: z.literal("grpc"),
    address: z.string(), // host:port
    protoFiles: z.array(z.string()).min(1),
    includeDirs: z.array(z.string()).default([]),
    tls: z.boolean().default(true),
    metadata: z.record(z.string(), z.string()).default({}),
    confirm: z.array(z.string()).default([]), // "Service/Method" needing approval
  }),
  z.object({
    ...Common,
    kind: z.literal("soap"),
    wsdl: z.string(),
    endpoint: z.string().url().optional(),
    auth: AuthSchema.default({ type: "none" }),
    wsSecurity: z.object({ username: z.string(), secret: z.string(), digest: z.boolean().default(false) }).optional(),
    confirm: z.array(z.string()).default([]),
    readOnly: z.array(z.string()).optional(), // if set, all others need approval
  }),
  z.object({
    ...Common,
    kind: z.literal("mcp"),
    transport: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
      }),
      z.object({
        type: z.literal("http"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).default({}),
      }),
    ]),
    auth: AuthSchema.default({ type: "none" }), // for http transport
    confirm: z.array(z.string()).default([]),
  }),
  z.object({
    ...Common,
    kind: z.literal("sql"),
    driver: z.enum(["postgres", "mysql", "mssql", "sqlite"]),
    connection: z.string(), // URL, or a file path for sqlite. Use ${secret:...}
    allowWrite: z.boolean().default(false),
    maxRows: z.number().int().min(1).max(10_000).default(200),
    schemas: z.array(z.string()).optional(), // limit list_tables to these
  }),
  z.object({
    ...Common,
    kind: z.literal("webhook"),
    verify: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("none") }),
        z.object({
          type: z.literal("hmac"),
          secret: z.string(),
          header: z.string(), // e.g. X-Hub-Signature-256
          algorithm: z.enum(["sha1", "sha256", "sha512"]).default("sha256"),
          encoding: z.enum(["hex", "base64"]).default("hex"),
          prefix: z.string().default(""), // e.g. "sha256="
        }),
        z.object({ type: z.literal("token"), secret: z.string(), header: z.string().default("X-Webhook-Token") }),
      ])
      .default({ type: "none" }),
    keep: z.number().int().min(1).max(10_000).default(200),
    trigger: TriggerSchema,
  }),
  z.object({
    ...Common,
    kind: z.literal("queue"),
    driver: z.enum(["mqtt", "amqp", "kafka"]),
    url: z.string(), // broker URL(s); kafka: comma-separated brokers
    subscribe: z.array(z.string()).default([]), // topics / queues to listen on
    publish: z.array(z.string()).default([]), // topics the model may publish to ("*" = any)
    keep: z.number().int().min(1).max(10_000).default(200),
    trigger: TriggerSchema,
    options: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    ...Common,
    kind: z.literal("browser"),
    startUrl: z.string().url(),
    allowedDomains: z.array(z.string()).default([]), // empty = startUrl's host only
    login: z
      .object({
        url: z.string().url().optional(),
        steps: z.array(
          z.object({
            fill: z.string().optional(), // selector
            value: z.string().optional(), // may use ${secret:...}
            click: z.string().optional(),
            waitFor: z.string().optional(),
          }),
        ),
      })
      .optional(),
    headless: z.boolean().default(true),
    allowActions: z.boolean().default(true), // click/fill need approval when true
  }),
  z.object({
    ...Common,
    kind: z.literal("cli"),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().default(30_000),
    commands: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          command: z.string(), // executable, never run through a shell
          args: z.array(z.string()).default([]), // "{param}" placeholders
          params: z.array(ParamSchema.omit({ in: true })).default([]),
          confirm: z.boolean().default(false),
          stdin: z.string().optional(), // "{param}" placeholder for stdin
        }),
      )
      .min(1),
  }),
  z.object({
    ...Common,
    kind: z.literal("module"),
    module: z.string(), // path to a .ts/.js file, relative to the manifest
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    ...Common,
    kind: z.literal("connector"),
    connectorId: z.string(),
    token: z.string(), // secret name; the connector must present this token
  }),
]);

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestOf<K extends Manifest["kind"]> = Extract<Manifest, { kind: K }>;
export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type HttpParam = z.infer<typeof ParamSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;

/** Kinds that execute code or open local resources on the server. */
export const CODE_KINDS = new Set(["module", "cli", "browser", "sql"]);
export function runsLocalCode(m: { kind: string; transport?: { type: string }; driver?: string }): boolean {
  return CODE_KINDS.has(m.kind) || (m.kind === "mcp" && m.transport?.type === "stdio");
}
