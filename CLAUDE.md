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
- `npm run check:twilio`: check Twilio creds, API key, TwiML App URL and the ngrok URL (prints no secrets)
- `npm run setup:twilio`: point the AU number's voice webhook at `${PUBLIC_URL}/twiml`

## Status / open items
- [x] Plan approved; scaffold + config
- [x] Halo auth + MCP client + tool policy, **matched to the real Halo catalogue** (22 tools) and tested live
- [x] Agent session + prompt + tools; chat CLI (not yet run end to end: needs ANTHROPIC_API_KEY)
- [x] Twilio TwiML + relay; browser calling from the dashboard. Twilio creds/API key/TwiML App verified with `npm run check:twilio`; signed webhook through ngrok accepted
- [x] Dashboard
- [x] README, Dockerfile, unit tests (`test/unit.test.ts`, 15 passing)

### Environment (user's setup, 2026-11-08)
- Halo (QA instance): `https://dhinternalitsm.itsm.haloqa.co.uk`, MCP at `/api/mcp`, auth at `/auth`. Client-credentials auth works.
- ngrok static domain: `https://mutiny-seldom-produce.ngrok-free.dev` (= `PUBLIC_URL`; the TwiML App "Halo" points at `/twiml`). The user's ngrok is older: use `--domain=`, or update for `--url=`.
- Twilio: full (paid) account; API key "API1"; TwiML App "Halo".
- Demo caller: **Brenda Ross**, `+61 3 9561 7232` (E.164 `+61395617232`, set as `DEMO_CALLER_NUMBER`); has open ticket #3143 (VPN auth failure). Good for the "existing ticket → add note" scenario.

### Halo MCP findings (this instance)
- Tools carry accurate `readOnlyHint` annotations; the policy relies on them, plus explicit rules. Allowed: `create_ticket`, `add_note_to_ticket` (ticket_id), and the read-only tools except `get_user_info` / `get_assigned_tickets` (these describe the API account, not the caller). Denied: `action_ticket`, `apply_suggestion`, `assign_to_me`, `get_matches` (refresh = write), `log_service_request`, `log_time`.
- `get_users` search is a **substring match on the stored, formatted phone** ("+61 3 9561 7232"); unspaced E.164 doesn't match. `identify.ts` tries spaced AU formats, then keeps only users whose number normalises to the caller's E.164.
- Results look like `{page_no, page_size, record_count, total_pages, results:[...]}`, with a `link` on each record. Ticket URLs are `/ticket?id=N` (not `/tickets`).
- `search_tickets` works by the user's name or email (`open_only: true`). **Assets aren't linked to users** (`get_assets` by user name → none); the agent asks for the asset tag instead.
- `create_ticket` takes `user_email, summary (≤70 chars), description, ticket_type?`, with **no status field**, so "resolved on call" tickets are created open with a "Resolved on call:" prefix. Closing would need `action_ticket`, which is denied (open question for the user).
- Instance-specific guidance lives in `config/tool-policy.json › promptNotes` (appended to the system prompt).

### Next steps
1. User adds `ANTHROPIC_API_KEY` to `.env`.
2. `npm run chat -- --from +61395617232` through the README demo scenarios; tune `src/agent/prompt.ts` / `promptNotes`.
3. Browser call from the dashboard (latency, barge-in).
4. Later: AU Regulatory Bundle → buy number → `npm run setup:twilio`. No code changes needed.

### Known limitations / ideas
- The end-of-call hang-up waits an estimated TTS duration (~70 ms/char) before sending `{type:"end"}`.
- `transfer_to_human` is a stub (logs to the dashboard; it could use a TwiML `<Dial>` via `handoffData` + action URL).
- The add_note guard collects ticket IDs from results of tools with "ticket" in the name (`id` keys) and from any `ticket_id` key. That fits the real result shapes.
- Sessions and dashboard history are in memory only.
