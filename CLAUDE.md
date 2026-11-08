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
- **Twilio:** account exists, **AU number not bought yet**. It needs an approved Australian Regulatory Bundle, which can take days.

## Conventions
- **Commit and push to GitHub (`origin` = github.com/danieljhinton/itsupport, branch `main`) after each meaningful milestone.** The user asked for this.
- Conversation history is **append-only**. Never edit or delete earlier turns (preserved thinking on newer Claude models rejects edited history). Interrupt handling adds a note to the *next* user message instead of trimming the earlier assistant turn.
- Keep the system prompt and tool list byte-stable across calls (prompt caching). Per-call context (caller ID, identified user) goes in messages, not `system`.
- Speech output: no markdown, URLs or lists. Short sentences.
- Secrets live in `.env` (gitignored). `.env.example` documents every variable.

## Layout
- `src/server.ts`: Fastify routes `/twiml`, `/relay` (ws), `/dashboard`, `/events` (SSE), `/health`
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
- [ ] Twilio TwiML + relay
- [ ] Dashboard
- [ ] README, Dockerfile, tests
