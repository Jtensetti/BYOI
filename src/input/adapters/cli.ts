// CLI adapter: wrap command-line tools (legacy systems, vendor CLIs, scripts).
// Commands run with execFile – never through a shell – so input can't inject commands.
import { execFile } from "node:child_process";
import path from "node:path";
import type { ManifestOf } from "../manifest.ts";
import { clip, paramsSchema } from "./http.ts";
import type { Adapter, AdapterContext, ToolDef, ToolOutput } from "./types.ts";

type Command = ManifestOf<"cli">["commands"][number];

/** Fills "{param}" placeholders. A lone placeholder with no value is dropped; arrays expand. */
export function buildArgs(template: string[], input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const arg of template) {
    const lone = arg.match(/^\{(\w+)\}$/);
    if (lone) {
      const v = input[lone[1]];
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) out.push(...v.map(String));
      else out.push(typeof v === "object" ? JSON.stringify(v) : String(v));
      continue;
    }
    out.push(arg.replace(/\{(\w+)\}/g, (_, k) => (input[k] === undefined ? "" : String(input[k]))));
  }
  return out;
}

export class CliAdapter implements Adapter {
  constructor(private manifest: ManifestOf<"cli">, private ctx: AdapterContext) {}

  async connect(): Promise<void> {}

  listTools(): ToolDef[] {
    return this.manifest.commands.map((c) => ({
      name: c.name,
      description: c.description,
      inputSchema: paramsSchema(c.params),
      confirm: c.confirm,
    }));
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const cmd = this.manifest.commands.find((c) => c.name === name);
    if (!cmd) return { text: `Okänt kommando: ${name}`, isError: true };
    return this.run(cmd, input);
  }

  private run(cmd: Command, input: Record<string, unknown>): Promise<ToolOutput> {
    const args = buildArgs(cmd.args, input);
    const cwd = path.resolve(this.ctx.baseDir, this.manifest.cwd ?? ".");
    return new Promise((resolve) => {
      const child = execFile(
        cmd.command,
        args,
        { cwd, env: { ...process.env, ...this.manifest.env }, timeout: this.manifest.timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: false },
        (err, stdout, stderr) => {
          const code = err && "code" in err ? err.code : 0;
          const text = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`, `exit: ${err?.killed ? "timeout" : code}`].filter(Boolean).join("\n");
          resolve({ text: clip(text), isError: Boolean(err) });
        },
      );
      if (cmd.stdin) {
        child.stdin?.end(buildArgs([cmd.stdin], input)[0] ?? "");
      } else {
        child.stdin?.end();
      }
    });
  }

  async close(): Promise<void> {}
}
