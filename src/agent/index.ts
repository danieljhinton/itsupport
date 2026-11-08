import { config } from "../config.js";
import { listHaloTools } from "../halo/mcp.js";
import { loadPolicy, type ToolPolicy } from "./policy.js";
import { systemPrompt } from "./prompt.js";
import { buildAgentTools, type AgentTool } from "./tools.js";

export interface AgentSetup {
  policy: ToolPolicy;
  tools: AgentTool[];
  /** System prompt, built once so it stays byte-identical across calls (prompt cache). */
  system: string;
}

let ready: Promise<AgentSetup> | undefined;

/** Load the tool policy and Halo MCP catalogue once per process. */
export function agentSetup(): Promise<AgentSetup> {
  ready ??= (async () => {
    const policy = loadPolicy(config().HALO_TOOL_POLICY);
    const tools = buildAgentTools(await listHaloTools(), policy);
    return { policy, tools, system: systemPrompt(policy.promptNotes) };
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export { CallSession, type CallChannel } from "./session.js";
