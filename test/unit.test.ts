import { describe, expect, it } from "vitest";
import { classifyTool, collectTicketIds, type ToolPolicy } from "../src/agent/policy.js";
import { buildAgentTools, compactResult } from "../src/agent/tools.js";
import { echoContent, noteAllowed } from "../src/agent/session.js";
import { contactOf, extractUsers, phoneVariants, toE164 } from "../src/halo/identify.js";
import { parseRelayMessage } from "../src/twilio/relay.js";
import { signCallSid, verifyCallSid } from "../src/twilio/twiml.js";
import genericPolicyFile from "../config/tool-policy.json" with { type: "json" };
import policyFile from "../config/tool-policy.virtual-agent.json" with { type: "json" };

const policy = policyFile as unknown as ToolPolicy;
const genericPolicy = genericPolicyFile as unknown as ToolPolicy;
const t = (name: string, readOnlyHint?: boolean) => ({
  name,
  annotations: readOnlyHint === undefined ? undefined : { readOnlyHint },
  inputSchema: { type: "object" as const, properties: { ticket_id: { type: "number" } } },
});

// The real Halo Virtual Agent MCP catalogue (name + readOnlyHint) as listed on 2026-11-08.
const haloCatalogue: [string, boolean][] = [
  ["CF_add_note", false], ["CF_close_ticket", false], ["CF_get_one_article", true], ["CF_get_one_asset", true],
  ["CF_get_one_ticket", true], ["CF_get_one_user", true], ["CF_log_incident", false], ["CF_retrieve_users", true],
  ["CF_search_assets", true], ["CF_search_knowledge_base", true], ["CF_search_services", false],
  ["CF_search_tickets", true],
];

// The Halo /api/mcp catalogue (name + readOnlyHint) on dhitsminternal.app.usehalo.com, 2026-11-18.
const genericCatalogue: [string, boolean][] = [
  ["action_ticket", false], ["add_note_to_ticket", false], ["apply_suggestion", false], ["assign_to_me", false],
  ["CF_Email_User", false], ["CF_Resolve_Ticket", false], ["CF_User_Details", true], ["create_ticket", false], ["get_assets", true], ["get_assigned_tickets", true],
  ["get_clients", true], ["get_knowledge", true], ["get_matches", false], ["get_one_article", true],
  ["get_one_asset", true], ["get_one_client", true], ["get_one_site", true], ["get_one_ticket", true],
  ["get_one_user", true], ["get_sites", true], ["get_user_info", true], ["get_users", true],
  ["log_service_request", false], ["log_time", false], ["search_tickets", true],
];

