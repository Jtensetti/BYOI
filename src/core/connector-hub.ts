// Connector hub: on-prem connectors dial OUT to us over a WebSocket (/connect),
// so systems behind firewalls are reachable without opening any inbound port.
// Credentials for those systems stay on the customer's side.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ToolDef, ToolOutput } from "../input/adapters/types.ts";
import { safeEqual } from "./auth.ts";

export type HubMessage =
  | { type: "hello"; connectorId: string; token: string; tools: ToolDef[]; version?: string }
  | { type: "tools"; tools: ToolDef[] }
  | { type: "result"; id: string; output: ToolOutput }
  | { type: "event"; source: string; payload: unknown }
  | { type: "welcome" }
  | { type: "call"; id: string; tool: string; input: Record<string, unknown> };

interface Session {
  ws: WebSocket;
  tools: ToolDef[];
  connectedAt: string;
  pending: Map<string, (out: ToolOutput) => void>;
}

const CALL_TIMEOUT_MS = 120_000;

export class ConnectorHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private sessions = new Map<string, Session>();
  private listeners = new Set<(connectorId: string) => void>();

  /**
   * expectedToken: the token a connector must present, or undefined if no
   * integration declares that connector.
   */
  constructor(
    private expectedToken: (connectorId: string) => string | undefined,
    private onEvent: (connectorId: string, source: string, payload: unknown) => void = () => {},
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocket): void {
    let connectorId: string | undefined;
    const helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), 10_000);

    ws.on("message", (data) => {
      let msg: HubMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(4400, "bad json");
      }
      if (!connectorId) {
        if (msg.type !== "hello") return ws.close(4400, "expected hello");
        const expected = this.expectedToken(msg.connectorId);
        if (!expected || !safeEqual(msg.token ?? "", expected)) return ws.close(4401, "unauthorized");
        clearTimeout(helloTimer);
        connectorId = msg.connectorId;
        this.sessions.get(connectorId)?.ws.close(4409, "replaced by new connection");
        this.sessions.set(connectorId, { ws, tools: msg.tools ?? [], connectedAt: new Date().toISOString(), pending: new Map() });
        ws.send(JSON.stringify({ type: "welcome" } satisfies HubMessage));
        this.changed(connectorId);
        return;
      }
      const session = this.sessions.get(connectorId);
      if (!session || session.ws !== ws) return;
      if (msg.type === "tools") {
        session.tools = msg.tools ?? [];
        this.changed(connectorId);
      } else if (msg.type === "result") {
        session.pending.get(msg.id)?.(msg.output);
        session.pending.delete(msg.id);
      } else if (msg.type === "event") {
        this.onEvent(connectorId, msg.source, msg.payload);
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!connectorId) return;
      const session = this.sessions.get(connectorId);
      if (session?.ws !== ws) return;
      for (const resolve of session.pending.values()) resolve({ text: "Connectorn kopplades från under anropet", isError: true });
      this.sessions.delete(connectorId);
      this.changed(connectorId);
    });
  }

  private changed(connectorId: string): void {
    for (const fn of this.listeners) fn(connectorId);
  }

  onChange(fn: (connectorId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isOnline(connectorId: string): boolean {
    return this.sessions.has(connectorId);
  }

  tools(connectorId: string): ToolDef[] {
    return this.sessions.get(connectorId)?.tools ?? [];
  }

  call(connectorId: string, tool: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const session = this.sessions.get(connectorId);
    if (!session) return Promise.resolve({ text: `Connectorn "${connectorId}" är offline`, isError: true });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        resolve({ text: "Timeout – connectorn svarade inte", isError: true });
      }, CALL_TIMEOUT_MS);
      session.pending.set(id, (out) => {
        clearTimeout(timer);
        resolve(out);
      });
      session.ws.send(JSON.stringify({ type: "call", id, tool, input } satisfies HubMessage));
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.ws.close(1001, "server shutdown");
    this.wss.close();
  }
}
