import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { bus } from "../events/bus.js";
import { callHaloTool } from "../halo/mcp.js";
import { collectTicketIds } from "./policy.js";
import { compactResult, LOCAL_TOOLS, type AgentTool } from "./tools.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** Where the agent's words go: Twilio ConversationRelay or the terminal. */
export interface CallChannel {
  /** Stream a chunk of speech. `last` marks the end of the current reply. */
  speak(token: string, last: boolean): void;
  /** Hang up / end the session. */
  end(handoff?: Record<string, unknown>): void;
}

const MAX_TOOL_ROUNDS = 10;
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

let anthropic: Anthropic | undefined;
const client = () => (anthropic ??= new Anthropic());

/**
 * One phone call. History is append-only: interrupts and corrections are added as
 * notes in the next user message, never by editing earlier turns.
 */
export class CallSession {
  readonly callId: string;
  private readonly tools: AgentTool[];
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly channel: CallChannel;

  private history: MessageParam[] = [];
  /** Content for the next user message (tool results, caller speech, notes). */
  private pending: ContentParam[] = [];
  private running = false;
  private ended = false;
  private abort?: AbortController;
  private streaming = false;
  private spoken = "";
  private heardBeforeInterrupt?: string;
  private turnStartedAt = 0;
  /** After a barge-in, hold off until the caller's words arrive. */
  private waitForCaller = false;
  private callerSeq = 0;
  /** Tickets seen or created on this call; add_note is limited to these. */
  private knownTickets = new Set<string>();
  /** Tickets created on this call; close_ticket is limited to these. */
  private createdTickets = new Set<string>();

  private readonly system: string;

  constructor(opts: { callId: string; tools: AgentTool[]; system: string; channel: CallChannel; contextNote?: string }) {
    this.callId = opts.callId;
    this.system = opts.system;
    this.tools = opts.tools;
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
    this.channel = opts.channel;
    if (opts.contextNote) this.pending.push({ type: "text", text: `[${opts.contextNote}]` });
  }

  /** Add context before the caller's first words (e.g. a late caller lookup result). */
  addNote(note: string): void {
    this.pending.push({ type: "text", text: `[${note}]` });
  }

  /** The caller finished saying something. */
  onCallerSpeech(text: string): void {
    if (this.ended || !text.trim()) return;
    bus.publish(this.callId, { type: "transcript", role: "caller", text });
    this.pending.push({ type: "text", text });
    this.callerSeq++;
    this.waitForCaller = false;
    this.turnStartedAt = Date.now();
    if (!this.running) void this.run();
  }

  /** The caller talked over the agent. `heard` is what TTS had played before the barge-in. */
  onInterrupt(heard?: string): void {
    if (this.streaming) {
      this.heardBeforeInterrupt = heard ?? this.spoken;
      this.abort?.abort();
    } else if (heard) {
      this.pending.push({
        type: "text",
        text: `[The caller interrupted you. They only heard this much of your last reply: "${heard}"]`,
      });
    }
  }

  /** Call disconnected. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.abort?.abort();
    bus.publish(this.callId, { type: "call_ended" });
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      let rounds = 0;
      while (!this.ended && !this.waitForCaller && this.pending.length > 0) {
        if (rounds++ > MAX_TOOL_ROUNDS) {
          this.say("Sorry, that's taking longer than expected. Let me log a ticket so a technician can follow up.");
          this.pending = [];
          break;
        }
        await this.step();
      }
    } catch (err) {
      console.error(`[${this.callId}] agent error`, err);
      bus.publish(this.callId, { type: "status", message: `Agent error: ${String(err)}` });
      this.say("Sorry, I'm having trouble with my systems right now. Please try again shortly or contact the service desk another way.");
    } finally {
      this.running = false;
    }
  }

  /** One model request, plus any tool calls it asks for. */
  private async step(): Promise<void> {
    // tool_result blocks must come first in a user message.
    const content = [
      ...this.pending.filter((b) => b.type === "tool_result"),
      ...this.pending.filter((b) => b.type !== "tool_result"),
    ];
    this.pending = [];
    this.history.push({ role: "user", content });

    const cfg = config();
    this.abort = new AbortController();
    this.streaming = true;
    this.spoken = "";
    this.heardBeforeInterrupt = undefined;
    let firstToken = true;
    const seqAtStart = this.callerSeq;

    const stream = client().beta.messages.stream(
      {
        model: cfg.CLAUDE_MODEL,
        max_tokens: 8000,
        betas: BETAS,
        fallbacks: "default",
        output_config: { effort: cfg.CLAUDE_EFFORT },
        cache_control: { type: "ephemeral" },
        system: this.system,
        tools: this.tools.map((t) => t.definition),
        messages: this.history,
      },
      { signal: this.abort.signal },
    );
    stream.on("text", (delta) => {
      if (firstToken && this.turnStartedAt) {
        bus.publish(this.callId, { type: "latency", firstTokenMs: Date.now() - this.turnStartedAt });
      }
      firstToken = false;
      this.spoken += delta;
      this.channel.speak(delta, false);
    });

    let message: Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      this.streaming = false;
      if (this.abort.signal.aborted) return this.handleAbortedStream(content, seqAtStart);
      throw err;
    }
    this.streaming = false;
    if (this.spoken) {
      this.channel.speak("", true);
      bus.publish(this.callId, { type: "transcript", role: "agent", text: this.spoken.trim() });
    }

