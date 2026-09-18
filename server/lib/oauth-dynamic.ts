/*
 * OAuth 2.0 dynamic / MCP credential acquisition (issue #280).
 *
 * The MCP authorization spec (https://modelcontextprotocol.io/specification/2025-06-18/authorization)
 * says: a remote MCP server can advertise its authorization server via
 * `/.well-known/oauth-authorization-server` (RFC 8414) and require dynamic
 * client registration (RFC 7591). The user has no client id/secret to paste —
 * Controller discovers both endpoints, registers a client, then runs the
 * authorization-code flow with PKCE against a loopback callback to capture
 * the redirect.
 *
 * This module is the missing outbound-execution half of the integrations
 * design: `getValidToken(connection, scheme)` returns a fresh access token
 * (refreshing when needed); the existing `resolveConnectionAuth` calls into
 * it and attaches the bearer just like client-credentials does. The
 * interactive start (`startInteractiveOauth`) and the status fetch
 * (`acquireStatus`) are exposed over HTTP for the form.
 *
 * The loopback listener runs on `127.0.0.1` and is bound for the lifetime of
 * one acquisition only. Each acquisition owns its listener and callback
 * state so simultaneous connections cannot interfere with one another.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import type { AcquiredState, AuthScheme, IntegrationConnection } from "./integrations.js";
import {
  getConnection,
  getConnectionSecrets,
  updateSchemeAcquired,
  writeConnectionSecrets,
} from "./integrations.js";
import { fetchWithTimeout } from "./http-fetch.js";

const LOOPBACK_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 30_000;

/*
 * The token cache is keyed by connection + scheme id so a single connection's
 * multiple schemes (rare) and a single scheme across connections stay
 * separate. The token lives both here (for fast same-process reuse) and in the
 * encrypted secret store (so a process restart doesn't force the user to
 * re-authorize).
 */
interface CachedToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms after which the token should be refreshed. */
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

/** Persisted shape of an `oauth_dynamic` scheme's secret value. */
export interface OAuthDynamicSecret {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /**
   * Persisted dynamic client registration so we can refresh / re-authorize
   * without re-registering (some ASes require a consistent client_id).
   */
  clientId: string;
  clientSecret?: string;
  /** Authorization server metadata snapshot at registration time. */
  metadata: OAuthMetadata;
  scopes?: string;
  resource?: string;
}

/** RFC 8414 authorization-server metadata (only fields we use). */
export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  /** RFC 8414 §2: which client auth the AS accepts at the token endpoint. */
  token_endpoint_auth_methods_supported?: string[];
}

export class OAuthDynamicError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "metadata_not_found"
      | "dcr_failed"
      | "token_exchange_failed"
      | "refresh_failed"
      | "user_cancelled"
      | "invalid_state"
      | "callback_timeout"
      | "as_error"
  ) {
    super(message);
    this.name = "OAuthDynamicError";
  }
}

// --- Public API ---

/**
 * Return a valid access token for an `oauth_dynamic` scheme, refreshing it
 * when the cached one is missing or close to expiring. The refreshed token is
 * persisted to the encrypted secret store so a process restart can resume.
 *
 * Returns null when the scheme has no acquired secret yet (the user hasn't
 * authorized). The caller should then surface the "needs to be connected"
 * re-auth signal.
 */
