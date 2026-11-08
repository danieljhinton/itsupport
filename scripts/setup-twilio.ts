// Points your Twilio number's voice webhook at {PUBLIC_URL}/twiml.
//   npm run setup:twilio
import twilio from "twilio";
import { config } from "../src/config.js";

const cfg = config();
if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_PHONE_NUMBER || !cfg.PUBLIC_URL) {
  console.error("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER and PUBLIC_URL in .env first.");
  process.exit(1);
}

const client = twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN);
const [number] = await client.incomingPhoneNumbers.list({ phoneNumber: cfg.TWILIO_PHONE_NUMBER, limit: 1 });
if (!number) {
  console.error(`${cfg.TWILIO_PHONE_NUMBER} isn't on this Twilio account. Buy an AU number first (see README).`);
  process.exit(1);
}

const voiceUrl = `${cfg.PUBLIC_URL.replace(/\/$/, "")}/twiml`;
await client.incomingPhoneNumbers(number.sid).update({ voiceUrl, voiceMethod: "POST" });
console.log(`${number.phoneNumber} now sends calls to ${voiceUrl}`);
