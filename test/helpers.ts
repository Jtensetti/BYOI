import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { LlmClient } from "../src/core/agent.ts";

export const fixtures = path.resolve("test/fixtures");

/** Creates an app over a temp integrations dir (inside the project so node_modules resolves). */
export async function makeApp(manifests: Record<string, string>, opts: { llmClient?: LlmClient; anthropic?: any } = {}) {
  const dir = fs.mkdtempSync(path.resolve("test/.tmp-"));
  const integrationsDir = path.join(dir, "integrations");
  fs.mkdirSync(integrationsDir);
  for (const [name, text] of Object.entries(manifests)) fs.writeFileSync(path.join(integrationsDir, `${name}.yaml`), text);
  const app = await createApp({ integrationsDir, skillsDir: "skills", secretsFile: path.join(dir, "secrets.json"), ...opts });
  return {
    app,
    dir,
    integrationsDir,
    async cleanup() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function status(app: App, id: string) {
  return app.registry.integrations.find((i) => i.id === id);
}

/** A scripted stand-in for Claude's streaming API. */
export function fakeClaude(script: any[], calls: any[] = []): LlmClient {
  return {
    beta: {
      messages: {
        stream(params: any) {
          calls.push(structuredClone(params));
          const message = script.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "(slut på manus)" }] };
          const events = message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: b.text } }));
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as LlmClient;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout i until()");
    await wait(20);
  }
}