export async function getValidToken(
  connection: IntegrationConnection,
  scheme: AuthScheme,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (scheme.acquisition !== "oauth_dynamic") {
    throw new Error("getValidToken only applies to oauth_dynamic schemes");
  }
  const key = `${connection.id}:${scheme.id}`;
  const stored = await loadSecret(connection.id, scheme.id);
  if (!stored) return null;

  const cached = cache.get(key);
  if (
    cached &&
    cached.accessToken === stored.accessToken &&
    cached.expiresAt === stored.expiresAt &&
    cached.expiresAt > Date.now()
  ) {
    return cached.accessToken;
  }

  // Stale or empty cache — see if we can refresh without user interaction.
  const isExpired = stored.expiresAt <= Date.now();
  const isAboutToExpire = stored.expiresAt - Date.now() < EXPIRY_SKEW_MS;
  const canRefresh = typeof stored.refreshToken === "string" && stored.refreshToken.length > 0;
  if ((isExpired || isAboutToExpire) && canRefresh) {
    try {
      const refreshed = await refreshAccessToken(stored, fetchImpl);
      cache.set(key, toCached(refreshed));
      await saveSecret(connection.id, scheme.id, refreshed);
      await markAcquired(connection.id, scheme, {
        status: "connected",
        expiresAt: new Date(refreshed.expiresAt).toISOString(),
      });
      return refreshed.accessToken;
    } catch {
      // Refresh failed: mark the scheme expired so the UI offers Reconnect.
      await markAcquired(connection.id, scheme, { status: "expired" });
      return null;
    }
  }

  if (isExpired) {
    // No refresh token and the stored token has already expired. The
    // previous behavior would have returned the expired access token
    // and let agents send a 401 — better to surface a clean reauth
    // signal so the UI shows Reconnect.
    await markAcquired(connection.id, scheme, { status: "expired" });
    return null;
  }

  // Token still valid; warm the cache.
  const token: CachedToken = toCached(stored);
  cache.set(key, token);
  return token.accessToken;
}

/** Status of an `oauth_dynamic` scheme for the UI. */
export interface AcquireStatus {
  status: "none" | "connected" | "expired";
  expiresAt?: string;
}

