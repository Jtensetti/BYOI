// Integration manifest: the one format every "bring your own integration" uses.
// A manifest is a YAML/JSON file in integrations/. The `kind` picks the adapter.
import { z } from "zod";

export const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), secret: z.string() }),
  z.object({
    type: z.literal("api_key"),
    secret: z.string(),
    in: z.enum(["header", "query"]).default("header"),
    name: z.string().default("X-API-Key"),
  }),
  z.object({ type: z.literal("basic"), username: z.string(), secret: z.string() }),
  z.object({
    type: z.literal("oauth2_client_credentials"),
    tokenUrl: z.string().url(),
    clientId: z.string(),
    clientSecret: z.string(), // secret name
    scope: z.string().optional(),
  }),
]);
export type AuthConfig = z.infer<typeof AuthSchema>;

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
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
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
  // Tools to hide from the model (glob-free exact names).
  exclude: z.array(z.string()).default([]),
};

export const ManifestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...Common,
    kind: z.literal("http"),
    baseUrl: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    auth: AuthSchema.default({ type: "none" }),
    operations: z.array(HttpOperationSchema).min(1),
  }),
  z.object({
    ...Common,
    kind: z.literal("openapi"),
    spec: z.string(), // URL or path relative to the manifest
    baseUrl: z.string().url().optional(), // overrides servers[0]
    headers: z.record(z.string(), z.string()).default({}),
    auth: AuthSchema.default({ type: "none" }),
    include: z.array(z.string()).optional(), // operationIds to keep
    confirmMethods: z.array(z.string()).default(["POST", "PUT", "PATCH", "DELETE"]),
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
    confirm: z.array(z.string()).default([]), // tool names that need approval
  }),
  z.object({
    ...Common,
    kind: z.literal("module"),
    module: z.string(), // path to a .ts/.js file, relative to the manifest
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export type Manifest = z.infer<typeof ManifestSchema>;
export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type HttpParam = z.infer<typeof ParamSchema>;
