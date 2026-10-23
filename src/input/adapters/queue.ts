// Queue adapter: MQTT, AMQP (RabbitMQ) and Kafka. Subscribed messages become
// events (readable as a tool, optionally triggering the agent); publishing is a tool.
import { formatEvents } from "../../core/events.ts";
import type { ManifestOf } from "../manifest.ts";
import { type Adapter, type AdapterContext, recentEventsTool, type ToolDef, type ToolOutput } from "./types.ts";

interface Bus {
  publish(topic: string, message: string): Promise<void>;
  close(): Promise<void>;
}

async function optionalImport(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`Drivrutinen "${name}" är inte installerad. Kör: npm install ${name}`);
  }
}

function decode(buf: Buffer | string): unknown {
  const text = buf.toString();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class QueueAdapter implements Adapter {
  private bus!: Bus;

  constructor(private manifest: ManifestOf<"queue">, private ctx: AdapterContext) {}

  private onMessage = (source: string, payload: unknown) =>
    this.ctx.events.publish(this.ctx.integrationId, source, payload, this.manifest.keep, this.manifest.trigger);

  async connect(): Promise<void> {
    const m = this.manifest;
    if (m.driver === "mqtt") {
      const mqtt = await import("mqtt");
      const client = await mqtt.connectAsync(m.url, { connectTimeout: 10_000, reconnectPeriod: 2_000, ...(m.options as object) });
      client.on("message", (topic, msg) => this.onMessage(topic, decode(msg)));
      if (m.subscribe.length) await client.subscribeAsync(m.subscribe);
      this.bus = {
        publish: async (topic, message) => void (await client.publishAsync(topic, message)),
        close: () => client.endAsync(),
      };
    } else if (m.driver === "amqp") {
      const amqp = await optionalImport("amqplib");
      const conn = await amqp.connect(m.url);
      const ch = await conn.createChannel();
      for (const q of m.subscribe) {
        await ch.assertQueue(q, { durable: true });
        await ch.consume(q, (msg: any) => {
          if (!msg) return;
          this.onMessage(q, decode(msg.content));
          ch.ack(msg);
        });
      }
      this.bus = {
        publish: async (queue, message) => void ch.sendToQueue(queue, Buffer.from(message), { persistent: true }),
        close: async () => conn.close(),
      };
    } else {
      const { Kafka } = await optionalImport("kafkajs");
      const kafka = new Kafka({ clientId: `byoi-${this.ctx.integrationId}`, brokers: m.url.split(","), ...(m.options as object) });
      const producer = kafka.producer();
      await producer.connect();
      let consumer: any;
      if (m.subscribe.length) {
        consumer = kafka.consumer({ groupId: `byoi-${this.ctx.integrationId}` });
        await consumer.connect();
        for (const topic of m.subscribe) await consumer.subscribe({ topic });
        await consumer.run({ eachMessage: async ({ topic, message }: any) => this.onMessage(topic, decode(message.value ?? "")) });
      }
      this.bus = {
        publish: async (topic, message) => void (await producer.send({ topic, messages: [{ value: message }] })),
        close: async () => {
          await consumer?.disconnect();
          await producer.disconnect();
        },
      };
    }
  }

  listTools(): ToolDef[] {
    const tools: ToolDef[] = [recentEventsTool()];
    if (this.manifest.publish.length) {
      const any = this.manifest.publish.includes("*");
      tools.push({
        name: "publish",
        description: `Publicerar ett meddelande (${this.manifest.driver}).`,
        inputSchema: {
          type: "object",
          properties: {
            topic: any ? { type: "string" } : { type: "string", enum: this.manifest.publish },
            message: { description: "Text eller JSON-objekt" },
          },
          required: ["topic", "message"],
        },
        confirm: true,
      });
    }
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    if (name === "recent_events") {
      return { text: formatEvents(this.ctx.events.recent(this.ctx.integrationId, Number(input.limit ?? 10), input.source as string | undefined)) };
    }
    if (name === "publish" && this.manifest.publish.length) {
      const topic = String(input.topic);
      if (!this.manifest.publish.includes("*") && !this.manifest.publish.includes(topic)) return { text: `Får inte publicera till ${topic}`, isError: true };
      const message = typeof input.message === "string" ? input.message : JSON.stringify(input.message);
      await this.bus.publish(topic, message);
      return { text: `Publicerat till ${topic}` };
    }
    return { text: `Okänt verktyg: ${name}`, isError: true };
  }

  statusMessage(): string {
    return `${this.manifest.driver} · ${this.ctx.events.count(this.ctx.integrationId)} meddelanden`;
  }

  async close(): Promise<void> {
    await this.bus?.close();
  }
}
