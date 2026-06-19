/*
 * Auth resolution contract (issue #130).
 *
 * The seam that decouples the transport axis from the auth axis. A transport
 * never knows *how* a credential was obtained — it asks `resolveAuth` for
 * material and attaches it. Auth is an AND-set of schemes; each scheme is
 * resolved in two steps that mirror its two axes:
 *
 *   1. acquisition → produce a credential *value* (static = the pasted secret;
 *      basic = base64(user:pass); oauth/cc/cloud = acquired; hmac/mtls = n/a)
 *   2. attachment  → place that value on the request (a header with a prefix,
 *      or a query param)
 *
 * Every scheme's material is merged into one ResolvedAuth. If any scheme can't
 * resolve, the whole connection isn't ready.
 *
 * Scope note: this pass implements only static attachment — values the user
 * pasted (incl. basic). Acquired credentials (OAuth, client-credentials, cloud)
 * and per-request signing (HMAC, mTLS) return a structured `reauth_needed`;
 * acquisition and signing land with the outbound-execution layer.
 */

import type { AuthScheme } from "./integrations.js";

/** Credential material a transport attaches to an outbound call. */
export interface ResolvedAuth {
  /** Headers for HTTP-family transports and MCP-over-HTTP. */
  headers: Record<string, string>;
  /** Query-string params for APIs that authenticate via the URL (e.g. Trello). */
  query: Record<string, string>;
  /** Env vars for stdio transports (MCP command, CLI-native). */
  env: Record<string, string>;
}

export type AuthResolution =
  | { status: "ready"; resolved: ResolvedAuth }
  /**
   * A scheme cannot be attached yet. `message` is surfaced to the user as the
   * "open Controller → Integrations" prompt; `reason` distinguishes a
   * credential that must be (re)acquired from a scheme not yet implemented.
   */
  | { status: "reauth_needed"; reason: "acquire" | "unsupported"; message: string };

/**
 * Resolve a connection's auth scheme set into attachable material. `secrets`
 * maps scheme id -> secret value (see `getConnectionSecrets`), passed in so this
 * stays a pure function. An empty scheme set resolves to "no auth".
 */
export function resolveAuth(
  schemes: AuthScheme[],
  secrets: Record<string, string>
): AuthResolution {
  const resolved: ResolvedAuth = { headers: {}, query: {}, env: {} };
  for (const scheme of schemes) {
    const result = resolveScheme(scheme, secrets[scheme.id]);
    if (result.status !== "ready") return result;
    Object.assign(resolved.headers, result.resolved.headers);
    Object.assign(resolved.query, result.resolved.query);
    Object.assign(resolved.env, result.resolved.env);
  }
  return { status: "ready", resolved };
}

function resolveScheme(scheme: AuthScheme, secret: string | undefined): AuthResolution {
  const value = produceValue(scheme, secret);
  if (value.status !== "ok") return value.resolution;
  return attach(scheme, value.value);
}

/* Step 1: produce the credential value from the acquisition. */
function produceValue(
  scheme: AuthScheme,
  secret: string | undefined
): { status: "ok"; value: string } | { status: "fail"; resolution: AuthResolution } {
  switch (scheme.acquisition) {
    case "static":
      if (!secret) return fail(acquire("A credential value is not configured."));
      return { status: "ok", value: secret };

    case "basic": {
      const username = scheme.config.username;
      if (!username || !secret) return fail(acquire("Basic auth is not fully configured."));
      return { status: "ok", value: Buffer.from(`${username}:${secret}`).toString("base64") };
    }

    case "oauth_client_credentials":
      // The access token is fetched upstream (resolveConnectionAuth) into the
      // scheme's secret; attach it like a bearer. No token → needs connecting.
      if (!secret) return fail(acquire("This integration needs to be connected."));
      return { status: "ok", value: secret };

    case "oauth":
    case "oauth_dynamic":
      // Interactive acquisition isn't implemented yet.
      return fail({
        status: "reauth_needed",
        reason: "acquire",
        message:
          "This integration needs to be connected. Open Controller → Integrations to authorize it.",
      });

    case "cloud":
    case "hmac":
    case "mtls":
      return fail({
        status: "reauth_needed",
        reason: "unsupported",
        message: `Auth acquisition "${scheme.acquisition}" is not supported yet.`,
      });
  }
}

/* Step 2: place the value on the request per the attachment. */
function attach(scheme: AuthScheme, value: string): AuthResolution {
  const attachment = scheme.attachment;
  if (!attachment || !attachment.name.trim()) {
    return acquire("This scheme has no attachment configured.");
  }
  if (attachment.kind === "header") {
    return ready({ headers: { [attachment.name]: `${attachment.prefix ?? ""}${value}` } });
  }
  return ready({ query: { [attachment.name]: value } });
}

function ready(partial: Partial<ResolvedAuth>): AuthResolution {
  return {
    status: "ready",
    resolved: { headers: {}, query: {}, env: {}, ...partial },
  };
}

function acquire(message: string): AuthResolution {
  return { status: "reauth_needed", reason: "acquire", message };
}

function fail(resolution: AuthResolution): { status: "fail"; resolution: AuthResolution } {
  return { status: "fail", resolution };
}
