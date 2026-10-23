// Connector adapter: tools served by an on-prem connector via the hub.
import type { ManifestOf } from "../manifest.ts";
import type { Adapter, AdapterContext, ToolDef, ToolOutput } from "./types.ts";

export class ConnectorAdapter implements Adapter {
  private unsubscribe?: () => void;

  constructor(private manifest: ManifestOf<"connector">, private ctx: AdapterContext) {}

  async connect(): Promise<void> {
    this.unsubscribe = this.ctx.hub.onChange((id) => {
      if (id === this.manifest.connectorId) this.ctx.toolsChanged();
    });
  }

  listTools(): ToolDef[] {
    return this.ctx.hub.tools(this.manifest.connectorId);
  }

  callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    return this.ctx.hub.call(this.manifest.connectorId, name, input);
  }

  statusMessage(): string {
    return this.ctx.hub.isOnline(this.manifest.connectorId)
      ? `connector online · ${this.listTools().length} verktyg`
      : `connector offline – starta den hos kunden (id: ${this.manifest.connectorId})`;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
  }
}
