import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { getHaloToken, invalidateHaloToken } from "./auth.js";

export type { McpTool };

/** fetch wrapper that attaches a current Halo bearer token and retries once on 401. */
const authedFetch: typeof fetch = async (input, init) => {
  const send = async () => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await getHaloToken()}`);
    return fetch(input, { ...init, headers });
  };
  let res = await send();
  if (res.status === 401) {
    invalidateHaloToken();
    res = await send();
  }
  return res;
};

let clientPromise: Promise<Client> | undefined;
let toolsCache: McpTool[] | undefined;

async function connect(): Promise<Client> {
  const client = new Client({ name: "halo-voice-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config().HALO_MCP_URL), { fetch: authedFetch });
  client.onclose = () => {
    clientPromise = undefined;
  };
  await client.connect(transport);
  return client;
}

/** Shared MCP client for the process. Reconnects lazily if the session drops. */
export function haloClient(): Promise<Client> {
  clientPromise ??= connect().catch((err) => {
    clientPromise = undefined;
    throw err;
  });
  return clientPromise;
}

/** All tools the Halo MCP server exposes (cached for the life of the process). */
export async function listHaloTools(refresh = false): Promise<McpTool[]> {
  if (toolsCache && !refresh) return toolsCache;
  const client = await haloClient();
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  toolsCache = tools.sort((a, b) => a.name.localeCompare(b.name));
  return toolsCache;
}

export interface HaloToolResult {
  isError: boolean;
  /** Text to hand back to the model. */
  text: string;
  /** Parsed JSON when the result was JSON (for the dashboard and ticket tracking). */
  data?: unknown;
}

/** Call a Halo MCP tool. Retries once on a dropped session. */
export async function callHaloTool(name: string, args: Record<string, unknown>): Promise<HaloToolResult> {
  const run = async () => (await haloClient()).callTool({ name, arguments: args }) as Promise<CallToolResult>;
  let result: CallToolResult;
  try {
    result = await run();
  } catch (err) {
    clientPromise = undefined;
    result = await run().catch((e) => {
      throw e instanceof Error ? e : new Error(String(err));
    });
  }

  const textParts = (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type} content omitted]`))
    .join("\n");
  const data = result.structuredContent ?? tryParseJson(textParts);
  return { isError: Boolean(result.isError), text: textParts, data };
}

function tryParseJson(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export async function closeHalo(): Promise<void> {
  const c = await clientPromise?.catch(() => undefined);
  await c?.close();
}
