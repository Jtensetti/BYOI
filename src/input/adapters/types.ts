// The contract every input adapter implements. Whatever the source is
// (REST, OpenAPI, MCP server, custom code), it ends up as a list of tools.
import type { AuthApplier, SecretStore } from "../../core/auth.ts";

export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export interface ToolDef {
  /** Name local to the integration; the registry adds a namespace. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Ask the user before running (write/delete actions). */
  confirm?: boolean;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
}

export interface AdapterContext {
  secrets: SecretStore;
  auth: AuthApplier;
  /** Directory of the manifest, for resolving relative paths. */
  baseDir: string;
}

export interface Adapter {
  connect(): Promise<void>;
  listTools(): ToolDef[];
  callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  close(): Promise<void>;
}