/** Read-only view of an `oauth_dynamic` scheme's state, for the form to render. */
export async function acquireStatus(
  connectionId: string,
  schemeId: string
): Promise<AcquireStatus | null> {
  const connection = await getConnection(connectionId);
  if (!connection) return null;
  const scheme = connection.auth.schemes.find((s) => s.id === schemeId);
  if (!scheme) return null;
  if (scheme.acquisition !== "oauth_dynamic") return null;

  const stored = await loadSecret(connectionId, schemeId);
  if (!stored) return { status: "none" };
  if (stored.expiresAt - Date.now() < EXPIRY_SKEW_MS) {
    return {
      status: "expired",
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }
  return {
    status: "connected",
    expiresAt: new Date(stored.expiresAt).toISOString(),
  };
}

/** Options for `startInteractiveOauth`. The defaults match the MCP spec. */
export interface InteractiveOauthOptions {
  /** Override the server URL the metadata is discovered from. */
  resourceUrl?: string;
  /** Override the scopes the user is asked to grant. */
  scopes?: string;
  /**
   * Hook for the UI to open the authorization URL in the user's default
   * browser. Defaults to logging the URL — production injects an Electron
   * `shell.openExternal` call via `setBrowserOpener`.
   */
  openBrowser?: (authorizationUrl: string) => Promise<void> | void;
  /** Reject after this many ms with a callback_timeout error. */
  callbackTimeoutMs?: number;
  /**
   * Override the HTTP fetch implementation. Tests inject a `fetch` whose
   * `Response` is the real one but with deterministic request bodies.
   */
  fetchImpl?: typeof fetch;
}

let defaultBrowserOpener: (url: string) => Promise<void> | void = (url) => {
  // The opener is replaced by `installDefaultBrowserOpener` at server
  // startup. In dev / tests that step is skipped, so we log instead —
  // either an Electron or dev-mode human can wire the real opener.
  console.warn(`[oauth-dynamic] open browser: ${url}`);
};

/**
 * Install the production browser opener. Called once at server startup
 * (from `index.ts` when the server runs inside the Electron main process,
 * which is the only environment that has `shell.openExternal` available).
 * Outside Electron we leave the no-op default in place.
 */
export async function installDefaultBrowserOpener(): Promise<void> {
  try {
    const electron = (await import("electron")) as unknown as {
      shell?: { openExternal: (url: string) => Promise<void> };
    };
    if (electron.shell?.openExternal) {
      defaultBrowserOpener = (url) => electron.shell!.openExternal(url);
    }
  } catch {
    // Running outside Electron (e.g. a dev `tsx` process) — leave the
    // warning-log default in place so the flow is still observable.
  }
}

/** Replace the default browser opener (mostly for tests). */
export function setBrowserOpener(opener: (url: string) => Promise<void> | void): void {
  defaultBrowserOpener = opener;
}

/**
 * Run the full interactive OAuth flow for an `oauth_dynamic` scheme. The
 * scheme's secret is replaced with the resulting token set and its
 * `acquired.status` is set to "connected".
 */
export async function startInteractiveOauth(
  connection: IntegrationConnection,
  scheme: AuthScheme,
  options: InteractiveOauthOptions = {}
): Promise<OAuthDynamicSecret> {
  if (scheme.acquisition !== "oauth_dynamic") {
    throw new Error("startInteractiveOauth only applies to oauth_dynamic schemes");
  }
  const resourceUrl = options.resourceUrl ?? connection.transport.config.url?.trim();
  if (!resourceUrl) {
    throw new OAuthDynamicError(
      "This connection has no URL configured. Set the MCP server URL first.",
      "metadata_not_found"
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const opener = options.openBrowser ?? defaultBrowserOpener;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 5 * 60_000;

  const metadata = await discoverMetadata(resourceUrl, fetchImpl);

  const priorSecret = await loadSecret(connection.id, scheme.id);
  const scopes = options.scopes ?? scheme.config.scopes?.trim() ?? priorSecret?.scopes ?? "";
  const listener = await startLoopbackListener();
  const redirectUri = listener.redirectUri;
  try {
    // Register only after the callback listener has bound its ephemeral port.
    // Authorization servers commonly require the authorization request's
    // redirect_uri to exactly match the value supplied during DCR. A client
    // registered during an earlier acquisition cannot safely be reused here
    // because every listener receives a new random port.
    const client = await dynamicClientRegistration(metadata, fetchImpl, redirectUri);
    const { code, verifier } = await runAuthorizationCodeFlow({
      metadata,
      client,
      redirectUri,
      resourceUrl,
      scopes,
      opener,
      fetchImpl,
      waitForCallback: () => listener.waitForCallback(callbackTimeoutMs),
    });

    const tokenResult = await exchangeCodeForToken({
      metadata,
      client,
      code,
      verifier,
      redirectUri,
      resourceUrl,
      scopes,
      fetchImpl,
    });

    tokenResult.metadata = metadata;
    tokenResult.scopes = scopes;
    tokenResult.resource = resourceUrl;

    await saveSecret(connection.id, scheme.id, tokenResult);
    const key = `${connection.id}:${scheme.id}`;
    cache.set(key, toCached(tokenResult));
    await markAcquired(connection.id, scheme, {
      status: "connected",
      expiresAt: new Date(tokenResult.expiresAt).toISOString(),
    });
    return tokenResult;
  } finally {
    // Stop listeners created by this acquisition on registration,
    // authorization, and token-exchange failures as well as success.
    await listener.close();
  }
}

/** Clear an `oauth_dynamic` scheme's stored token + state. */
export async function clearDynamicOauth(connectionId: string, schemeId: string): Promise<void> {
  const secrets = await getConnectionSecrets(connectionId);
  delete secrets[schemeId];
  await writeConnectionSecrets(connectionId, secrets);
  for (const key of Array.from(cache.keys())) {
    if (key === `${connectionId}:${schemeId}`) cache.delete(key);
  }
  const connection = await getConnection(connectionId);
  const scheme = connection?.auth.schemes.find((s) => s.id === schemeId);
  if (connection && scheme) await markAcquired(connectionId, scheme, { status: "none" });
}

// --- Metadata + DCR ---

/**
 * Discover the authorization server's metadata. The MCP spec (2025-06-18)
 * expects a server to advertise its AS via one of three patterns, tried
 * in order here:
 *
 *  1. **Fast path** — `<resource origin>/.well-known/oauth-authorization-server`
 *     (RFC 8414). The simplest servers publish the metadata at the MCP
 *     server's host root.
 *  2. **RFC 9728 + WWW-Authenticate** — send a probe `initialize` JSON-RPC
 *     request without a token, parse the 401's `WWW-Authenticate` header
 *     for `resource_metadata`, follow it to the protected-resource
 *     document, and read its `authorization_servers` array. For each AS
 *     we then fetch `<as>/.well-known/oauth-authorization-server`. This
 *     is the path real-world servers like Figma's
 *     (`https://mcp.figma.com/mcp`) use — the metadata lives on a
 *     separate origin from the resource path.
 *  3. **Origin-only fallback** — `<resource origin>/.well-known/oauth-authorization-server`
 *     with the path stripped. Last resort for servers that publish at
 *     the host root with a path that doesn't accept the well-known suffix.
 *
 * When none yield a usable metadata document we surface a clear error
 * so the form can show it.
 */
export async function discoverMetadata(
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthMetadata> {
  const origin = new URL(resourceUrl).origin;
  const candidates: string[] = [
    // Strategy 1: same as before, but on the origin (no path). This works
    // when the AS metadata is published at the MCP host root, which is
    // the most common production pattern.
    `${origin}/.well-known/oauth-authorization-server`,
  ];

  // Strategy 2: probe with an unauthenticated initialize. The 401's
  // WWW-Authenticate header carries resource_metadata (RFC 9728).
  const probe = await probeAuthChallenge(resourceUrl, fetchImpl);
  if (probe?.resourceMetadataUrl) {
    const protectedResource = (await fetchJson(
      probe.resourceMetadataUrl,
      fetchImpl,
      "protected-resource document"
    )) as { authorization_servers?: unknown[] } | null;
    if (protectedResource && Array.isArray(protectedResource.authorization_servers)) {
      for (const as of protectedResource.authorization_servers) {
        if (typeof as !== "string") continue;
        candidates.push(`${as.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
      }
    }
  }

  for (const url of candidates) {
    const json = await fetchJson(url, fetchImpl, "authorization server metadata");
    if (!json) continue;
    if (json.authorization_endpoint && json.token_endpoint && json.issuer) {
      return json as OAuthMetadata;
    }
  }

  throw new OAuthDynamicError(
    `MCP server ${resourceUrl} does not advertise an OAuth authorization server. ` +
      "It may not require OAuth, or may need a different URL.",
    "metadata_not_found"
  );
}

/**
 * Send a minimal `initialize` JSON-RPC request without auth. If the server
 * returns 401, parse the `WWW-Authenticate` header and return the
 * `resource_metadata` URL (RFC 9728 §3.1). Returns null on any non-401
 * response or on a missing/empty `resource_metadata` parameter.
 */
async function probeAuthChallenge(
  resourceUrl: string,
  fetchImpl: typeof fetch
): Promise<{ resourceMetadataUrl: string } | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      resourceUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "controller-discovery", version: "1.0" },
          },
        }),
      },
      REQUEST_TIMEOUT_MS
    );
  } catch {
    return null;
  }
  if (res.status !== 401 && res.status !== 403) return null;
  const header = res.headers.get("www-authenticate");
  if (!header) return null;
  const resourceMetadataUrl = parseWwwAuthenticate(header, "resource_metadata");
  if (!resourceMetadataUrl) return null;
  return { resourceMetadataUrl };
}

/**
 * Parse a parameter out of a `WWW-Authenticate` header. The value may be
 * quoted (RFC 7235) and may contain spaces; we use a small state machine
 * instead of a regex so we don't have to worry about ordering or other
 * parameters.
 *
 * Headers in the wild come in two shapes:
 *   - With scheme: `Bearer resource_metadata="…", scope="mcp"` (the
 *     first token before the first space is the auth scheme; the rest
 *     are parameters).
 *   - Without scheme: `resource_metadata="…", scope="mcp"` (rare, but
 *     some MCP servers emit it that way).
 * The parser handles both.
 */
function parseWwwAuthenticate(header: string, parameter: string): string | null {
  const firstSpace = header.indexOf(" ");
  let params: string;
  if (firstSpace < 0) {
    // No spaces → either a single bare token, or a single bare
    // `key=value` pair.
    params = header;
  } else {
    // Heuristic: the first token (before the first space) is the auth
    // scheme ("Bearer", "Basic", …). If it doesn't contain `=` it's the
    // scheme and we drop it; otherwise we treat the whole header as
    // parameters.
    const candidate = header.slice(0, firstSpace);
    params = candidate.includes("=") ? header : header.slice(firstSpace + 1);
  }
  let i = 0;
  while (i < params.length) {
    // Skip whitespace and commas.
    while (i < params.length && (params[i] === " " || params[i] === ",")) i += 1;
    // Read the key up to '='.
    const eq = params.indexOf("=", i);
    if (eq < 0) break;
    const key = params.slice(i, eq).trim();
    i = eq + 1;
    // Skip whitespace after '='.
    while (i < params.length && params[i] === " ") i += 1;
    let value: string;
    if (params[i] === '"') {
      // Quoted string: read until the matching unescaped quote.
      let end = i + 1;
      let buf = "";
      while (end < params.length) {
        const ch = params[end];
        if (ch === "\\" && end + 1 < params.length) {
          buf += params[end + 1];
          end += 2;
          continue;
        }
        if (ch === '"') break;
        buf += ch;
        end += 1;
      }
      value = buf;
      i = end + 1;
    } else {
      // Unquoted token: read until comma or end.
      const end = params.indexOf(",", i);
      value = (end < 0 ? params.slice(i) : params.slice(i, end)).trim();
      i = end < 0 ? params.length : end;
    }
    if (key.toLowerCase() === parameter.toLowerCase()) return value;
  }
  return null;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  label: string
): Promise<Partial<OAuthMetadata> | null> {
  try {
    const res = await fetchWithTimeout(fetchImpl, url, { method: "GET" }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as Partial<OAuthMetadata>;
  } catch (error) {
    if (error instanceof Error && /timed out|abort/i.test(error.message)) {
      throw new OAuthDynamicError(
        `Timed out fetching ${label} from ${url}.`,
        "metadata_not_found"
      );
    }
    return null;
  }
}

/**
 * RFC 7591 dynamic client registration. The MCP spec REQUIRES DCR for
 * servers that don't issue static client ids; the resulting client is then
 * used for the authorization-code flow.
 *
 * Not every AS supports public DCR — Figma's MCP server, for example,
 * returns 403 on this endpoint and requires clients to register via its
 * developer dashboard. The MCP spec calls this out explicitly: "Any
 * authorization servers that do not support Dynamic Client Registration
 * need to provide alternative ways to obtain a client ID. For one of
 * these authorization servers, MCP clients will have to either hardcode
 * a client ID… or present a UI to users that allows them to enter
 * these details, after registering an OAuth client themselves."
 * (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
 * When that happens the error message is the bridge to the manual
 * path — we tell the user the AS rejected the registration and hint at
 * the developer dashboard.
 */
export async function dynamicClientRegistration(
  metadata: OAuthMetadata,
  fetchImpl: typeof fetch = fetch,
  redirectUri?: string
): Promise<DCRClient> {
  const endpoint = metadata.registration_endpoint;
  if (!endpoint) {
    throw new OAuthDynamicError(
      "This authorization server does not advertise a dynamic registration endpoint. " +
        "Register an OAuth client manually at the server's developer dashboard and " +
        "configure the connection with those credentials instead.",
      "dcr_failed"
    );
  }
  const authMethods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : ["none"];
  // Prefer "none" (PKCE public client) when the AS supports it; otherwise
  // fall back to whatever the AS advertises — Figma, for instance, only
  // supports client_secret_basic and client_secret_post, and a registration
  // asking for "none" will be rejected outright.
  const tokenEndpointAuthMethod = authMethods.includes("none")
    ? "none"
    : authMethods[0] ?? "client_secret_basic";
  const body = {
    client_name: "Controller",
    redirect_uris: redirectUri ? [redirectUri] : ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
  const res = await fetchWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    // 403/401/400 all typically mean "closed registration": the AS exists
    // but won't accept a fresh registration from us. Surface the spec's
    // escape hatch in the user-facing message.
    const hint =
      res.status === 401 || res.status === 403
        ? "This server's authorization server does not allow dynamic client registration. " +
          "Register an OAuth client manually at the server's developer dashboard " +
          "(e.g. Figma's developer console) and use the resulting client_id / " +
          "client_secret with a non-dynamic connection instead."
        : `Dynamic client registration failed (HTTP ${res.status}).`;
    throw new OAuthDynamicError(hint, "dcr_failed");
  }
  const json = (await res.json()) as DCRClient;
  if (!json.client_id) {
    throw new OAuthDynamicError("Dynamic client registration returned no client_id.", "dcr_failed");
  }
  return json;
}

export interface DCRClient {
  client_id: string;
  client_secret?: string;
  /** How long the registration stays valid (RFC 7591 §3.2.1). */
  client_id_expires_at?: number;
  redirect_uris?: string[];
}

// --- Authorization-code + PKCE ---

/*
 * The loopback listener: a tiny HTTP server that handles a single redirect
 * carrying the authorization code. It lives only for the duration of one
 * acquisition; the caller passes the listener's redirect_uri to the
 * authorization request and closes that listener when the flow ends.
 */
interface CallbackPayload {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

interface AuthorizationCodeFlowInput {
  metadata: OAuthMetadata;
  client: DCRClient;
  redirectUri: string;
  resourceUrl: string;
  scopes: string;
  opener: (url: string) => Promise<void> | void;
  fetchImpl: typeof fetch;
  waitForCallback: () => Promise<CallbackPayload>;
}

async function runAuthorizationCodeFlow(input: AuthorizationCodeFlowInput): Promise<{
  code: string;
  state: string;
  verifier: string;
}> {
  const { metadata, client, redirectUri, resourceUrl, scopes, opener, waitForCallback } = input;
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (scopes) authorizeUrl.searchParams.set("scope", scopes);
  // RFC 8707: bind the token to the MCP server's URL.
  authorizeUrl.searchParams.set("resource", resourceUrl);

  // Set up the callback waiter *before* opening the browser, so we can't
  // miss the redirect when the AS bounces the user back quickly.
  const payloadPromise = waitForCallback();
  // The opener is normally immediate, but attach a rejection handler now so
  // a very short callback timeout cannot become an unhandled rejection while
  // the opener is still pending. Awaiting the original promise below still
  // preserves the rejection for the caller.
  void payloadPromise.catch(() => {});

  await opener(authorizeUrl.toString());
  const payload = await payloadPromise;

  if (payload.error) {
    throw new OAuthDynamicError(
      `Authorization server error: ${payload.error}${payload.errorDescription ? ` — ${payload.errorDescription}` : ""}`,
      "as_error"
    );
  }
  if (payload.state !== state) {
    throw new OAuthDynamicError("Authorization callback state did not match.", "invalid_state");
  }
  if (!payload.code) {
    throw new OAuthDynamicError("Authorization callback did not include a code.", "as_error");
  }
  return { code: payload.code, state: payload.state, verifier };
}

interface LoopbackListener {
  redirectUri: string;
  waitForCallback: (timeoutMs: number) => Promise<CallbackPayload>;
  close: () => Promise<void>;
}

async function startLoopbackListener(): Promise<LoopbackListener> {
  let pendingCallback: {
    resolve: (v: CallbackPayload) => void;
    reject: (e: Error) => void;
  } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? undefined;
    const errorDescription = url.searchParams.get("error_description") ?? undefined;
    if (pendingCallback) {
      const { resolve } = pendingCallback;
      pendingCallback = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({ code, state, error, errorDescription });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Controller</title>" +
        "<p style=\"font-family:sans-serif\">You can close this tab and return to Controller.</p>"
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}/callback`,
    waitForCallback: (timeoutMs) => {
      if (closed) {
        return Promise.reject(
          new OAuthDynamicError("Authorization listener stopped before callback.", "as_error")
        );
      }
      if (pendingCallback) {
        return Promise.reject(
          new OAuthDynamicError("Authorization callback is already pending.", "as_error")
        );
      }
      return new Promise<CallbackPayload>((resolve, reject) => {
        pendingCallback = { resolve, reject };
        timer = setTimeout(() => {
          if (!pendingCallback) return;
          pendingCallback = null;
          timer = null;
          reject(new OAuthDynamicError("Authorization callback timed out.", "callback_timeout"));
        }, timeoutMs);
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingCallback) {
        const { reject } = pendingCallback;
        pendingCallback = null;
        reject(new OAuthDynamicError("Authorization listener stopped before callback.", "as_error"));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ExchangeInput {
  metadata: OAuthMetadata;
  client: DCRClient;
  code: string;
  verifier: string;
  redirectUri: string;
  resourceUrl: string;
  scopes: string;
  fetchImpl: typeof fetch;
}

async function exchangeCodeForToken(input: ExchangeInput): Promise<OAuthDynamicSecret> {
  const { metadata, client, code, verifier, redirectUri, resourceUrl, scopes, fetchImpl } = input;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  if (scopes) body.set("scope", scopes);
  body.set("resource", resourceUrl);

  const res = await fetchWithTimeout(
    fetchImpl,
    metadata.token_endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    REQUEST_TIMEOUT_MS
  );
  const json = (await parseTokenResponse(res)) as Record<string, unknown>;
  return tokenResponseToSecret(json, client, metadata);
}

async function refreshAccessToken(stored: OAuthDynamicSecret, fetchImpl: typeof fetch = fetch): Promise<OAuthDynamicSecret> {
  if (!stored.refreshToken) {
    throw new OAuthDynamicError("No refresh token available.", "refresh_failed");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  });
  if (stored.clientSecret) body.set("client_secret", stored.clientSecret);
  if (stored.scopes) body.set("scope", stored.scopes);
  if (stored.resource) body.set("resource", stored.resource);

  const res = await fetchWithTimeout(
    fetchImpl,
    stored.metadata.token_endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new OAuthDynamicError(`Token refresh failed (HTTP ${res.status}).`, "refresh_failed");
  }
  const json = (await parseTokenResponse(res)) as Record<string, unknown>;
  // Refresh responses don't always include a new refresh_token; keep the
  // existing one when the AS omits it.
  if (!json.refresh_token && stored.refreshToken) json.refresh_token = stored.refreshToken;
  return tokenResponseToSecret(
    json,
    { client_id: stored.clientId, client_secret: stored.clientSecret },
    stored.metadata,
    {
      clientSecret: stored.clientSecret,
      scopes: stored.scopes,
      resource: stored.resource,
    }
  );
}

async function parseTokenResponse(res: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) {
      throw new OAuthDynamicError(
        `Token endpoint returned HTTP ${res.status}.`,
        "token_exchange_failed"
      );
    }
    throw new OAuthDynamicError("Token endpoint returned a non-JSON response.", "as_error");
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body && (body as { error_description?: string }).error_description
        ? (body as { error_description?: string }).error_description
        : typeof body === "object" && body && (body as { error?: string }).error
          ? (body as { error?: string }).error
          : `HTTP ${res.status}`;
    throw new OAuthDynamicError(`Token endpoint error: ${message}`, "token_exchange_failed");
  }
  return body;
}

function tokenResponseToSecret(
  json: Record<string, unknown>,
  client: { client_id: string; client_secret?: string },
  metadata: OAuthMetadata,
  // The previous secret, when refreshing. Carries forward fields the
  // token endpoint doesn't echo on a refresh response: clientSecret,
  // scopes, resource. Without this, ASes that require the same client
  // secret / scope / resource on every refresh call would accept the
  // first refresh and then start failing.
  prior?: { clientSecret?: string; scopes?: string; resource?: string }
): OAuthDynamicSecret {
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new OAuthDynamicError("Token response did not include an access_token.", "as_error");
  }
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : undefined;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
    clientId: client.client_id,
    // The freshest value wins: a refresh response can rotate the
    // client_secret (rare but allowed by RFC 7591 §3.2.1). Otherwise
    // carry forward the stored value.
    clientSecret: client.client_secret ?? prior?.clientSecret,
    metadata,
    scopes: prior?.scopes,
    resource: prior?.resource,
  };
}

// --- Persistence helpers ---

async function loadSecret(connectionId: string, schemeId: string): Promise<OAuthDynamicSecret | null> {
  const secrets = await getConnectionSecrets(connectionId);
  const raw = secrets[schemeId];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OAuthDynamicSecret;
    if (!parsed.accessToken || !parsed.metadata) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSecret(
  connectionId: string,
  schemeId: string,
  value: OAuthDynamicSecret
): Promise<void> {
  const secrets = await getConnectionSecrets(connectionId);
  secrets[schemeId] = JSON.stringify(value);
  await writeConnectionSecrets(connectionId, secrets);
}

function toCached(secret: OAuthDynamicSecret): CachedToken {
  return {
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt,
  };
}

async function markAcquired(
  connectionId: string,
  scheme: AuthScheme,
  acquired: AcquiredState
): Promise<void> {
  await updateSchemeAcquired(connectionId, scheme.id, acquired);
}
