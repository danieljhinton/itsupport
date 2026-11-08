// Checks the Twilio settings in .env without printing any secrets.
//   npm run check:twilio
import "dotenv/config";
import twilio from "twilio";

const env = (k: string) => process.env[k]?.trim() || undefined;
const mask = (v?: string) => (v ? `${v.slice(0, 4)}…${v.slice(-4)}` : "(not set)");
let failures = 0;
const ok = (msg: string) => console.log(`  OK    ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const why = (err: unknown) => {
  const e = err as { status?: number; code?: number; message?: string };
  return [e.status && `HTTP ${e.status}`, e.code && `Twilio error ${e.code}`, e.message].filter(Boolean).join(" - ");
};

const accountSid = env("TWILIO_ACCOUNT_SID");
const authToken = env("TWILIO_AUTH_TOKEN");
const keySid = env("TWILIO_API_KEY_SID");
const keySecret = env("TWILIO_API_KEY_SECRET");
const appSid = env("TWILIO_TWIML_APP_SID");
const publicUrl = env("PUBLIC_URL")?.replace(/\/$/, "");

console.log("Twilio settings check\n");

// 1. Shape of each value
const shapes: [string, string | undefined, RegExp][] = [
  ["TWILIO_ACCOUNT_SID", accountSid, /^AC[0-9a-f]{32}$/],
  ["TWILIO_AUTH_TOKEN", authToken, /^[0-9a-f]{32}$/],
  ["TWILIO_API_KEY_SID", keySid, /^SK[0-9a-f]{32}$/],
  ["TWILIO_API_KEY_SECRET", keySecret, /^\S{20,}$/],
  ["TWILIO_TWIML_APP_SID", appSid, /^AP[0-9a-f]{32}$/],
];
console.log("Format");
for (const [name, value, re] of shapes) {
  if (!value) bad(`${name} is empty`);
  else if (!re.test(value)) bad(`${name} doesn't look right (${mask(value)}); check for spaces, quotes or a swapped value`);
  else ok(`${name} ${name.includes("SECRET") || name.includes("TOKEN") ? "set" : mask(value)}`);
}

// 2. Account SID + auth token
console.log("\nAccount");
if (accountSid && authToken) {
  try {
    const client = twilio(accountSid, authToken);
    const acct = await client.api.v2010.accounts(accountSid).fetch();
    ok(`Signed in to "${acct.friendlyName}" (status: ${acct.status}, type: ${acct.type})`);
    if (acct.type === "Trial") console.log("        Note: trial account. Calls start with a short Twilio trial message.");

    // 3. API key belongs to this account
    if (keySid) {
      try {
        const key = await client.keys(keySid).fetch();
        ok(`API key "${key.friendlyName}" exists on this account`);
      } catch (err) {
        bad(`API key ${mask(keySid)} not found on this account (${why(err)})`);
      }
    }

    // 4. TwiML App and its Voice URL
    if (appSid) {
      try {
        const app = await client.applications(appSid).fetch();
        ok(`TwiML App "${app.friendlyName}" exists`);
        const expected = publicUrl ? `${publicUrl}/twiml` : undefined;
        if (!app.voiceUrl) bad("TwiML App has no Voice Request URL");
        else if (expected && app.voiceUrl !== expected) bad(`TwiML App Voice URL is ${app.voiceUrl}, expected ${expected}`);
        else ok(`TwiML App Voice URL is ${app.voiceUrl}`);
        if (app.voiceMethod?.toUpperCase() !== "POST") bad(`TwiML App Voice method is ${app.voiceMethod}, should be POST`);
        else ok("TwiML App Voice method is POST");
      } catch (err) {
        bad(`TwiML App ${mask(appSid)} not found on this account (${why(err)})`);
      }
    }
  } catch (err) {
    bad(`Could not sign in with the Account SID and Auth Token (${why(err)})`);
  }
}

// 5. API key secret actually works
console.log("\nAPI key secret");
if (accountSid && keySid && keySecret) {
  try {
    await twilio(keySid, keySecret, { accountSid }).api.v2010.accounts(accountSid).fetch();
    ok("API key SID + secret authenticate");
  } catch (err) {
    bad(`API key SID + secret were rejected (${why(err)}). The secret is only shown once; create a new key if it's lost.`);
  }
}

// 6. Public URL reachable through ngrok
console.log("\nPublic URL");
if (!publicUrl) bad("PUBLIC_URL is empty");
else {
  try {
    const res = await fetch(`${publicUrl}/health`, {
      signal: AbortSignal.timeout(8000),
      headers: { "ngrok-skip-browser-warning": "1" }, // skip the free-plan browser warning page
    });
    const text = await res.text();
    const ngrokErr = /ERR_NGROK_(\d+)/.exec(text)?.[1];
    if (res.ok && text.includes('"ok"')) ok(`${publicUrl} reaches this app (${res.status})`);
    else if (ngrokErr === "8012") bad(`ngrok is running but the app isn't. Start it with \`npm run dev\`.`);
    else if (ngrokErr === "3200") bad(`ngrok endpoint is offline. Start ngrok: ngrok http 3000 --url=${new URL(publicUrl).host}`);
    else if (ngrokErr) bad(`ngrok returned ERR_NGROK_${ngrokErr} (see https://ngrok.com/docs/errors/err_ngrok_${ngrokErr})`);
    else bad(`${publicUrl}/health returned ${res.status}. Is \`npm run dev\` running?`);
  } catch (err) {
    bad(`Could not reach ${publicUrl} (${why(err)}). Is ngrok running?`);
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll Twilio checks passed.");
process.exitCode = failures ? 1 : 0; // not process.exit(): avoids a libuv assertion on Windows with open sockets
