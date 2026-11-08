import type { ToolPolicy } from "../agent/policy.js";
import { callHaloTool } from "./mcp.js";

export type IdentifyResult =
  | { status: "matched"; user: Record<string, unknown> }
  | { status: "ambiguous"; candidates: Record<string, unknown>[] }
  | { status: "none" }
  | { status: "skipped"; detail: string }
  | { status: "error"; detail: string };

/** Normalise an Australian number to E.164 (+61...), or return the bare digits for anything else. */
export function toE164(raw: string): string {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (plus) return "+" + digits;
  if (digits.startsWith("61") && digits.length === 11) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 10) return "+61" + digits.slice(1);
  return digits;
}

/**
 * Search strings to try in Halo, most specific first. Halo's user search is a substring
 * match on the number as stored (e.g. "+61 3 9561 7232"), so spaced Australian formats are
 * needed; the caller ID from Twilio is unspaced E.164. Hits are confirmed afterwards by
 * comparing normalised numbers (see identifyCaller).
 */
export function phoneVariants(raw: string): string[] {
  const e164 = toE164(raw);
  if (!e164.replace("+", "")) return [];
  const out = new Set<string>([e164]);
  const m = /^\+61(\d{9})$/.exec(e164);
  if (m) {
    const n = m[1];
    if (n.startsWith("4")) {
      // Mobile: +61 412 345 678 / 0412 345 678
      const [a, b, c] = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
      out.add(`+61 ${a} ${b} ${c}`);
      out.add(`0${a} ${b} ${c}`);
      out.add(`0${n}`);
      out.add(`${b} ${c}`);
    } else {
      // Landline: +61 3 9561 7232 / (03) 9561 7232
      const [area, a, b] = [n[0], n.slice(1, 5), n.slice(5)];
      out.add(`+61 ${area} ${a} ${b}`);
      out.add(`0${area} ${a} ${b}`);
      out.add(`0${n}`);
      out.add(`${a} ${b}`);
    }
  }
  return [...out];
}

/** Phone-like values on a Halo user record. */
function userPhones(u: Record<string, unknown>): string[] {
  return Object.entries(u)
    .filter(([k, v]) => /phone|mobile|tel/i.test(k) && typeof v === "string" && v.trim())
    .map(([, v]) => v as string);
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
    const target = toE164(from);
    const seen = new Map<string, Record<string, unknown>>();
    for (const phone of phoneVariants(from)) {
      const res = await callHaloTool(policy.identify.tool, fill(policy.identify.args, phone));
      if (res.isError) continue;
      for (const u of extractUsers(res.data)) {
        const phones = userPhones(u);
        // Search is a substring match, so keep only users whose number really is the caller's.
        // (If the result has no phone fields at all, we can't check, so trust the search.)
        if (phones.length === 0 || phones.some((p) => toE164(p) === target)) {
          seen.set(String(u.id ?? JSON.stringify(u)), u);
        }
      }
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
