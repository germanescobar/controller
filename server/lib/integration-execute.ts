/*
 * Outbound execution for API-style integrations (issue #130).
 *
 * Turns a stored connection + a request into an actual HTTP call, injecting the
 * resolved auth server-side so the agent never sees a credential. The transport
 * supplies the base URL and any constant headers/query params; `resolveAuth`
 * supplies the credential material; the caller (the `request` escape hatch or a
 * schema-backed `call`) supplies the method, path, and args.
 *
 * All responses are bounded — bodies are truncated — because agents consume the
 * output and large payloads would blow their context.
 */

import { getConnectionSecrets, type IntegrationConnection } from "./integrations.js";
import { resolveAuth, type ResolvedAuth } from "./integration-auth.js";
import { acquireOAuthToken } from "./oauth-client-credentials.js";

const MAX_BODY_CHARS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestInput {
  method: string;
  /** Path appended to the connection's base URL (or a full URL). */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Raw string or a JSON-serializable object (sent as application/json). */
  body?: string | Record<string, unknown> | null;
}

export type ExecResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      contentType: string | null;
      body: string;
      truncated: boolean;
    }
  | { ok: false; error: string; reauth?: { reason: "acquire" | "unsupported"; message: string } };

/** Resolve a connection's auth, fetching acquired tokens (client-credentials) as needed. */
export async function resolveConnectionAuth(
  connection: IntegrationConnection
): Promise<ReturnType<typeof resolveAuth>> {
  const secrets = await getConnectionSecrets(connection.id);
  // Fill in tokens Controller can acquire without user interaction.
  for (const scheme of connection.auth.schemes) {
    if (scheme.acquisition === "oauth_client_credentials") {
      const token = await acquireOAuthToken(connection.id, scheme, secrets[scheme.id]);
      if (token) secrets[scheme.id] = token;
    }
  }
  return resolveAuth(connection.auth.schemes, secrets);
}

/** Make an HTTP request against an API-style connection with auth injected. */
export async function executeRequest(
  connection: IntegrationConnection,
  input: RequestInput
): Promise<ExecResult> {
  const base = baseUrlFor(connection);
  if (!base) return { ok: false, error: "This connection has no base URL configured." };
  const baseOrigin = safeOrigin(base);
  if (!baseOrigin) return { ok: false, error: "This connection's base URL is invalid." };

  const url = buildUrl(base, input.path);
  if (!url) return { ok: false, error: "Invalid request path." };

  // Credentials are pinned to the connection's host: never attach this
  // connection's auth to a different origin (e.g. a prompt-injected absolute
  // URL to an attacker host). Same-origin absolute URLs are fine.
  if (url.origin !== baseOrigin) {
    return {
      ok: false,
      error:
        `Refusing to send credentials to ${url.origin}: it is not this connection's host ` +
        `(${baseOrigin}). Use a path relative to the base URL.`,
    };
  }

  const auth = await resolveConnectionAuth(connection);
  if (auth.status !== "ready") {
    return { ok: false, error: auth.message, reauth: { reason: auth.reason, message: auth.message } };
  }

  applyQuery(url, connection.transport.query, auth.resolved, input.query);
  const headers = buildHeaders(connection.transport.headers, auth.resolved, input.headers);
  const { body, contentType } = buildBody(input.body);
  if (contentType && !hasHeader(headers, "content-type")) headers["Content-Type"] = contentType;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: input.method.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
      truncated: text.length > MAX_BODY_CHARS,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Request timed out." };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lightweight health/whoami check: confirm auth resolves and, when there's a
 * base URL, that it's reachable. Generic — it can't know a service's real
 * whoami endpoint, so it reports auth readiness plus a base-URL probe.
 */
export async function checkStatus(
  connection: IntegrationConnection
): Promise<{ ok: boolean; message: string; reauth?: { reason: string; message: string } }> {
  const auth = await resolveConnectionAuth(connection);
  if (auth.status !== "ready") {
    return { ok: false, message: auth.message, reauth: { reason: auth.reason, message: auth.message } };
  }
  const base = baseUrlFor(connection);
  if (!base) return { ok: true, message: "Authentication is configured." };

  const probe = await executeRequest(connection, { method: "GET", path: "" });
  if (!probe.ok) return { ok: false, message: probe.error, reauth: probe.reauth };
  return {
    ok: probe.status < 400,
    message: `Reached ${base} — HTTP ${probe.status} ${probe.statusText}.`,
  };
}

// --- helpers ---

function baseUrlFor(connection: IntegrationConnection): string | null {
  const { mode, config } = connection.transport;
  if (mode === "graphql") return config.endpoint?.trim() || null;
  return config.baseUrl?.trim() || null; // rest, openapi
}

/** scheme+host+port of a URL string, or null if it isn't a valid http(s) URL. */
function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/* Join a base URL and a path, tolerating absolute paths and full URLs. */
function buildUrl(base: string | null, path: string): URL | null {
  const p = (path ?? "").trim();
  try {
    if (/^https?:\/\//i.test(p)) return new URL(p);
    if (!base) return null;
    const trimmedBase = base.replace(/\/+$/, "");
    const suffix = p ? (p.startsWith("/") ? p : `/${p}`) : "";
    return new URL(`${trimmedBase}${suffix}`);
  } catch {
    return null;
  }
}

function applyQuery(
  url: URL,
  transportQuery: Record<string, string>,
  auth: ResolvedAuth,
  callerQuery: Record<string, string> | undefined
): void {
  // Precedence (low -> high): transport constants, caller args, auth credentials.
  for (const [k, v] of Object.entries(transportQuery)) url.searchParams.set(k, v);
  for (const [k, v] of Object.entries(callerQuery ?? {})) url.searchParams.set(k, v);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
}

function buildHeaders(
  transportHeaders: Record<string, string>,
  auth: ResolvedAuth,
  callerHeaders: Record<string, string> | undefined
): Record<string, string> {
  // Auth headers win over caller and transport on a name clash.
  return { ...transportHeaders, ...(callerHeaders ?? {}), ...auth.headers };
}

function buildBody(
  body: RequestInput["body"]
): { body: string | undefined; contentType: string | null } {
  if (body === undefined || body === null) return { body: undefined, contentType: null };
  if (typeof body === "string") return { body, contentType: null };
  return { body: JSON.stringify(body), contentType: "application/json" };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}
