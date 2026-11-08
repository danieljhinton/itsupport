# CLAUDE.md

Persistent project notes for Claude Code sessions. Keep this file current: update it when a decision, convention or status changes.

## What this is
A proof-of-concept for **HaloITSM** customers that shows what Halo's MCP server can do. A caller rings an Australian Twilio number. A Claude agent tries to resolve their IT issue over the phone, using the Halo MCP server live (KB articles, the caller's open tickets, their assets). If it can't resolve the issue, it logs a ticket. A live web dashboard shows the transcript and every MCP tool call, for screen-share demos.

## Agreed decisions (from planning, 2026-11-08)
- **Stack:** Node.js + TypeScript (ESM, `tsx` to run, `tsc --noEmit` to typecheck), Fastify, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `twilio`, `zod`, `vitest`.
- **Voice:** Twilio **ConversationRelay**. Twilio does STT and TTS; our server exchanges text over a websocket at `/relay`. Language `en-AU`.
- **LLM:** Claude via the Anthropic API. Model comes from env `CLAUDE_MODEL` (default `claude-opus-5-5`, effort `low` for latency). Thinking can't be disabled on Opus 5.5; effort is the latency control. Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is sent only for models that support it (`fallbackParams()` in `session.ts`); Haiku 5.5 has none. **User switched `.env` to `CLAUDE_MODEL=claude-haiku-5-5` (2026-11-08)** for speed/cost; first token ~1.3 s, ~4 s with two KB searches.
- **Halo MCP:** hosted Halo MCP endpoint, authenticated with Halo **API client credentials** (OAuth `client_credentials`). The app is the MCP client (client-side MCP, *not* Anthropic's MCP connector), so it can enforce the tool allowlist, send calls to the dashboard and trim results.
- **Caller identification:** caller ID lookup in Halo first; if there's no match or more than one, the agent asks for name/email.
- **Halo write policy:** the agent may (1) create tickets: open if unresolved, closed if resolved on the call (for reporting); (2) add notes to the caller's existing tickets. **No other writes.** Enforced in code by `config/tool-policy.json` plus `src/agent/tools.ts` / `session.ts`: policy kinds `create_ticket`, `add_note` (tickets seen on this call), `close_ticket` (only tickets *created* on this call), and `omitArgs` (hidden + stripped args, e.g. `status` on a note tool). Read-only tools are allowed when the MCP tool is annotated `readOnlyHint` or listed as `read`.
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
- [x] Halo auth + MCP client + tool policy, **matched to the real Halo catalogue** and tested live (now the Virtual Agent endpoint, 12 `CF_` tools)
- [x] Agent session + prompt + tools; chat CLI, run end to end on Haiku 5.5 (KB question answered from CF_search_knowledge_base)
- [x] Twilio TwiML + relay; browser calling from the dashboard. Twilio creds/API key/TwiML App verified with `npm run check:twilio`; signed webhook through ngrok accepted
- [x] Dashboard
- [x] README, Dockerfile, unit tests (`test/unit.test.ts`, 18 passing)

### Environment (user's setup, 2026-11-08)
- Halo (QA instance): `https://dhinternalitsm.itsm.haloqa.co.uk`, auth at `/auth`. Client-credentials auth works. **MCP endpoint (since 2026-11-08): a Halo Virtual Agent, `/api/VirtualAgent/04b2437f-0519-4c8a-8f41-a2a3bbbcb5db/mcp`** (was the generic `/api/mcp`, 22 tools).
- ngrok static domain: `https://mutiny-seldom-produce.ngrok-free.dev` (= `PUBLIC_URL`; the TwiML App "Halo" points at `/twiml`). The user's ngrok is older: use `--domain=`, or update for `--url=`.
- Twilio: full (paid) account; API key "API1"; TwiML App "Halo".
- Demo caller: **Brenda Ross**, `+61 3 9561 7232` (E.164 `+61395617232`, set as `DEMO_CALLER_NUMBER`); has open ticket #3143 (VPN auth failure). Good for the "existing ticket → add note" scenario.

### Halo MCP findings (Virtual Agent endpoint, 12 `CF_` tools)
- Annotations: `CF_add_note`, `CF_close_ticket` destructive; `CF_log_incident`, `CF_search_services` not read-only; the rest `readOnlyHint`.
- Policy: `CF_log_incident` = create_ticket; `CF_add_note` = add_note with `status`/`time_taken` omitted (its `status` enum could change any ticket's status, incl. Closed); `CF_close_ticket` = close_ticket (created-on-this-call only), so "resolved on call" tickets are now really closed; `CF_search_services` = read; `CF_retrieve_users` denied to the agent.
- `CF_retrieve_users` (no args) returns **every** active user as `[{User, "Phone Number", Email}]` (the user added `Email` to the tool on 2026-11-08; no id). `identify.ts` calls it once and matches on normalised E.164 (`site*` phone fields ignored). The user asked that the agent **not** ask for the email when the lookup has it; it asks only if the match has no email. Kept MCP-only on purpose (a REST fallback was tried and removed).
- `CF_search_tickets` is a vectorised search and found **nothing** for name, keyword or ticket number (blank search → "Failed to vectorise"). Possibly the index isn't built, or it's scoped to the API account. Agent asks for the ticket number and uses `CF_get_one_ticket` (works: returns `user_name`, `conversation`, `similar_tickets`, `actions`).
- The add_note guard only takes a ticket tool's own top-level `id` (or items of a top-level `results` list), so `similar_tickets`/`actions` ids from `CF_get_one_ticket` don't become noteable.
- `CF_log_incident` requires `CFimpact`, `CFurgency`, `category_1` (enums); optional `asset_id`. Its result shape is **untested** (no live ticket created yet); `recordTicket` falls back to the first 2+ digit number in the text, and a wrong ID only makes close/note fail safely.
- `CF_search_assets` works (results `{page_no,..., results:[{id, asset_tag, asset_type, ...}]}`); assets still not linked to users. KB search returns resolution text inline.
- Results are often plain text when empty ("No tickets found.") rather than JSON.
- Instance-specific guidance lives in `config/tool-policy.json › promptNotes`.

### Next steps
1. ~~User adds `ANTHROPIC_API_KEY`~~ (done).
2. `npm run chat -- --from +61395617232` through the README demo scenarios; tune `src/agent/prompt.ts` / `promptNotes`.
3. Browser call from the dashboard (latency, barge-in).
4. Later: AU Regulatory Bundle → buy number → `npm run setup:twilio`. No code changes needed.

### Known limitations / ideas
- The end-of-call hang-up waits an estimated TTS duration (~70 ms/char) before sending `{type:"end"}`.
- `transfer_to_human` is a stub (logs to the dashboard; it could use a TwiML `<Dial>` via `handoffData` + action URL).
- The add_note guard collects ticket IDs from results of tools with "ticket" in the name (`id` keys) and from any `ticket_id` key. That fits the real result shapes.
- Sessions and dashboard history are in memory only.
