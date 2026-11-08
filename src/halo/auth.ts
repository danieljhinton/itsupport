import { config } from "../config.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | undefined;
let inflight: Promise<string> | undefined;

/**
 * Get a Halo API access token using the OAuth client_credentials grant.
 * Tokens are cached and refreshed 60s before they expire.
 */
export async function getHaloToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;
  inflight ??= fetchToken().finally(() => (inflight = undefined));
  return inflight;
}

/** Drop the cached token, e.g. after a 401. */
export function invalidateHaloToken(): void {
  cached = undefined;
}

async function fetchToken(): Promise<string> {
  const cfg = config();
  const url = new URL(cfg.HALO_AUTH_URL.replace(/\/$/, "") + "/token");
  if (cfg.HALO_TENANT) url.searchParams.set("tenant", cfg.HALO_TENANT);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.HALO_CLIENT_ID,
      client_secret: cfg.HALO_CLIENT_SECRET,
      scope: cfg.HALO_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(`Halo token request failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.accessToken;
}
