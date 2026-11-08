import type { ToolPolicy } from "../agent/policy.js";
import { callHaloTool } from "./mcp.js";

export type IdentifyResult =
  | { status: "matched"; user: Record<string, unknown> }
  | { status: "ambiguous"; candidates: Record<string, unknown>[] }
  | { status: "none" }
  | { status: "skipped"; detail: string }
  | { status: "error"; detail: string };

/**
 * Forms of a phone number to try in Halo. Users are often stored as "04xx xxx xxx"
 * or "+614xxxxxxxx", so try E.164 and the national 0-prefixed form.
 */
export function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/[^\d+]/g, "");
  const out = new Set<string>();
  if (!digits) return [];
  out.add(digits);
  if (digits.startsWith("+61")) {
    const national = "0" + digits.slice(3);
    out.add(national);
    out.add(digits.slice(1)); // 61...
  } else if (digits.startsWith("0") && digits.length === 10) {
    out.add("+61" + digits.slice(1));
  }
  return [...out];
}

/** Pull a user list out of whatever shape the Halo tool returned. */
export function extractUsers(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["users", "results", "items", "data", "records"]) {
      if (Array.isArray(o[key])) return extractUsers(o[key]);
    }
    if ("id" in o && ("name" in o || "emailaddress" in o || "email" in o)) return [o];
  }
  return [];
}

function fill(args: Record<string, unknown>, phone: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args).replaceAll("{phone}", phone.replace(/"/g, "")));
}

/** Look up the caller in Halo by phone number, using the tool named in the policy. */
export async function identifyCaller(from: string | undefined, policy: ToolPolicy): Promise<IdentifyResult> {
  if (!policy.identify) return { status: "skipped", detail: "No identify tool configured" };
  if (!from || /anonymous|private|unknown/i.test(from)) return { status: "none" };
  try {
    const seen = new Map<string, Record<string, unknown>>();
    for (const phone of phoneVariants(from)) {
      const res = await callHaloTool(policy.identify.tool, fill(policy.identify.args, phone));
      if (res.isError) continue;
      for (const u of extractUsers(res.data)) seen.set(String(u.id ?? JSON.stringify(u)), u);
      if (seen.size > 0) break;
    }
    const users = [...seen.values()];
    if (users.length === 1) return { status: "matched", user: users[0] };
    if (users.length > 1) return { status: "ambiguous", candidates: users.slice(0, 5) };
    return { status: "none" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** First-turn context note for the model. */
export function identifyNote(from: string | undefined, r: IdentifyResult): string {
  const caller = from ? `Caller ID: ${from}.` : "Caller ID: withheld.";
  switch (r.status) {
    case "matched":
      return `${caller} Automatic Halo lookup matched one user: ${JSON.stringify(r.user)}. Confirm with the caller before sharing details.`;
    case "ambiguous":
      return `${caller} Automatic Halo lookup matched several users, so ask for name and email to confirm: ${JSON.stringify(r.candidates)}.`;
    case "none":
      return `${caller} No Halo user matched this number. Ask for the caller's name and work email and search for them.`;
    default:
      return `${caller} No automatic lookup was done. Search Halo for the caller by phone number, or ask for name and email.`;
  }
}