    if (message.stop_reason === "refusal") {
      const sorry = "Sorry, I can't help with that one. I can log a ticket for a technician if you'd like.";
      this.history.push({ role: "assistant", content: [{ type: "text", text: sorry }] });
      this.say(sorry);
      return;
    }

    this.history.push({ role: "assistant", content: echoContent(message) });

    const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (toolUses.length === 0) return;
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off at max_tokens can't be trusted; answer each call with an error.
      this.pending.push(...toolUses.map((t) => errorResult(t.id, "Tool input was truncated; try again with a shorter input.")));
      return;
    }

    const results = await Promise.all(toolUses.map((t) => this.runTool(t)));
    this.pending.unshift(...results);
  }

  private handleAbortedStream(sent: ContentParam[], seqAtStart: number): void {
    // The caller is mid-sentence: wait for their words unless they've already arrived.
    this.waitForCaller = this.callerSeq === seqAtStart;
    const heard = (this.heardBeforeInterrupt ?? this.spoken).trim();
    bus.publish(this.callId, { type: "transcript", role: "agent", text: heard || "(interrupted)", interrupted: true });
    if (heard) {
      // Record only what the caller actually heard, as a new assistant turn.
      this.history.push({ role: "assistant", content: [{ type: "text", text: `${heard} ...` }] });
      this.pending.unshift({ type: "text", text: "[The caller interrupted you at that point.]" });
    } else {
      // Nothing was said: the request never produced a turn, so resend its content with the new speech.
      this.history.pop();
      this.pending.unshift(...sent);
    }
  }

  private async runTool(use: ToolUse): Promise<ToolResult> {
    const tool = this.toolsByName.get(use.name);
    const started = Date.now();
    bus.publish(this.callId, {
      type: "tool_call",
      id: use.id,
      tool: tool?.mcpName ?? use.name,
      kind: tool?.policy.kind ?? "unknown",
      input: use.input,
    });
    const finish = (ok: boolean, result: unknown, block: ToolResult) => {
      bus.publish(this.callId, { type: "tool_result", id: use.id, tool: tool?.mcpName ?? use.name, ok, ms: Date.now() - started, result });
      return block;
    };

    if (!tool) return finish(false, "unknown tool", errorResult(use.id, `Unknown tool ${use.name}`));
    if (!tool.validate(use.input)) {
      const msg = `Invalid input: ${JSON.stringify(tool.validate.errors?.slice(0, 3))}`;
      return finish(false, msg, errorResult(use.id, msg));
    }
    const input = { ...(use.input as Record<string, unknown>) };
    for (const k of tool.policy.omitArgs ?? []) delete input[k];

    // Local tools
    if (!tool.mcpName) {
      if (tool.name === LOCAL_TOOLS.end_call) {
        this.scheduleEnd(input);
        return finish(true, "ending call", okResult(use.id, "Call will end after your last words are played."));
      }
      if (tool.name === LOCAL_TOOLS.transfer_to_human) {
        bus.publish(this.callId, { type: "status", message: `Transfer requested: ${String(input.reason)}` });
        const text = "Live transfer isn't enabled in this demo. Tell the caller a technician will call them back about the ticket.";
        return finish(true, text, okResult(use.id, text));
      }
    }

    // Policy: notes only on tickets already seen for this caller on this call.
    if (tool.policy.kind === "add_note") {
      if (!noteAllowed(tool.policy.ticketIdArg, input, this.knownTickets)) {
        const msg = "Policy: you can only add notes to this caller's tickets that you have already looked up on this call.";
        return finish(false, msg, errorResult(use.id, msg));
      }
    }

    // Policy: only close a ticket this call created (an issue resolved on the call).
    if (tool.policy.kind === "close_ticket") {
      if (!noteAllowed(tool.policy.ticketIdArg, input, this.createdTickets)) {
        const msg = "Policy: you can only close a ticket you created on this call.";
        return finish(false, msg, errorResult(use.id, msg));
      }
    }

    try {
      const res = await callHaloTool(tool.mcpName!, input);
      collectTicketIds(res.data, tool.mcpName!, this.knownTickets);
      if (!res.isError && tool.policy.kind === "create_ticket") this.recordTicket(res.data, res.text, "created");
      if (!res.isError && tool.policy.kind === "add_note") {
        this.recordTicket(undefined, String(input[tool.policy.ticketIdArg!]), "note_added");
      }
      if (!res.isError && tool.policy.kind === "close_ticket") {
        this.recordTicket(undefined, String(input[tool.policy.ticketIdArg!]), "closed");
      }
      const text = compactResult(res.text, res.data);
      return finish(!res.isError, res.data ?? res.text, res.isError ? errorResult(use.id, text) : okResult(use.id, text));
    } catch (err) {
      const msg = `Halo error: ${err instanceof Error ? err.message : String(err)}`;
      return finish(false, msg, errorResult(use.id, msg));
    }
  }

  private recordTicket(data: unknown, text: string, action: "created" | "note_added" | "closed"): void {
    const obj = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    const id = obj?.id ?? obj?.ticket_id ?? /\b(\d{2,})\b/.exec(text)?.[1];
    const ticketId = id === undefined ? undefined : String(id);
    if (ticketId) this.knownTickets.add(ticketId);
    if (ticketId && action === "created") this.createdTickets.add(ticketId);
    const web = config().HALO_WEB_URL?.replace(/\/$/, "");
    bus.publish(this.callId, {
      type: "ticket",
      action,
      ticketId,
      // Prefer the link Halo returns; otherwise build Halo's ticket URL (/ticket?id=N).
      url: typeof obj?.link === "string" ? obj.link : web && ticketId ? `${web}/ticket?id=${ticketId}` : undefined,
    });
  }

  private scheduleEnd(input: Record<string, unknown>): void {
    // Give TTS time to finish the goodbye (~15 characters per second).
    const delay = Math.min(10_000, Math.max(1_500, this.spoken.length * 70));
    bus.publish(this.callId, { type: "call_ended", outcome: String(input.outcome ?? ""), summary: input.summary as string });
    this.ended = true;
    setTimeout(() => this.channel.end({ outcome: input.outcome, summary: input.summary }), delay);
  }

  private say(text: string): void {
    this.channel.speak(text, true);
    bus.publish(this.callId, { type: "transcript", role: "agent", text });
  }
}

/**
 * Assistant content to keep in history. After a mid-output model fallback, blocks before
 * the last `fallback` marker that the next model can't use (thinking, tool_use) are dropped,
 * per the fallback replay rules. Everything else is kept unchanged.
 */
export function echoContent(message: Pick<Message, "content">): ContentParam[] {
  const blocks = message.content as unknown as ContentParam[];
  const lastFallback = blocks.map((b) => b.type as string).lastIndexOf("fallback");
  if (lastFallback < 0) return blocks;
  const drop = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);
  return blocks.filter((b, i) => i >= lastFallback || !drop.has(b.type));
}

/** add_note / close_ticket: the ticket ID argument must be in the allowed set for this call. */
export function noteAllowed(ticketIdArg: string | undefined, input: Record<string, unknown>, known: Set<string>): boolean {
  const id = ticketIdArg ? input[ticketIdArg] : undefined;
  return id !== undefined && id !== null && known.has(String(id));
}

function okResult(id: string, text: string): ToolResult {
  return { type: "tool_result", tool_use_id: id, content: text || "(empty result)" };
}

function errorResult(id: string, text: string): ToolResult {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}
