// Text-only test harness: talk to the agent in your terminal, with the real Halo MCP
// server but no Twilio. Shows tool calls inline.
//   npm run chat                     -> no caller ID
//   npm run chat -- --from +61412345678
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { agentSetup, CallSession } from "../src/agent/index.js";
import { bus } from "../src/events/bus.js";
import { identifyCaller, identifyNote } from "../src/halo/identify.js";
import { closeHalo } from "../src/halo/mcp.js";

const fromIdx = process.argv.indexOf("--from");
const from = fromIdx > 0 ? process.argv[fromIdx + 1] : undefined;

const { policy, tools } = await agentSetup();
console.log(`Loaded ${tools.length} tools: ${tools.map((t) => `${t.name}(${t.policy.kind})`).join(", ")}\n`);

const ident = await identifyCaller(from, policy);
console.log(`Caller lookup: ${ident.status}\n`);

const callId = `cli-${Date.now()}`;
const rl = createInterface({ input: stdin, output: stdout });
let done = false;
let speaking = false;

bus.on("event", (e) => {
  if (e.callId !== callId) return;
  if (e.type === "tool_call") console.log(`\n  -> ${e.tool} ${JSON.stringify(e.input)}`);
  if (e.type === "tool_result") console.log(`  <- ${e.tool} ${e.ok ? "ok" : "ERROR"} (${e.ms}ms)`);
  if (e.type === "ticket") console.log(`  ** ticket ${e.action}: ${e.ticketId ?? "?"} ${e.url ?? ""}`);
  if (e.type === "latency") console.log(`  (first token ${e.firstTokenMs}ms)`);
});

bus.publish(callId, { type: "call_started", from, channel: "cli" });

const session = new CallSession({
  callId,
  tools,
  contextNote: identifyNote(from, ident),
  channel: {
    speak(token, last) {
      if (!speaking) stdout.write("\nAgent: ");
      speaking = true;
      stdout.write(token);
      if (last) {
        stdout.write("\n");
        speaking = false;
      }
    },
    end(handoff) {
      console.log(`\n[call ended] ${JSON.stringify(handoff)}`);
      done = true;
      rl.close();
    },
  },
});

console.log("Type what the caller says. Ctrl+C to quit.\n");
rl.on("close", async () => {
  session.close();
  await closeHalo();
  process.exit(0);
});
while (!done) {
  const line = await rl.question("\nYou: ").catch(() => "");
  if (done) break;
  session.onCallerSpeech(line);
}
