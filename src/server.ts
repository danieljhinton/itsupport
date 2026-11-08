import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { agentSetup } from "./agent/index.js";
import { bus, type BusEvent } from "./events/bus.js";
import { closeHalo } from "./halo/mcp.js";
import { browserCallToken, callerNumberFor, conversationRelayTwiml, validTwilioSignature } from "./twilio/twiml.js";
import { handleRelaySocket } from "./twilio/relay.js";

const cfg = config();
const app = Fastify({ logger: { level: "info" }, trustProxy: true });
await app.register(formbody);
await app.register(websocket);

const dashboardHtml = readFileSync(fileURLToPath(new URL("../public/dashboard.html", import.meta.url)), "utf8");

function publicBase(req: FastifyRequest): string {
  return cfg.PUBLIC_URL ?? `${req.protocol}://${req.host}`;
}

function dashboardAllowed(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!cfg.DASHBOARD_TOKEN) return true;
  const token = (req.query as Record<string, string | undefined>).token;
  if (token === cfg.DASHBOARD_TOKEN) return true;
  void reply.code(401).send("Unauthorised: add ?token=...");
  return false;
}

app.get("/health", async () => {
  try {
    const { tools } = await agentSetup();
    return { ok: true, tools: tools.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Twilio voice webhook: answer the call and hand it to ConversationRelay.
app.post("/twiml", async (req, reply) => {
  const params = (req.body ?? {}) as Record<string, string>;
  if (cfg.TWILIO_VALIDATE_SIGNATURE) {
    const url = `${publicBase(req)}${req.url}`;
    if (!validTwilioSignature(req.headers["x-twilio-signature"] as string | undefined, url, params)) {
      req.log.warn({ url }, "invalid Twilio signature");
      return reply.code(403).send("Invalid signature");
    }
  }
  reply.type("text/xml");
  return conversationRelayTwiml(params.CallSid ?? "", publicBase(req), callerNumberFor(params));
});

// Voice access token for browser calls from the dashboard.
app.get("/token", async (req, reply) => {
  if (!dashboardAllowed(req, reply)) return;
  const token = browserCallToken("dashboard-demo");
  if (!token) {
    return reply.code(503).send({
      error: "Browser calling isn't configured. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_TWIML_APP_SID.",
    });
  }
  return { token, demoCallerNumber: cfg.DEMO_CALLER_NUMBER ?? "" };
});

// Twilio Voice JS SDK, served from node_modules (exposes window.Twilio.Device).
const voiceSdk = readFileSync(
  fileURLToPath(new URL("../node_modules/@twilio/voice-sdk/dist/twilio.min.js", import.meta.url)),
  "utf8",
);
app.get("/vendor/twilio-voice.min.js", async (_req, reply) => {
  reply.type("application/javascript").header("Cache-Control", "public, max-age=86400");
  return voiceSdk;
});

app.get("/relay", { websocket: true }, (socket, req) => {
  const sig = (req.query as Record<string, string | undefined>).sig;
  handleRelaySocket(socket, sig, (m) => req.log.info(m));
});

app.get("/", async (_req, reply) => reply.redirect("/dashboard"));

app.get("/dashboard", async (req, reply) => {
  if (!dashboardAllowed(req, reply)) return;
  reply.type("text/html");
  return dashboardHtml;
});

// Server-sent events feed for the dashboard: recent history, then live events.
app.get("/events", (req, reply) => {
  if (!dashboardAllowed(req, reply)) return;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (e: BusEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  for (const e of bus.recent()) write(e);
  bus.on("event", write);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    bus.off("event", write);
  });
});

// Load the Halo tool catalogue at startup so the first call doesn't wait for it.
agentSetup()
  .then(({ tools }) => app.log.info(`Halo MCP ready: ${tools.length} tools available to the agent`))
  .catch((err) => app.log.error(`Halo MCP not ready yet (will retry on first call): ${err}`));

const shutdown = async () => {
  await app.close();
  await closeHalo();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
app.log.info(`Dashboard: http://localhost:${cfg.PORT}/dashboard  |  Twilio webhook: ${cfg.PUBLIC_URL ?? "(set PUBLIC_URL)"}/twiml`);
