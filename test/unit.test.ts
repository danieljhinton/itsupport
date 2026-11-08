import { describe, expect, it } from "vitest";
import { classifyTool, collectTicketIds, type ToolPolicy } from "../src/agent/policy.js";
import { buildAgentTools, compactResult } from "../src/agent/tools.js";
import { echoContent, noteAllowed } from "../src/agent/session.js";
import { extractUsers, phoneVariants } from "../src/halo/identify.js";
import { parseRelayMessage } from "../src/twilio/relay.js";
import { signCallSid, verifyCallSid } from "../src/twilio/twiml.js";
import policyFile from "../config/tool-policy.json" with { type: "json" };

const policy = policyFile as unknown as ToolPolicy;
const t = (name: string, readOnlyHint?: boolean) => ({
  name,
  annotations: readOnlyHint === undefined ? undefined : { readOnlyHint },
  inputSchema: { type: "object" as const, properties: { ticket_id: { type: "number" } } },
});

describe("tool policy", () => {
  it("allows reads, ticket creation and notes", () => {
    expect(classifyTool(t("get_tickets"), policy).kind).toBe("read");
    expect(classifyTool(t("search_kb_articles"), policy).kind).toBe("read");
    expect(classifyTool(t("create_ticket"), policy).kind).toBe("create_ticket");
    expect(classifyTool(t("add_action"), policy)).toEqual({ kind: "add_note", ticketIdArg: "ticket_id" });
  });

  it("denies other writes even if they look like reads", () => {
    expect(classifyTool(t("update_ticket"), policy).kind).toBe("deny");
    expect(classifyTool(t("close_ticket"), policy).kind).toBe("deny");
    expect(classifyTool(t("delete_asset"), policy).kind).toBe("deny");
    expect(classifyTool(t("create_asset"), policy).kind).toBe("deny");
    expect(classifyTool(t("get_and_update_thing"), policy).kind).toBe("deny");
  });

  it("falls back to the readOnly annotation for unmatched tools", () => {
    expect(classifyTool(t("kb_lookup", true), policy).kind).toBe("read");
    expect(classifyTool(t("kb_lookup", false), policy).kind).toBe("deny");
    expect(classifyTool(t("kb_lookup"), policy).kind).toBe("deny");
  });

  it("hides denied tools from Claude and adds local tools", () => {
    const names = buildAgentTools([t("update_ticket"), t("get_assets"), t("halo.tool/x", true)] as never, policy).map(
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
  it("builds AU phone variants", () => {
    expect(phoneVariants("+61412345678")).toEqual(["+61412345678", "0412345678", "61412345678"]);
    expect(phoneVariants("0412 345 678")).toEqual(["0412345678", "+61412345678"]);
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
