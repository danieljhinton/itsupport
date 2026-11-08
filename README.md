# Halo Voice Agent (PoC)

A phone-based IT service desk agent that shows what the **HaloITSM MCP server** can do.

Ring an Australian number and talk to a Claude-powered agent. During the call it uses Halo through MCP to:

- identify the caller from their phone number (or by asking for name and email)
- look up their **open tickets** and **assets**
- search the **knowledge base** and walk them through a fix
- **log a ticket**: closed if the issue was fixed on the call, open with a full summary if not
- **add a note** to an existing ticket instead of creating a duplicate

A live **dashboard** shows the conversation and every Halo MCP call (inputs, results, timings) as it happens. It's built for screen-sharing in customer demos.

```
Caller ── PSTN ──▶ Twilio AU number ── webhook ──▶ POST /twiml
                        │
                        └── ConversationRelay (STT/TTS) ── wss ──▶ /relay ──▶ CallSession
                                                                         ├─ Claude (streaming + tools)
                                                                         ├─ Halo MCP (client credentials)
                                                                         └─ events ──▶ /dashboard
```

## Prerequisites

- Node.js 20+
- An **Anthropic API key**
- A **HaloITSM** instance with the MCP server enabled, and an API application using client credentials
- A **Twilio** account with an Australian voice number (see below)
- [ngrok](https://ngrok.com/) (or another tunnel) so Twilio can reach your machine

## 1. Install

```bash
npm install
cp .env.example .env
```

## 2. Halo

1. In Halo, go to **Configuration → Integrations → HaloITSM API → View Applications** and create an application:
   - Authentication method: **Client ID and Secret (Services)**
   - Log in as an agent account for the PoC (tickets will be logged as that agent)
   - Permissions: read users, tickets, assets and the knowledge base; create tickets and actions
2. Put the client ID/secret, auth URL (usually `https://<instance>/auth`) and MCP URL in `.env`.
3. List the MCP tools your instance exposes:

   ```bash
   npm run list-tools
   ```

4. Edit **`config/tool-policy.json`** so the rules match those tool names. The policy is the guardrail. Claude only sees tools that are:
   - read-only (matched as `read`, or marked `readOnlyHint` by the server)
   - ticket creation (`create_ticket`)
   - adding a note/action to a ticket (`add_note`); set `ticketIdArg` to the tool's ticket ID parameter

   Everything else (updates, closes, deletes, asset or user edits) is hidden from the agent. Notes are also limited in code to tickets the agent has already looked up, or created, on the current call.

   Optionally set `identify.tool` / `identify.args` to the user-search tool, so the caller is looked up by phone number while the greeting plays.

5. Test the agent end to end in your terminal, with no phone needed:

   ```bash
   npm run chat -- --from +61412345678
   ```

## 3. Twilio (Australian number)

Australian numbers need an approved **Regulatory Bundle**. Start this first, because approval can take a few business days.

1. Twilio Console → **Phone Numbers → Regulatory Compliance → Bundles → Create**. Choose Australia, your number type (Local or Mobile) and Business, then provide the business details and an Australian address.
2. Once it's approved, buy an AU number with **Voice** capability and assign the bundle.
3. Accept the AI/ML features addendum for ConversationRelay if the Console asks.
4. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` in `.env`.

## 4. Run it

```bash
ngrok http 3000                # copy the https URL into PUBLIC_URL in .env
npm run setup:twilio           # points the number's voice webhook at PUBLIC_URL/twiml
npm run dev                    # start the server
```

Open **http://localhost:3000/dashboard** and ring the number.

If you expose the dashboard through ngrok, set `DASHBOARD_TOKEN` and open `/dashboard?token=...`.

## Demo script

| Scenario | What to say | What the dashboard shows |
|---|---|---|
| Fixed on the call | "Outlook keeps asking for my password" | user lookup → tickets + assets in parallel → KB search → **closed ticket logged** |
| Needs a technician | "My laptop screen is cracked" | asset lookup → **open ticket** with asset, impact and steps tried → ticket number read back |
| Existing ticket | "I'm chasing my VPN ticket, it's still broken" | open tickets → **note added** to the existing ticket, no duplicate |
| Unknown number | call from a number not in Halo | agent asks for name and email → user search |

You can interrupt the agent at any point; it stops talking and listens.

## Configuration notes

- **Model:** `CLAUDE_MODEL` (default `claude-opus-5-5`) and `CLAUDE_EFFORT` (default `low`). For lower voice latency, try `claude-sonnet-5-5` or `claude-haiku-5-5`. The dashboard shows time-to-first-token for each turn.
- **Voice:** `TTS_PROVIDER` / `TTS_VOICE` (default Google `en-AU-Neural2-C`) and `TRANSCRIPTION_PROVIDER` (default Deepgram). The language is `en-AU`.
- **Refusal fallback:** requests opt in to Anthropic's server-side fallback (`fallbacks: "default"`). If the primary model declines, another model answers instead of the call going silent.
- **Prompt caching:** the system prompt and tool list are byte-stable, and automatic caching is on, so later turns reuse the cached prefix.

## Security

- `/twiml` checks Twilio's `X-Twilio-Signature` (turn off with `TWILIO_VALIDATE_SIGNATURE=false` for local testing only).
- The `/relay` websocket URL carries an HMAC of the CallSid, so only calls that came through `/twiml` can open an agent session.
- Halo credentials stay on the server. The model never sees them, and the tool policy limits what it can do.
- This is a PoC: state is in memory, there's one Halo service account, and the dashboard has no real auth beyond the optional token.

## Development

```bash
npm run typecheck
npm test
```

Docker: `docker build -t halo-voice-agent . && docker run --env-file .env -p 3000:3000 halo-voice-agent`

Project notes for Claude Code sessions live in [`CLAUDE.md`](CLAUDE.md).
