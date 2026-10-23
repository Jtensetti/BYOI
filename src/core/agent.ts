// The LLM layer: a streaming Claude tool-use loop over the registry.
// Conversations are append-only (never rewrite earlier turns).
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Registry } from "./registry.ts";
import type { Skill } from "./skills.ts";

export const MODEL = process.env.BYOI_MODEL ?? "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 25;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "approval_required"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; preview: string }
  | { type: "notice"; message: string }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

/** Pending human approvals for tools marked `confirm`. */
export class Approvals {
  private pending = new Map<string, (ok: boolean) => void>();

  wait(toolUseId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(toolUseId, false), APPROVAL_TIMEOUT_MS);
      this.pending.set(toolUseId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  resolve(toolUseId: string, approved: boolean): boolean {
    const fn = this.pending.get(toolUseId);
    if (!fn) return false;
    this.pending.delete(toolUseId);
    fn(approved);
    return true;
  }
}

function systemPrompt(registry: Registry, skills: Skill[]): string {
  const ready = registry.integrations.filter((i) => i.status === "ready");
  const readyIds = new Set(ready.map((i) => i.id));
  const usable = skills.filter((s) => s.integrations.every((id) => readyIds.has(id)));

  return [
    "Du är assistenten i BYOI, en plattform där användaren kopplar in sina egna system",
    "(API:er, MCP-servrar, egen kod) och arbetar med dem via chatt.",
    "Svara på samma språk som användaren. Var konkret och kortfattad.",
    "Använd verktygen för att hämta riktig data i stället för att gissa. Om inget verktyg",
    "kan göra det användaren ber om, säg det. Verktyg som ändrar data kräver användarens",
    "godkännande; om ett anrop nekas, fortsätt utan det och förklara vad som inte gjordes.",
    "",
    "## Anslutna integrationer",
    ready.length
      ? ready.map((i) => `- ${i.id}: ${i.name}${i.description ? ` – ${i.description}` : ""}`).join("\n")
      : "(inga ännu)",
    "",
    "## Skills",
    usable.length
      ? "Läs in en skill med load_skill när frågan matchar:\n" +
        usable.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "(inga)",
  ].join("\n");
}

/** The slice of the Anthropic client the agent uses (lets tests pass a fake). */
export type LlmClient = Pick<Anthropic, "beta">;

export class Agent {
  private conversations = new Map<string, BetaMessageParam[]>();
  private running = new Set<string>();

  constructor(
    private registry: Registry,
    private getSkills: () => Skill[],
    public approvals = new Approvals(),
    private client: LlmClient = new Anthropic(),
  ) {}

  history(conversationId: string): BetaMessageParam[] {
    return this.conversations.get(conversationId) ?? [];
  }

  async run(conversationId: string, userText: string, emit: (e: AgentEvent) => void): Promise<void> {
    if (this.running.has(conversationId)) {
      emit({ type: "error", message: "Konversationen svarar redan på ett meddelande." });
      return;
    }
    this.running.add(conversationId);
    const messages = this.conversations.get(conversationId) ?? [];
    this.conversations.set(conversationId, messages);
    messages.push({ role: "user", content: userText });

    try {
      const stopReason = await this.loop(messages, emit);
      emit({ type: "done", stopReason });
    } catch (err) {
      emit({ type: "error", message: describeError(err) });
    } finally {
      // Keep user/assistant alternation intact if the turn ended early.
      if (messages.at(-1)?.role === "user") {
        messages.push({ role: "assistant", content: "[Svaret avbröts.]" });
      }
      this.running.delete(conversationId);
    }
  }

  private async loop(messages: BetaMessageParam[], emit: (e: AgentEvent) => void): Promise<string | null> {
    const tools: BetaTool[] = this.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      eager_input_streaming: true,
    }));
    const system = systemPrompt(this.registry, this.getSkills());
    let jsonRetries = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = this.client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // re-run on a fallback model if a safety classifier declines
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system,
        tools,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") emit({ type: "text", delta: event.delta.text });
          else if (event.delta.type === "thinking_delta") emit({ type: "thinking", delta: event.delta.thinking });
        }
      }

      let message: BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming a tool input can arrive as broken JSON. Re-issue that turn only.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        emit({ type: "notice", message: "Verktygsanropet kom trasigt, försöker igen…" });
        continue;
      }

      if (message.stop_reason === "refusal") {
        emit({ type: "notice", message: "Modellen avböjde den här förfrågan." });
        return "refusal";
      }

      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        throw new Error("Verktygsanropet blev för långt och kapades (max_tokens).");
      }

      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (toolUses.length === 0) return message.stop_reason;

      // Run all tool calls from this turn in parallel; return every result in one user message.
      const results = await Promise.all(toolUses.map((use) => this.runTool(use, emit)));
      messages.push({ role: "user", content: results });
    }
    emit({ type: "notice", message: `Stoppade efter ${MAX_TOOL_ROUNDS} verktygsrundor.` });
    return "max_rounds";
  }

  private async runTool(use: BetaToolUseBlock, emit: (e: AgentEvent) => void): Promise<BetaToolResultBlockParam> {
    emit({ type: "tool_call", id: use.id, name: use.name, input: use.input });
    const tool = this.registry.get(use.name);

    if (tool?.confirm) {
      const decision = this.approvals.wait(use.id); // register before telling the UI
      emit({ type: "approval_required", id: use.id, name: use.name, input: use.input });
      const approved = await decision;
      if (!approved) {
        emit({ type: "tool_result", id: use.id, name: use.name, isError: true, preview: "Nekad av användaren" });
        return { type: "tool_result", tool_use_id: use.id, is_error: true, content: "Användaren nekade anropet." };
      }
    }

    const out = await this.registry.call(use.name, use.input);
    emit({ type: "tool_result", id: use.id, name: use.name, isError: Boolean(out.isError), preview: out.text.slice(0, 400) });
    return { type: "tool_result", tool_use_id: use.id, is_error: out.isError, content: out.text || "(tomt svar)" };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Ogiltig eller saknad ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limit nådd – försök igen om en stund.";
  if (err instanceof Anthropic.BadRequestError) return `Felaktig förfrågan: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API-fel ${err.status}: ${err.message}`;
  return (err as Error).message ?? String(err);
}
