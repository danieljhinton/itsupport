import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpTool } from "../halo/mcp.js";

export type ToolKind = "read" | "create_ticket" | "add_note" | "close_ticket" | "deny";
const KINDS = ["read", "create_ticket", "add_note", "close_ticket", "deny"] as const;

const policySchema = z.object({
  allowReadOnlyAnnotated: z.boolean().default(true),
  rules: z
    .array(
      z.object({
        match: z.string(),
        kind: z.enum(KINDS),
        ticketIdArg: z.string().optional(),
        /** Arguments hidden from Claude and stripped before the call (e.g. a status field on a note tool). */
        omitArgs: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  identify: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
  /** Instance-specific tips appended to the system prompt (how this Halo's tools behave). */
  promptNotes: z.array(z.string()).default([]),
});

export type ToolPolicy = z.infer<typeof policySchema>;

export function loadPolicy(path: string): ToolPolicy {
  return policySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface Classified {
  kind: ToolKind;
  ticketIdArg?: string;
  omitArgs?: string[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Decide what a Halo MCP tool may be used for. Unmatched tools are denied unless annotated read-only. */
export function classifyTool(tool: Pick<McpTool, "name" | "annotations">, policy: ToolPolicy): Classified {
  for (const rule of policy.rules) {
    if (globToRegExp(rule.match).test(tool.name)) {
      const out: Classified = { kind: rule.kind };
      if (rule.ticketIdArg) out.ticketIdArg = rule.ticketIdArg;
      if (rule.omitArgs?.length) out.omitArgs = rule.omitArgs;
      return out;
    }
  }
  if (policy.allowReadOnlyAnnotated && tool.annotations?.readOnlyHint === true) return { kind: "read" };
  return { kind: "deny" };
}

/**
 * Collect ticket IDs from a tool result. add_note is limited to tickets the agent
 * has already seen (or created) during this call, which keeps it to the caller's own tickets.
 * For ticket tools, a plain `id` counts only on the record itself (the root, or items of a
 * top-level list such as `results`), not on nested things like similar_tickets or actions.
 * A `ticket_id` key counts anywhere.
 */
export function collectTicketIds(data: unknown, toolName: string, out = new Set<string>()): Set<string> {
  const ticketish = /ticket/i.test(toolName);
  const isId = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v));
  const walk = (v: unknown, depth: number, record: boolean) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1, record));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isId(val) && (/^ticket_?id$/i.test(k) || (ticketish && record && k.toLowerCase() === "id"))) out.add(String(val));
      else walk(val, depth + 1, record && depth === 0 && /^(results|tickets|records|data|items)$/i.test(k));
    }
  };
  walk(data, 0, true);
  return out;
}
