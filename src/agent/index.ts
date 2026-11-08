import { config } from "../config.js";
import { listHaloTools } from "../halo/mcp.js";
import { loadPolicy, type ToolPolicy } from "./policy.js";
import { buildAgentTools, type AgentTool } from "./tools.js";

let ready: Promise<{ policy: ToolPolicy; tools: AgentTool[] }> | undefined;

/** Load the tool policy and Halo MCP catalogue once per process. */
export function agentSetup(): Promise<{ policy: ToolPolicy; tools: AgentTool[] }> {
  ready ??= (async () => {
    const policy = loadPolicy(config().HALO_TOOL_POLICY);
    const tools = buildAgentTools(await listHaloTools(), policy);
    return { policy, tools };
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export { CallSession, type CallChannel } from "./session.js";
