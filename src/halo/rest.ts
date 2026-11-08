import { config } from "../config.js";
import { getHaloToken, invalidateHaloToken } from "./auth.js";

/** Halo REST API base (https://<instance>/api), from HALO_WEB_URL or HALO_AUTH_URL. */
function apiBase(): string | undefined {
  const cfg = config();
  const web = cfg.HALO_WEB_URL ?? cfg.HALO_AUTH_URL?.replace(/\/auth\/?$/, "");
  return web ? web.replace(/\/$/, "") + "/api" : undefined;
}

/** Search Halo users over the REST API (same client-credentials token as MCP). */
export async function searchUsersRest(search: string): Promise<Record<string, unknown>[]> {
  const base = apiBase();
  if (!base) return [];
  const url = `${base}/Users?search=${encodeURIComponent(search)}&count=10`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await getHaloToken()}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 && attempt === 0) {
      invalidateHaloToken();
      continue;
    }
    if (!res.ok) throw new Error(`Halo REST /Users ${res.status}`);
    const body = (await res.json()) as { users?: Record<string, unknown>[] };
    return body.users ?? [];
  }
  return [];
}
