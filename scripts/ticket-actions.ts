// Prints the actions Halo offers on a ticket (via the MCP get_one_ticket tool), so you can find
// the Close action's id for config/tool-policy.json (action_ticket › fixedArgs.action_id).
//   npm run ticket-actions -- <ticket id>
// Use an open ticket: closed tickets may list no actions.
import { callHaloTool, closeHalo } from "../src/halo/mcp.js";

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) {
  console.error("Usage: npm run ticket-actions -- <ticket id>");
  process.exit(1);
}
try {
  const res = await callHaloTool("get_one_ticket", { ticket_id: id });
  const data = res.data as { subject?: string; actions?: unknown[] } | undefined;
  if (res.isError || !data || typeof data !== "object") {
    console.log(res.text);
  } else {
    console.log(`Ticket ${id}: ${data.subject ?? ""}`);
    const actions = data.actions ?? [];
    if (!actions.length) console.log("No actions listed. Try an open ticket.");
    for (const a of actions) console.log(JSON.stringify(a));
  }
} finally {
  await closeHalo();
}
