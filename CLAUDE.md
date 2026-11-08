# CLAUDE.md

Persistent project notes for Claude Code sessions. Keep this file current: update it when a decision, convention or status changes.

## What this is
A proof-of-concept for **HaloITSM** customers that shows what Halo's MCP server can do. A caller rings an Australian Twilio number. A Claude agent tries to resolve their IT issue over the phone, using the Halo MCP server live (KB articles, the caller's open tickets, their assets). If it can't resolve the issue, it logs a ticket. A live web dashboard shows the transcript and every MCP tool call, for screen-share demos.

## Agreed decisions (from planning, 2026-11-08)
- **Stack:** Node.js + TypeScript (ESM, `tsx` to run, `tsc --noEmit` to typecheck), Fastify, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `twilio`, `zod`, `vitest`.
- **Voice:** Twilio **ConversationRelay**. Twilio does STT and TTS; our server exchanges text over a websocket at `/relay`. Language `en-AU`.
- **LLM:** Claude via the Anthropic API. Model comes from env `CLAUDE_MODEL` (default `claude-opus-5-5`, effort `low` for latency). Thinking can't be disabled on Opus 5.5; effort is the latency control. Server-side refusal fallback is on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- **Halo MCP:** hosted Halo MCP endpoint, authenticated with Halo **API client credentials** (OAuth `client_credentials`). The app is the MCP client (client-side MCP, *not* Anthropic's MCP connector), so it can enforce the tool allowlist, send calls to the dashboard and trim results.
- **Caller identification:** caller ID lookup in Halo first; if there's no match or more than one, the agent asks for name/email.
- **Halo write policy:** the agent may (1) create tickets: open if unresolved, closed if resolved on the call (for reporting); (2) add notes to the caller's existing tickets. **No other writes.** Enforced in code by `config/tool-policy.json` plus `src/agent/tools.ts`. Read-only tools are allowed when the MCP tool is annotated `readOnlyHint` or listed as `read`.
- **Hosting:** local + ngrok for demos, with a Dockerfile for later.
- **Twilio:** account exists, **AU number not bought yet** (it needs an approved Australian Regulatory Bundle, which can take days).
- **Interim calling (decided 2026-11-08):** use **browser calling** with the Twilio Voice JS SDK from the dashboard ("Call the agent" button) until the AU number arrives. It goes through a TwiML App → the same `/twiml` → ConversationRelay path. Browser calls have no caller ID, so the dashboard sends a demo number (`demoFrom` → TwiML `<Parameter name="callerNumber">` → `setup.customParameters.callerNumber`). `callerNumberFor()` honours it **only** for `client:` callers.

## Conventions
- **Commit and push to GitHub (`origin` = github.com/danieljhinton/itsupport, branch `main`) after each meaningful milestone.** The user asked for this.
- Conversation history is **append-only**. Never edit or delete earlier turns (preserved thinking on newer Claude models rejects edited history). Interrupt handling adds a note to the *next* user message instead of trimming the earlier assistant turn.
- Keep the system prompt and tool list byte-stable across calls (prompt caching). Per-call context (caller ID, identified user) goes in messages, not `system`.
- Speech output: no markdown, URLs or lists. Short sentences.
- Secrets live in `.env` (gitignored). `.env.example` documents every variable.

## Layout
- `src/server.ts`: Fastify routes `/twiml`, `/relay` (ws), `/dashboard`, `/events` (SSE), `/token` (Voice SDK access token), `/vendor/twilio-voice.min.js`, `/health`
- `src/twilio/`: TwiML builder + ConversationRelay websocket handler
- `src/agent/`: `session.ts` (streaming tool loop, interrupts), `prompt.ts`, `tools.ts` (policy + MCP→Claude tool mapping)
- `src/halo/`: `auth.ts` (token cache), `mcp.ts` (MCP client), `identify.ts` (caller lookup)
- `src/events/bus.ts`: per-call events for the dashboard
- `public/dashboard.html`: live demo dashboard
- `scripts/`: `list-halo-tools.ts`, `chat-cli.ts` (text REPL, no phone needed), `setup-twilio.ts`

## Commands
- `npm run dev`: start the server with reload
- `npm run typecheck` / `npm test`
- `npm run list-tools`: print the Halo MCP tool catalogue (use it to fill `config/tool-policy.json`)
- `npm run chat`: talk to the agent in the terminal (full Halo MCP, no Twilio)
- `npm run setup:twilio`: point the AU number's voice webhook at `${PUBLIC_URL}/twiml`

## Status / open items
- [x] Plan approved; scaffold + config
- [x] Halo auth + MCP client + tool policy; **real Halo MCP tool names not yet confirmed**. Run `npm run list-tools` against the instance and update `config/tool-policy.json`
- [x] Agent session + prompt + tools; chat CLI (not yet run against live Halo)
- [x] Twilio TwiML + relay (smoke-tested locally; not yet on a real call)
- [x] Dashboard
- [x] README, Dockerfile, unit tests (`test/unit.test.ts`, 13 passing)
- [x] Browser calling from the dashboard (smoke-tested: token, TwiML params, scripts; not yet on a real Twilio account)

### Next steps (need the user's credentials / accounts)
1. Fill `.env` with real Halo, Anthropic and Twilio values.
2. `npm run list-tools` → adjust `config/tool-policy.json` rule names, `ticketIdArg` and the `identify` tool to the real Halo MCP tool names.
3. `npm run chat` through the demo scenarios in README; tune `src/agent/prompt.ts`.
4. Browser calling: create a Twilio API key + TwiML App (Voice URL `{PUBLIC_URL}/twiml`), set `TWILIO_API_KEY_SID/SECRET`, `TWILIO_TWIML_APP_SID`, `DEMO_CALLER_NUMBER` → click **Call the agent** on the dashboard (latency, barge-in).
5. Later: Twilio AU Regulatory Bundle → buy number → `npm run setup:twilio` → real phone call test. No code changes needed.

### Known limitations / ideas
- The end-of-call hang-up waits an estimated TTS duration (~70 ms/char) before sending `{type:"end"}`.
- `transfer_to_human` is a stub (logs to the dashboard; it could use a TwiML `<Dial>` via `handoffData` + action URL).
- Ticket IDs for the add_note guard are found heuristically in tool results (`policy.ts › collectTicketIds`). Check this against real Halo result shapes.
- Sessions and dashboard history are in memory only.
