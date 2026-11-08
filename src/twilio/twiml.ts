import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import { config } from "../config.js";

// Per-process secret for signing the websocket URL handed to Twilio, so only
// calls that came through our /twiml webhook can open an agent session.
const relaySecret = randomBytes(32);

export function signCallSid(callSid: string): string {
  return createHmac("sha256", relaySecret).update(callSid).digest("base64url");
}

export function verifyCallSid(callSid: string | undefined, sig: string | undefined): boolean {
  if (!callSid || !sig) return false;
  const a = Buffer.from(signCallSid(callSid));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** TwiML that connects the call to our ConversationRelay websocket. */
export function conversationRelayTwiml(callSid: string, publicUrl: string): string {
  const cfg = config();
  const wsUrl = new URL("/relay", publicUrl.replace(/^http/, "ws"));
  wsUrl.searchParams.set("sig", signCallSid(callSid));

  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  connect.conversationRelay({
    url: wsUrl.toString(),
    welcomeGreeting: cfg.WELCOME_GREETING,
    language: "en-AU",
    ttsProvider: cfg.TTS_PROVIDER,
    voice: cfg.TTS_VOICE,
    transcriptionProvider: cfg.TRANSCRIPTION_PROVIDER,
    interruptible: "speech",
    welcomeGreetingInterruptible: "speech",
    dtmfDetection: true,
    hints: "Halo, HaloITSM, VPN, Outlook, Teams, OneDrive, SharePoint, MFA, Authenticator, laptop, printer, Wi-Fi",
  });
  return response.toString();
}

/** Check X-Twilio-Signature on a webhook request. */
export function validTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>): boolean {
  const token = config().TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  return twilio.validateRequest(token, signature, url, params);
}
