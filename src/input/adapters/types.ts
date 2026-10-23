// The contract every input adapter implements. Whatever the source is
// (REST, GraphQL, gRPC, SOAP, MCP, SQL, queues, webhooks, a browser, a CLI,
// custom code or an on-prem connector), it ends up as a list of tools.
import type { AuthApplier, SecretStore } from "../../core/auth.ts";
import type { ConnectorHub } from "../../core/connector-hub.ts";
import type { EventBus } from "../../core/events.ts";

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
  /** Optional images (e.g. browser screenshots), base64. */
  images?: { mediaType: "image/png" | "image/jpeg"; data: string }[];
}

export interface AdapterContext {
  integrationId: string;
  secrets: SecretStore;
  auth: AuthApplier;
  events: EventBus;
  hub: ConnectorHub;
  /** Directory of the manifest, for resolving relative paths. */
  baseDir: string;
  /** Call when the adapter's tool list changes after connect (e.g. a connector comes online). */
  toolsChanged(): void;
}

export interface Adapter {
  connect(): Promise<void>;
  listTools(): ToolDef[];
  callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  close(): Promise<void>;
  /** Optional live status line, shown in the UI (e.g. "offline", "3 events"). */
  statusMessage?(): string | undefined;
}

/** Shared "recent_events" tool for adapters that receive events. */
export function recentEventsTool(): ToolDef {
  return {
    name: "recent_events",
    description: "Visar de senaste inkomna händelserna (nyast först).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10, minimum: 1, maximum: 100 },
        source: { type: "string", description: "Filtrera på källa (t.ex. topic eller sökväg)" },
      },
    },
  };
}