describe("tool policy (generic Halo MCP, current)", () => {
  it("exposes exactly the agreed Halo tools", () => {
    const allowed = Object.fromEntries(
      genericCatalogue
        .map(([n, ro]) => [n, classifyTool(t(n, ro), genericPolicy).kind])
        .filter(([, k]) => k !== "deny"),
    );
    expect(allowed).toEqual({
      add_note_to_ticket: "add_note",
      CF_Resolve_Ticket: "close_ticket",
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
    expect(classifyTool(t("add_note_to_ticket", false), genericPolicy)).toEqual({ kind: "add_note", ticketIdArg: "ticket_id" });
  });

  it("closes with CF_Resolve_Ticket, with the AI options hidden and off", () => {
    expect(classifyTool(t("CF_Resolve_Ticket", false), genericPolicy)).toEqual({
      kind: "close_ticket", ticketIdArg: "ticket_id",
      fixedArgs: { CFAIKBCreationConfirmation: false, CFAIClosureReview: false },
    });
    const [tool] = buildAgentTools(
      [{
        name: "CF_Resolve_Ticket",
        description: "Close/Resolve the current ticket",
        inputSchema: {
          type: "object" as const,
          properties: {
            ticket_id: { type: "number" }, note: { type: "string" },
            CFAIKBCreationConfirmation: { type: "boolean" }, CFAIClosureReview: { type: "boolean" },
          },
          required: ["ticket_id", "note"],
        },
      }] as never,
      genericPolicy,
    );
    expect(Object.keys(tool.definition.input_schema.properties ?? {})).toEqual(["ticket_id", "note"]);
    expect(classifyTool(t("action_ticket", false), genericPolicy).kind).toBe("deny");
    expect(classifyTool(t("CF_User_Details", true), genericPolicy).kind).toBe("deny");
  });

  it("treats a null fixed arg as not configured (tool hidden)", () => {
    const p = { ...genericPolicy, rules: [{ match: "x_tool", kind: "close_ticket" as const, fixedArgs: { action_id: null } }] };
    expect(classifyTool(t("x_tool", false), p).kind).toBe("deny");
  });

  it("looks the caller up with the CF_User_Details full list", () => {
    expect(genericPolicy.identify).toMatchObject({ tool: "CF_User_Details", args: {} });
  });
});

describe("tool policy (Virtual Agent CF_ tools)", () => {
  it("exposes exactly the agreed Halo tools", () => {
    const allowed = Object.fromEntries(
      haloCatalogue.map(([n, ro]) => [n, classifyTool(t(n, ro), policy).kind]).filter(([, k]) => k !== "deny"),
    );
    expect(allowed).toEqual({
      CF_add_note: "add_note",
      CF_close_ticket: "close_ticket",
      CF_get_one_article: "read",
      CF_get_one_asset: "read",
      CF_get_one_ticket: "read",
      CF_get_one_user: "read",
      CF_log_incident: "create_ticket",
      CF_search_assets: "read",
      CF_search_knowledge_base: "read",
      CF_search_services: "read",
      CF_search_tickets: "read",
    });
  });

  it("denies the full user list and name-based risky tools", () => {
    // Annotated read-only, but it lists every user's phone number; only the pre-call lookup uses it.
    expect(classifyTool(t("CF_retrieve_users", true), policy).kind).toBe("deny");
    // Name-based safety nets for tools Halo might add later.
    expect(classifyTool(t("update_ticket", true), policy).kind).toBe("deny");
    expect(classifyTool(t("delete_asset", true), policy).kind).toBe("deny");
    expect(classifyTool(t("close_ticket", true), policy).kind).toBe("deny");
  });

  it("matches the real note and close schemas", () => {
    expect(classifyTool(t("CF_add_note", false), policy)).toEqual({
      kind: "add_note", ticketIdArg: "ticket_id", omitArgs: ["status", "time_taken"],
    });
    expect(classifyTool(t("CF_close_ticket", false), policy)).toEqual({
      kind: "close_ticket", ticketIdArg: "ticket_id", omitArgs: ["time_taken"],
    });
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

  it("hides the status argument of CF_add_note from Claude", () => {
    const note = {
      name: "CF_add_note",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        properties: { ticket_id: { type: "number" }, note: { type: "string" }, status: { type: "string" }, time_taken: { type: "string" } },
        required: ["ticket_id", "status"],
      },
    };
    const [tool] = buildAgentTools([note] as never, policy);
    expect(Object.keys(tool.definition.input_schema.properties as object)).toEqual(["ticket_id", "note"]);
    expect(tool.definition.input_schema.required).toEqual(["ticket_id"]);
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

  it("takes only the ticket's own id from CF_get_one_ticket, not similar tickets or actions", () => {
    const known = collectTicketIds(
      { similar_tickets: [{ id: 900 }], actions: [{ id: 7 }, { id: 4 }], conversation: [{ id: 11 }], id: 3143 },
      "CF_get_one_ticket",
    );
    expect([...known]).toEqual(["3143"]);
    const search = collectTicketIds({ page_no: 1, results: [{ id: 3143, actions: [{ id: 7 }] }] }, "CF_search_tickets");
    expect([...search]).toEqual(["3143"]);
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

  it("reads name and email from MCP and REST user shapes", () => {
    expect(contactOf({ User: "Brenda Ross", "Phone Number": "+61 3 9561 7232" })).toEqual({ name: "Brenda Ross", email: undefined });
    expect(contactOf({ name: "Brenda Ross", emailaddress: "b@x.com" })).toEqual({ name: "Brenda Ross", email: "b@x.com" });
    expect(contactOf({ "Full Name": "Brenda Ross", "Email Address": "b@x.com" })).toEqual({ name: "Brenda Ross", email: "b@x.com" });
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
