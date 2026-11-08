import type { WebSocket } from "ws";
import { agentSetup, CallSession } from "../agent/index.js";
import { bus } from "../events/bus.js";
import { identifyCaller, identifyNote, type IdentifyResult } from "../halo/identify.js";
import { verifyCallSid } from "./twiml.js";

/** Messages ConversationRelay sends us (only the fields we use). */
export type RelayInbound =
  | { type: "setup"; sessionId: string; callSid: string; from?: string; to?: string; customParameters?: Record<string, string> }
  | { type: "prompt"; voicePrompt: string; lang?: string; last?: boolean }
  | { type: "interrupt"; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description?: string };

export function parseRelayMessage(raw: string): RelayInbound | undefined {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg.type === "string" ? (msg as RelayInbound) : undefined;
  } catch {
    return undefined;
  }
}

const IDENTIFY_TIMEOUT_MS = 5000;

/** Handle one ConversationRelay websocket (one phone call). */
export function handleRelaySocket(ws: WebSocket, sig: string | undefined, log: (msg: string) => void): void {
  let sessionPromise: Promise<CallSession> | undefined;
  let callId = "unknown";

  const send = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on("message", async (data) => {
    const msg = parseRelayMessage(data.toString());
    if (!msg) return;

    if (msg.type === "setup") {
      if (!verifyCallSid(msg.callSid, sig)) {
        log(`rejecting relay connection with bad signature for ${msg.callSid}`);
        ws.close(1008, "unauthorised");
        return;
      }
      callId = msg.callSid;
      bus.publish(callId, { type: "call_started", from: msg.from, to: msg.to, channel: "phone" });
      sessionPromise = startSession(callId, msg.from, send);
      sessionPromise.catch((err) => {
        log(`session setup failed: ${err}`);
        send({ type: "text", token: "Sorry, our IT systems are unavailable right now. Please try again later.", last: true });
        setTimeout(() => send({ type: "end" }), 5000);
      });
      return;
    }

    const session = await sessionPromise?.catch(() => undefined);
    if (!session) return;
    switch (msg.type) {
      case "prompt":
        if (msg.last !== false) session.onCallerSpeech(msg.voicePrompt);
        break;
      case "interrupt":
        session.onInterrupt(msg.utteranceUntilInterrupt);
        break;
      case "dtmf":
        session.onCallerSpeech(`[The caller pressed ${msg.digit} on their keypad]`);
        break;
      case "error":
        log(`ConversationRelay error: ${msg.description}`);
        bus.publish(callId, { type: "status", message: `Twilio error: ${msg.description}` });
        break;
    }
  });

  ws.on("close", async () => {
    const session = await sessionPromise?.catch(() => undefined);
    session?.close();
  });
}

async function startSession(callId: string, from: string | undefined, send: (obj: unknown) => void): Promise<CallSession> {
  const { policy, tools } = await agentSetup();
  // The welcome greeting is playing meanwhile, so this lookup is mostly hidden from the caller.
  const ident: IdentifyResult = await Promise.race([
    identifyCaller(from, policy),
    new Promise<IdentifyResult>((r) => setTimeout(() => r({ status: "error", detail: "lookup timed out" }), IDENTIFY_TIMEOUT_MS)),
  ]);
  bus.publish(callId, {
    type: "caller_identified",
    status: ident.status === "skipped" ? "none" : ident.status,
    user: ident.status === "matched" ? ident.user : undefined,
    detail: "detail" in ident ? ident.detail : undefined,
  });

  return new CallSession({
    callId,
    tools,
    contextNote: identifyNote(from, ident),
    channel: {
      speak: (token, last) => send({ type: "text", token, last }),
      end: (handoff) => send({ type: "end", handoffData: JSON.stringify(handoff ?? {}) }),
    },
  });
}
