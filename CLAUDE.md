# CLAUDE.md

Persistent project notes for Claude Code sessions. Keep this file current: update it when a decision, convention or status changes.

## What this is
A proof-of-concept for **HaloITSM** customers that shows what Halo's MCP server can do. A caller rings an Australian Twilio number. A Claude agent tries to resolve their IT issue over the phone, using the Halo MCP server live (KB articles, the caller's open tickets, their assets). If it can't resolve the issue, it logs a ticket. A live web dashboard shows the transcript and every MCP tool call, for screen-share demos.

## Agreed decisions (from planning, 2026-11-08)
- **Stack:** Node.js + TypeScript (ESM, `tsx` to run, `tsc --noEmit` to typecheck), Fastify, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `twilio`, `zod`, `vitest`.
- **Voice:** Twilio **ConversationRelay**. Twilio does STT and TTS; our server exchanges text over a websocket at `/relay`. Language `en-AU`.
- **LLM:** Claude via the Anthropic API. Model comes from env `CLAUDE_MODEL` (default `claude-opus-5-5`, effort `low` for latency). Thinking can't be disabled on Opus 5.5; effort is the latency control. Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is sent only for models that support it (`fallbackParams()` in `session.ts`); Haiku 5.5 has none. **User switched `.env` to `CLAUDE_MODEL=claude-haiku-5-5` (2026-11-08)** for speed/cost; first token ~1.3 s, ~4 s with two KB searches.
- **Halo MCP:** hosted Halo MCP endpoint, authenticated with Halo **API client credentials** (OAuth `client_credentials`). The app is the MCP client (client-side MCP, *not* Anthropic's MCP connector), so it can enforce the tool allowlist, send calls to the dashboard and trim results.
- **Caller identification:** caller ID lookup in Halo first; if there's no match or more than one, the agent asks for name/email. A matched caller's email comes from the lookup and the agent must **not** ask for it (user request).
- **Greeting (user request, 2026-11-08):** the agent speaks first: `WELCOME_GREETING` ("Hello, thanks for contacting the IT support desk. I'm the virtual assistant. How can I help you today?"). Twilio plays it as ConversationRelay `welcomeGreeting`; `CallSession({ greeting })` adds it to the dashboard transcript and tells the model it was already said (no double greeting). The chat CLI prints it first.
- **Halo write policy:** the agent may (1) create tickets: open if unresolved, closed if resolved on the call (for reporting); (2) add notes to the caller's existing tickets. **No other writes.** Enforced in code by `config/tool-policy.json` plus `src/agent/tools.ts` / `session.ts`: policy kinds `create_ticket`, `add_note` (tickets seen on this call), `close_ticket` (only tickets *created* on this call), and `omitArgs` (hidden + stripped args, e.g. `status` on a note tool). Read-only tools are allowed when the MCP tool is annotated `readOnlyHint` or listed as `read`.
- **Hosting:** local + ngrok for demos, with a Dockerfile for later.
- **Twilio:** AU number **bought and compliance-approved (2026-11-08)**, in `.env` as `TWILIO_PHONE_NUMBER` (ends …739). `npm run setup:twilio` done: its voice webhook is `${PUBLIC_URL}/twiml` (POST). Real calls work end to end.
- **Browser calling** (the interim option before the number arrived; still available): the dashboard's "Call the agent" button calls from the browser with the Twilio Voice JS SDK. It goes through a TwiML App → the same `/twiml` → ConversationRelay path. Browser calls have no caller ID, so the dashboard sends a demo number (`demoFrom` → TwiML `<Parameter name="callerNumber">` → `setup.customParameters.callerNumber`). `callerNumberFor()` honours it **only** for `client:` callers.

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
- [x] Halo auth + MCP client + tool policy, **matched to the real Halo catalogue** and tested live (old instance: generic, then Virtual Agent `CF_` tools)
- [ ] New instance (2026-11-17): policy matched to its generic `/api/mcp` catalogue; user to run `npm run chat` to check it end to end
- [x] Agent session + prompt + tools; chat CLI, run end to end on Haiku 5.5. User ran the demo scenarios (incl. ticket logging) and reports it works well
- [x] Real phone calls to the AU number through ngrok (user confirmed 2026-11-08)
- [x] Twilio TwiML + relay; browser calling from the dashboard. Twilio creds/API key/TwiML App verified with `npm run check:twilio`; signed webhook through ngrok accepted
- [x] Dashboard
- [x] README, Dockerfile, unit tests (`test/unit.test.ts`, 20 passing)

### Environment (user's setup, 2026-11-08)
- **Halo (since 2026-11-17): `https://dhitsminternal.app.usehalo.com`**, auth at `/auth` (client credentials work after a new API application was made; the first attempt failed with `invalid_client`, most likely a truncated secret). MCP endpoint: the **generic `/api/mcp`** (23 tools: the 22 generic ones plus `CF_email_user`), policy `config/tool-policy.json`. Not yet checked live on this instance: caller lookup by phone (`get_users`), `search_tickets`, whether assets are linked to users, `create_ticket` result shape, and the demo caller/ticket below.
- Old Halo (QA instance, until 2026-11-17): `https://dhinternalitsm.itsm.haloqa.co.uk`, auth at `/auth`. Client-credentials auth works. **MCP endpoint (since 2026-11-08): a Halo Virtual Agent, `/api/VirtualAgent/04b2437f-0519-4c8a-8f41-a2a3bbbcb5db/mcp`** (was the generic `/api/mcp`, 22 tools).
- ngrok static domain: `https://mutiny-seldom-produce.ngrok-free.dev` (= `PUBLIC_URL`; the TwiML App "Halo" points at `/twiml`). The user's ngrok is older: use `--domain=`, or update for `--url=`.
- Twilio: full (paid) account; API key "API1"; TwiML App "Halo".
- Demo caller: **Brenda Ross**, `+61 3 9561 7232` (E.164 `+61395617232`, set as `DEMO_CALLER_NUMBER`); has open ticket #3143 (VPN auth failure). Good for the "existing ticket → add note" scenario.

### Halo MCP findings: generic `/api/mcp` (current instance, 2026-11-17)
- Same tool set as the old instance's generic endpoint (which was tested live on 2026-11-08), plus `CF_email_user`. `readOnlyHint` is on the `get_*` tools (except `get_matches`) and `search_tickets`.
- Policy (`config/tool-policy.json`): `create_ticket` = create_ticket (`user_email, summary ≤70, description, ticket_type` blank); `add_note_to_ticket` = add_note (`ticket_id`; the note is **public**, so promptNotes say to write it for the caller); read-only tools allowed by annotation. Denied: `get_user_info`, `get_assigned_tickets` (API account), `action_ticket` (any action, incl. close), `CF_email_user` (emails + status), `apply_suggestion`, `assign_to_me`, `get_matches` (refresh = write), `log_service_request`, `log_time`.
- **No close tool here**, so "resolved on call" tickets stay open with a `Resolved on call:` summary (as on the old generic endpoint). Closing would need `action_ticket` restricted to one close action_id: not supported by the policy yet.
- Caller lookup: `get_users` with `search: {phone}`. On the old instance the search was a substring match on the stored, formatted number ("+61 3 9561 7232"), so `identify.ts` tries spaced AU formats and confirms by normalised E.164.
- On the old instance: results were `{page_no, page_size, record_count, total_pages, results:[...]}`, ticket URLs `/ticket?id=N`, `search_tickets` worked by name or email, and assets weren't linked to users.

### Halo MCP findings: Virtual Agent endpoint (old instance, 12 `CF_` tools; policy `config/tool-policy.virtual-agent.json`)
- Annotations: `CF_add_note`, `CF_close_ticket` destructive; `CF_log_incident`, `CF_search_services` not read-only; the rest `readOnlyHint`.
- Policy: `CF_log_incident` = create_ticket; `CF_add_note` = add_note with `status`/`time_taken` omitted (its `status` enum could change any ticket's status, incl. Closed); `CF_close_ticket` = close_ticket (created-on-this-call only), so "resolved on call" tickets are now really closed; `CF_search_services` = read; `CF_retrieve_users` denied to the agent.
- `CF_retrieve_users` (no args) returns **every** active user as `[{User, "Phone Number", Email}]` (the user added `Email` to the tool on 2026-11-08; no id). `identify.ts` calls it once and matches on normalised E.164 (`site*` phone fields ignored). The user asked that the agent **not** ask for the email when the lookup has it; it asks only if the match has no email. Kept MCP-only on purpose (a REST fallback was tried and removed).
- `CF_search_tickets` is a vectorised search and found **nothing** for name, keyword or ticket number (blank search → "Failed to vectorise"). Possibly the index isn't built, or it's scoped to the API account. Agent asks for the ticket number and uses `CF_get_one_ticket` (works: returns `user_name`, `conversation`, `similar_tickets`, `actions`).
- The add_note guard only takes a ticket tool's own top-level `id` (or items of a top-level `results` list), so `similar_tickets`/`actions` ids from `CF_get_one_ticket` don't become noteable.
- `CF_log_incident` requires `CFimpact`, `CFurgency`, `category_1` (enums); optional `asset_id`. The user has logged tickets through it successfully, but Claude hasn't inspected its result shape; `recordTicket` falls back to the first 2+ digit number in the text, and a wrong ID only makes close/note fail safely.
- `CF_search_assets` works (results `{page_no,..., results:[{id, asset_tag, asset_type, ...}]}`); assets still not linked to users. KB search returns resolution text inline.
- Results are often plain text when empty ("No tickets found.") rather than JSON.
- Instance-specific guidance lives in `config/tool-policy.json › promptNotes`.

### Starting a demo (user's machine)
1. Terminal 1: `npm run dev` (port 3000). If it fails with `EADDRINUSE`, an old server is still running: stop it (Ctrl+C in its terminal, or `Stop-Process` on the node PIDs). Claude's auto mode isn't allowed to kill processes, so the user does this.
2. Terminal 2: `ngrok http 3000 --domain=mutiny-seldom-produce.ngrok-free.dev`. A failed call usually means ngrok isn't running (`npm run check:twilio` reports "ngrok endpoint is offline").
3. Dashboard: `https://mutiny-seldom-produce.ngrok-free.dev/dashboard` (add `?token=` if `DASHBOARD_TOKEN` is set). Ring the number, or use "Call the agent".
- Calls from the user's own mobile only match a Halo user if that number is on the user's Halo record (found by `get_users`).

### Next steps / ideas
- Tune `src/agent/prompt.ts` / `promptNotes` from real calls (latency, barge-in).
- `CF_search_tickets` finds nothing on this instance; revisit if Halo's ticket search index gets built (then the agent could find tickets without a number).
- Optionally try `claude-sonnet-5-5` if Haiku struggles on multi-step calls.

### Known limitations / ideas
- The end-of-call hang-up waits an estimated TTS duration (~70 ms/char) before sending `{type:"end"}`.
- `transfer_to_human` is a stub (logs to the dashboard; it could use a TwiML `<Dial>` via `handoffData` + action URL).
- The add_note guard collects ticket IDs from results of tools with "ticket" in the name (`id` keys) and from any `ticket_id` key. That fits the real result shapes.
- Sessions and dashboard history are in memory only.
