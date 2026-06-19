/*
 * OAuth 2.0 client-credentials token acquisition (issue #130).
 *
 * This is the one OAuth flow Controller can run without any user interaction:
 * a machine-to-machine token fetched from the token endpoint using a client id
 * and secret. The interactive flows (authorization-code "user" OAuth, dynamic
 * MCP registration) need a browser and are handled elsewhere.
 *
 * Tokens are cached in-memory per scheme until shortly before they expire, so a
 * burst of agent calls doesn't hammer the token endpoint.
 */

import type { AuthScheme } from "./integrations.js";

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token should be refreshed. */
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const EXPIRY_SKEW_MS = 30_000;

/**
 * Return a valid access token for a client-credentials scheme, fetching a new
 * one when the cache is empty or stale. Returns null when the scheme isn't
 * fully configured or the token request fails — the caller then surfaces the
 * usual "needs to be connected" re-auth signal.
 */
export async function acquireOAuthToken(
  connectionId: string,
  scheme: AuthScheme,
  clientSecret: string | undefined
): Promise<string | null> {
  const tokenUrl = scheme.config.tokenUrl?.trim();
  const clientId = scheme.config.clientId?.trim();
  if (!tokenUrl || !clientId || !clientSecret) return null;

  const key = `${connectionId}:${scheme.id}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const scopes = scheme.config.scopes?.trim();
  if (scopes) body.set("scope", scopes);

  let token: CachedToken | null = null;
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    token = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs - EXPIRY_SKEW_MS };
  } catch {
    return null;
  }

  cache.set(key, token);
  return token.accessToken;
}

/** Drop any cached token for a connection (e.g. after its config changes). */
export function clearOAuthTokenCache(connectionId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${connectionId}:`)) cache.delete(key);
  }
}
