// Events: things that happen *to* us (webhooks, queue messages). They are kept
// per integration, readable as a tool, and can trigger an automatic agent run.
import { randomUUID } from "node:crypto";
import type { Trigger } from "../input/manifest.ts";

export interface IntegrationEvent {
  id: string;
  integrationId: string;
  source: string;
  receivedAt: string;
  payload: unknown;
  run?: { conversationId: string; status: "running" | "done" | "error"; summary?: string };
}

type Listener = (event: IntegrationEvent, trigger: Trigger) => void;

export class EventBus {
  private store = new Map<string, IntegrationEvent[]>();
  private listeners = new Set<Listener>();

  publish(integrationId: string, source: string, payload: unknown, keep: number, trigger?: Trigger): IntegrationEvent {
    const event: IntegrationEvent = { id: randomUUID(), integrationId, source, receivedAt: new Date().toISOString(), payload };
    const list = this.store.get(integrationId) ?? [];
    list.unshift(event);
    list.length = Math.min(list.length, keep);
    this.store.set(integrationId, list);
    for (const fn of this.listeners) fn(event, trigger);
    return event;
  }

  recent(integrationId: string, limit = 10, source?: string): IntegrationEvent[] {
    return (this.store.get(integrationId) ?? []).filter((e) => !source || e.source === source).slice(0, limit);
  }

  count(integrationId: string): number {
    return this.store.get(integrationId)?.length ?? 0;
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function formatEvents(events: IntegrationEvent[]): string {
  if (!events.length) return "Inga händelser än.";
  return JSON.stringify(
    events.map(({ source, receivedAt, payload, run }) => ({ source, receivedAt, payload, ...(run ? { run } : {}) })),
    null,
    1,
  );
}
