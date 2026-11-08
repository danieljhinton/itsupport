import { describe, expect, it } from "vitest";
import { classifyTool, collectTicketIds, type ToolPolicy } from "../src/agent/policy.js";
import { buildAgentTools, compactResult } from "../src/agent/tools.js";
import { echoContent, noteAllowed } from "../src/agent/session.js";
import { extractUsers, phoneVariants, toE164 } from "../src/halo/identify.js";
import { parseRelayMessage } from "../src/twilio/relay.js";
import { signCallSid, verifyCallSid } from "../src/twilio/twiml.js";
import policyFile from "../config/tool-policy.json" with { type: "json" };

const policy = policyFile as unknown as ToolPolicy;
const t = (name: string, readOnlyHint?: boolean) => ({
  name,
  annotations: readOnlyHint === undefined ? undefined : { readOnlyHint },
  inputSchema: { type: "object" as const, properties: { ticket_id: { type: "number" } } },
});

// The real Halo MCP catalogue (name + readOnlyHint) as listed on 2026-11-08.
const haloCatalogue: [string, boolean][] = [
  ["action_ticket", false], ["add_note_to_ticket", false], ["apply_suggestion", false], ["assign_to_me", false],
  ["create_ticket", false], ["get_assets", true], ["get_assigned_tickets", true], ["get_clients", true],
  ["get_knowledge", true], ["get_matches", false], ["get_one_article", true], ["get_one_asset", true],
  ["get_one_client", true], ["get_one_site", true], ["get_one_ticket", true], ["get_one_user", true],
  ["get_sites", true], ["get_user_info", true], ["get_users", true], ["log_service_request", false],
  ["log_time", false], ["search_tickets", true],
];

describe("tool policy", () => {
  it("exposes exactly the agreed Halo tools", () => {
    const allowed = Object.fromEntries(
      haloCatalogue.map(([n, ro]) => [n, classifyTool(t(n, ro), policy).kind]).filter(([, k]) => k !== "deny"),
    );
    expect(allowed).toEqual({
      add_note_to_ticket: "add_note",
      create_ticket: "create_ticket",
      get_assets: "read",
      get_clients: "read",
      get_knowledge: "read",
      get_one_article: "read",
      get_one_asset: "read",
      get_one_client: "read",
      get_one_site: "read",
      get_one_ticket: "read",
      get_one_user: "read",
      get_sites: "read",
      get_users: "read",
      search_tickets: "read",
    });
  });

  it("denies writes and tools that describe the API account", () => {
    for (const n of ["action_ticket", "apply_suggestion", "assign_to_me", "get_matches", "log_service_request", "log_time"]) {
      expect(classifyTool(t(n, false), policy).kind).toBe("deny");
    }
    // Annotated read-only, but they describe the service account rather than the caller.
    expect(classifyTool(t("get_user_info", true), policy).kind).toBe("deny");
    expect(classifyTool(t("get_assigned_tickets", true), policy).kind).toBe("deny");
    // Name-based safety nets for tools Halo might add later.
    expect(classifyTool(t("update_ticket", true), policy).kind).toBe("deny");
    expect(classifyTool(t("delete_asset", true), policy).kind).toBe("deny");
    expect(classifyTool(t("close_ticket", true), policy).kind).toBe("deny");
  });

  it("has a ticket ID argument that matches the real add_note_to_ticket schema", () => {
    expect(classifyTool(t("add_note_to_ticket", false), policy)).toEqual({ kind: "add_note", ticketIdArg: "ticket_id" });
  });

  it("falls back to the readOnly annotation for unmatched tools", () => {
    expect(classifyTool(t("kb_lookup", true), policy).kind).toBe("read");
    expect(classifyTool(t("kb_lookup", false), policy).kind).toBe("deny");
    expect(classifyTool(t("kb_lookup"), policy).kind).toBe("deny");
  });

  it("hides denied tools from Claude and adds local tools", () => {
    const names = buildAgentTools([t("update_ticket"), t("get_assets", true), t("halo.tool/x", true)] as never, policy).map(
      (x) => x.name,
    );
    expect(names).toEqual(["get_assets", "halo_tool_x", "end_call", "transfer_to_human"]);
  });
});

