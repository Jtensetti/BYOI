// Webhook adapter: systems that push to us. Each integration gets
// POST /hooks/<id>[/<anything>]. Signatures are verified before anything is stored.
import { createHmac } from "node:crypto";
import { safeEqual } from "../../core/auth.ts";
import { formatEvents } from "../../core/events.ts";
import type { ManifestOf } from "../manifest.ts";
import { type Adapter, type AdapterContext, recentEventsTool, type ToolDef, type ToolOutput } from "./types.ts";

export class WebhookAdapter implements Adapter {
  constructor(private manifest: ManifestOf<"webhook">, private ctx: AdapterContext) {}

  async connect(): Promise<void> {}

  /** Returns an HTTP status for the sender. */
  receive(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, subPath: string): { status: number; message: string } {
    const v = this.manifest.verify;
    const header = (name: string) => {
      const h = headers[name.toLowerCase()];
      return Array.isArray(h) ? h[0] : (h ?? "");
    };
    if (v.type === "hmac") {
      const expected = v.prefix + createHmac(v.algorithm, this.ctx.secrets.get(v.secret)).update(rawBody).digest(v.encoding);
      if (!safeEqual(header(v.header), expected)) return { status: 401, message: "Ogiltig signatur" };
    } else if (v.type === "token") {
      if (!safeEqual(header(v.header), this.ctx.secrets.get(v.secret))) return { status: 401, message: "Ogiltig token" };
    }

    const type = header("content-type");
    const text = rawBody.toString("utf8");
    let payload: unknown = text;
    if (type.includes("json")) {
      try {
        payload = JSON.parse(text);
      } catch {
        return { status: 400, message: "Ogiltig JSON" };
      }
    } else if (type.includes("x-www-form-urlencoded")) {
      payload = Object.fromEntries(new URLSearchParams(text));
    }
    this.ctx.events.publish(this.ctx.integrationId, subPath || "/", payload, this.manifest.keep, this.manifest.trigger);
    return { status: 202, message: "Mottaget" };
  }

  listTools(): ToolDef[] {
    return [recentEventsTool()];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    if (name !== "recent_events") return { text: `Okänt verktyg: ${name}`, isError: true };
    return { text: formatEvents(this.ctx.events.recent(this.ctx.integrationId, Number(input.limit ?? 10), input.source as string | undefined)) };
  }

  statusMessage(): string {
    return `POST /hooks/${this.ctx.integrationId} · ${this.ctx.events.count(this.ctx.integrationId)} händelser`;
  }

  async close(): Promise<void> {}
}
