import type Anthropic from "@anthropic-ai/sdk";
import { Ajv, type ValidateFunction } from "ajv";
import type { McpTool } from "../halo/mcp.js";
import { classifyTool, type Classified, type ToolPolicy } from "./policy.js";

export const LOCAL_TOOLS = {
  end_call: "end_call",
  transfer_to_human: "transfer_to_human",
} as const;

export interface AgentTool {
  /** Name Claude sees (sanitised). */
  name: string;
  /** Original Halo MCP tool name; undefined for local tools. */
  mcpName?: string;
  policy: Classified;
  definition: Anthropic.Beta.Messages.BetaTool;
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: false });

const localDefinitions: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: LOCAL_TOOLS.end_call,
    description:
      "Hang up the call. Use only after you have said goodbye and any ticket has been logged and its number read back.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["resolved", "ticket_logged", "caller_ended", "other"] },
        summary: { type: "string", description: "One sentence summary of the call." },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
  {
    name: LOCAL_TOOLS.transfer_to_human,
    description:
      "Request a transfer to a human technician (urgent outage, security incident, or the caller insists). Log a ticket first.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

function sanitiseName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

const KIND_NOTE: Partial<Record<Classified["kind"], string>> = {
  create_ticket:
    "\n\n[Policy] Use to log a ticket for this caller: open if unresolved, closed/resolved if fixed on the call.",
  add_note:
    "\n\n[Policy] Only for adding a note to one of this caller's existing tickets that you have already looked up on this call.",
};

/**
 * Turn the Halo MCP catalogue into the tool list Claude sees, applying the policy.
 * Output order is deterministic (sorted) so the prompt cache stays warm.
 */
export function buildAgentTools(mcpTools: McpTool[], policy: ToolPolicy): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const t of [...mcpTools].sort((a, b) => a.name.localeCompare(b.name))) {
    const cls = classifyTool(t, policy);
    if (cls.kind === "deny") continue;
    const schema = (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Beta.Messages.BetaTool.InputSchema;
    const definition: Anthropic.Beta.Messages.BetaTool = {
      name: sanitiseName(t.name),
      description: ((t.description ?? t.title ?? t.name) + (KIND_NOTE[cls.kind] ?? "")).slice(0, 4000),
      input_schema: { ...schema, type: "object" },
      eager_input_streaming: true,
    };
    tools.push({ name: definition.name, mcpName: t.name, policy: cls, definition, validate: compile(schema) });
  }
  for (const d of localDefinitions) {
    tools.push({
      name: d.name,
      policy: { kind: "read" },
      definition: { ...d, eager_input_streaming: true },
      validate: compile(d.input_schema),
    });
  }
  return tools;
}

function compile(schema: object): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch {
    return ajv.compile({ type: "object" }); // schema we can't compile: only check it's an object
  }
}

/** Remove null/empty values and cap size so tool results stay cheap and fast for the model. */
export function compactResult(text: string, data: unknown, maxChars = 8000): string {
  let out = data !== undefined ? JSON.stringify(prune(data)) : text;
  if (out.length > maxChars) out = out.slice(0, maxChars) + ` ... [truncated ${out.length - maxChars} chars]`;
  return out;
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune).filter((x) => !isEmpty(x));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (!isEmpty(p)) o[k] = p;
    }
    return o;
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
  );
}