describe("add_note guard", () => {
  it("only allows tickets already seen on the call", () => {
    const known = collectTicketIds({ tickets: [{ id: 101, summary: "VPN" }, { id: "102" }] }, "get_tickets");
    expect(noteAllowed("ticket_id", { ticket_id: 101 }, known)).toBe(true);
    expect(noteAllowed("ticket_id", { ticket_id: "102" }, known)).toBe(true);
    expect(noteAllowed("ticket_id", { ticket_id: 999 }, known)).toBe(false);
    expect(noteAllowed("ticket_id", {}, known)).toBe(false);
    expect(noteAllowed(undefined, { ticket_id: 101 }, known)).toBe(false);
  });

  it("does not treat user or asset ids as ticket ids", () => {
    const known = collectTicketIds({ users: [{ id: 5 }], assets: [{ id: 7, ticket_id: 42 }] }, "get_assets");
    expect([...known]).toEqual(["42"]);
  });
});

describe("caller identification helpers", () => {
  it("normalises AU numbers to E.164", () => {
    expect(toE164("+61 3 9561 7232")).toBe("+61395617232");
    expect(toE164("(03) 9561 7232")).toBe("+61395617232");
    expect(toE164("0412 345 678")).toBe("+61412345678");
    expect(toE164("61412345678")).toBe("+61412345678");
  });

  it("builds the spaced formats Halo's substring search matches", () => {
    // Landline, as stored in Halo: "+61 3 9561 7232"
    expect(phoneVariants("+61395617232")).toEqual([
      "+61395617232", "+61 3 9561 7232", "03 9561 7232", "0395617232", "9561 7232",
    ]);
    expect(phoneVariants("+61412345678")).toEqual([
      "+61412345678", "+61 412 345 678", "0412 345 678", "0412345678", "345 678",
    ]);
    expect(phoneVariants("")).toEqual([]);
  });

  it("extracts users from common result shapes", () => {
    expect(extractUsers([{ id: 1 }])).toHaveLength(1);
    expect(extractUsers({ users: [{ id: 1 }, { id: 2 }] })).toHaveLength(2);
    expect(extractUsers({ id: 1, name: "Sam" })).toHaveLength(1);
    expect(extractUsers({ record_count: 0 })).toHaveLength(0);
  });
});

describe("result compaction", () => {
  it("drops empty values and truncates", () => {
    expect(compactResult("", { a: 1, b: null, c: "", d: [], e: { f: null } })).toBe('{"a":1}');
    expect(compactResult("x".repeat(50), undefined, 10)).toMatch(/^x{10} \.\.\. \[truncated 40 chars\]$/);
  });
});

describe("fallback replay", () => {
  it("drops thinking/tool_use before the last fallback marker only", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "a", name: "x", input: {} },
      { type: "fallback", from: {}, to: {} },
      { type: "thinking", thinking: "", signature: "t" },
      { type: "tool_use", id: "b", name: "x", input: {} },
    ];
    const out = echoContent({ content } as never).map((b) => b.type);
    expect(out).toEqual(["text", "fallback", "thinking", "tool_use"]);
    expect(echoContent({ content: content.slice(0, 3) } as never)).toHaveLength(3);
  });
});

describe("ConversationRelay", () => {
  it("parses messages and ignores junk", () => {
    expect(parseRelayMessage('{"type":"prompt","voicePrompt":"hi","last":true}')).toMatchObject({ type: "prompt" });
    expect(parseRelayMessage("not json")).toBeUndefined();
    expect(parseRelayMessage('{"foo":1}')).toBeUndefined();
  });

  it("verifies signed call SIDs", () => {
    const sig = signCallSid("CA1");
    expect(verifyCallSid("CA1", sig)).toBe(true);
    expect(verifyCallSid("CA2", sig)).toBe(false);
    expect(verifyCallSid("CA1", undefined)).toBe(false);
  });
});

describe("browser calling", () => {
  it("uses the demo number only for browser (client:) calls", async () => {
    const { callerNumberFor } = await import("../src/twilio/twiml.js");
    expect(callerNumberFor({ From: "client:dashboard-demo", demoFrom: "+61 412 345 678" })).toBe("+61412345678");
    expect(callerNumberFor({ From: "client:dashboard-demo" })).toBeUndefined();
    expect(callerNumberFor({ From: "+61298765432", demoFrom: "+61412345678" })).toBe("+61298765432");
  });
});
