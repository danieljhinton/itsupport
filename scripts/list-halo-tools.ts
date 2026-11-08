// Prints every tool the Halo MCP server exposes, with annotations and input schema.
// Use the output to fill config/tool-policy.json.
//   npm run list-tools            -> summary
//   npm run list-tools -- --json  -> full JSON
import { listHaloTools, closeHalo } from "../src/halo/mcp.js";

const tools = await listHaloTools();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(tools, null, 2));
} else {
  for (const t of tools) {
    const ro = t.annotations?.readOnlyHint ? " [readOnly]" : t.annotations?.destructiveHint ? " [destructive]" : "";
    const params = Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).join(", ");
    console.log(`${t.name}${ro}\n    ${(t.description ?? "").split("\n")[0]}\n    params: ${params || "(none)"}`);
  }
  console.log(`\n${tools.length} tools`);
}
await closeHalo();
