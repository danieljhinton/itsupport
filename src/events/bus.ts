import { EventEmitter } from "node:events";

export type CallEvent =
  | { type: "call_started"; from?: string; to?: string; channel: "phone" | "cli" }
  | { type: "caller_identified"; status: "matched" | "ambiguous" | "none" | "error"; user?: unknown; detail?: string }
  | { type: "transcript"; role: "caller" | "agent"; text: string; interrupted?: boolean }
  | { type: "tool_call"; id: string; tool: string; kind: string; input: unknown }
  | { type: "tool_result"; id: string; tool: string; ok: boolean; ms: number; result: unknown }
  | { type: "ticket"; action: "created" | "note_added"; ticketId?: string; url?: string }
  | { type: "latency"; firstTokenMs: number }
  | { type: "status"; message: string }
  | { type: "call_ended"; outcome?: string; summary?: string };

export type BusEvent = CallEvent & { callId: string; ts: number };

const HISTORY_LIMIT = 2000;

/** In-memory event stream that feeds the live dashboard. */
class Bus extends EventEmitter {
  private history: BusEvent[] = [];

  publish(callId: string, event: CallEvent): void {
    const e = { ...event, callId, ts: Date.now() } as BusEvent;
    this.history.push(e);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.emit("event", e);
  }

  recent(): BusEvent[] {
    return [...this.history];
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
