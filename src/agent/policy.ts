import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpTool } from "../halo/mcp.js";

export type ToolKind = "read" | "create_ticket" | "add_note" | "deny";

const policySchema = z.object({
  allowReadOnlyAnnotated: z.boolean().default(true),
  rules: z
    .array(
      z.object({
        match: z.string(),
        kind: z.enum(["read", "create_ticket", "add_note", "deny"]),
        ticketIdArg: z.string().optional(),
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
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Decide what a Halo MCP tool may be used for. Unmatched tools are denied unless annotated read-only. */
export function classifyTool(tool: Pick<McpTool, "name" | "annotations">, policy: ToolPolicy): Classified {
  for (const rule of policy.rules) {
    if (globToRegExp(rule.match).test(tool.name)) {
      return { kind: rule.kind, ticketIdArg: rule.ticketIdArg };
    }
  }
  if (policy.allowReadOnlyAnnotated && tool.annotations?.readOnlyHint === true) return { kind: "read" };
  return { kind: "deny" };
}

/**
 * Collect ticket IDs from a tool result. add_note is limited to tickets the agent
 * has already seen (or created) during this call, which keeps it to the caller's own tickets.
 */
export function collectTicketIds(data: unknown, toolName: string, out = new Set<string>()): Set<string> {
  const ticketish = /ticket/i.test(toolName);
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const isId = typeof val === "number" || (typeof val === "string" && /^\d+$/.test(val));
      if (isId && (/^ticket_?id$/i.test(k) || (ticketish && k.toLowerCase() === "id"))) out.add(String(val));
      else walk(val, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}
