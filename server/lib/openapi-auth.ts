/*
 * Derive an auth scheme set from an OpenAPI spec (issue #130).
 *
 * OpenAPI declares auth formally in `components.securitySchemes` and applies it
 * via a `security` array. The array is a list of OR alternatives; the keys
 * within one alternative are ANDed (all required together). Each scheme maps
 * onto one of our `AuthSchemeType`s, so an OpenAPI connection can derive its
 * scheme set instead of the user hand-modeling it — they only supply secret
 * values. Trello, for example, yields one alternative requiring two `query_key`
 * schemes (`key` and `token`).
 */

import type { Acquisition, Attachment } from "./integrations.js";

/** A scheme derived from the spec, ready to seed a connection's auth set. */
export interface DerivedScheme {
  acquisition: Acquisition;
  attachment?: Attachment;
  config: Record<string, string>;
  /** The spec's name for this scheme (e.g. "APIKey"), shown in the UI. */
  label: string;
}

/** One OR alternative: an AND-set of schemes that together satisfy auth. */
export interface SchemeAlternative {
  schemes: DerivedScheme[];
}

export interface OpenApiAuthInfo {
  /** `info.title` from the spec, used to suggest a connection name. */
  title?: string;
  baseUrl?: string;
  alternatives: SchemeAlternative[];
  /** Security-scheme names the spec declared but we can't map. */
  unsupported: string[];
}

const MAX_SPEC_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** Fetch an OpenAPI spec by URL and derive its auth info. */
export async function fetchOpenApiAuth(specUrl: string): Promise<OpenApiAuthInfo> {
  let url: URL;
  try {
    url = new URL(specUrl);
  } catch {
    throw new Error("Spec URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Spec URL must be http(s).");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Spec request failed (HTTP ${res.status}).`);
    text = await readBounded(res);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out fetching the spec.");
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeout);
  }

  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new Error("Spec is not valid JSON (YAML specs aren't supported yet).");
  }
  return parseOpenApiAuth(spec);
}

/** Pure: extract base URL and the auth scheme alternatives from a spec object. */
export function parseOpenApiAuth(spec: unknown): OpenApiAuthInfo {
  const root = asRecord(spec) ?? {};
  const title = asRecord(root.info)?.title;
  const baseUrl = firstServerUrl(root);
  const schemes = asRecord(asRecord(root.components)?.securitySchemes) ?? {};
  const security = Array.isArray(root.security) ? root.security : [];

  const unsupported = new Set<string>();
  const alternatives: SchemeAlternative[] = [];

  for (const entry of security) {
    const requirement = asRecord(entry);
    if (!requirement) continue;
    const derived: DerivedScheme[] = [];
    for (const name of Object.keys(requirement)) {
      const mapped = mapScheme(name, asRecord(schemes[name]));
      if (mapped) derived.push(mapped);
      else unsupported.add(name);
    }
    if (derived.length > 0) alternatives.push({ schemes: derived });
  }

  return {
    title: typeof title === "string" ? title : undefined,
    baseUrl,
    alternatives,
    unsupported: [...unsupported],
  };
}

const BEARER: Attachment = { kind: "header", name: "Authorization", prefix: "Bearer " };

function mapScheme(
  name: string,
  scheme: Record<string, unknown> | null
): DerivedScheme | null {
  if (!scheme) return null;
  const type = String(scheme.type ?? "");

  if (type === "apiKey") {
    const paramName = typeof scheme.name === "string" ? scheme.name : "";
    if (!paramName) return null;
    // An apiKey is a static value placed in a header or query param.
    if (scheme.in === "query") {
      return { acquisition: "static", attachment: { kind: "query", name: paramName }, config: {}, label: name };
    }
    if (scheme.in === "header") {
      return {
        acquisition: "static",
        attachment: { kind: "header", name: paramName, prefix: "" },
        config: {},
        label: name,
      };
    }
    return null; // cookie apiKeys aren't supported
  }

  if (type === "http") {
    const httpScheme = String(scheme.scheme ?? "").toLowerCase();
    if (httpScheme === "bearer") {
      return { acquisition: "static", attachment: BEARER, config: {}, label: name };
    }
    if (httpScheme === "basic") {
      return {
        acquisition: "basic",
        attachment: { kind: "header", name: "Authorization", prefix: "Basic " },
        config: {},
        label: name,
      };
    }
    return null;
  }

  if (type === "oauth2") {
    const flows = asRecord(scheme.flows) ?? {};
    const flowNames = Object.keys(flows);
    const onlyClientCreds = flowNames.length === 1 && flowNames[0] === "clientCredentials";
    return {
      acquisition: onlyClientCreds ? "oauth_client_credentials" : "oauth",
      attachment: BEARER,
      config: oauthConfig(flows),
      label: name,
    };
  }

  if (type === "openIdConnect") {
    const url = typeof scheme.openIdConnectUrl === "string" ? scheme.openIdConnectUrl : "";
    return { acquisition: "oauth", attachment: BEARER, config: url ? { openIdConnectUrl: url } : {}, label: name };
  }

  if (type === "mutualTLS") return { acquisition: "mtls", config: {}, label: name };

  return null;
}

/* Pull token/authorization URLs and scopes out of whichever flow the spec defines. */
function oauthConfig(flows: Record<string, unknown>): Record<string, string> {
  const config: Record<string, string> = {};
  for (const flow of Object.values(flows)) {
    const f = asRecord(flow);
    if (!f) continue;
    if (typeof f.tokenUrl === "string" && !config.tokenUrl) config.tokenUrl = f.tokenUrl;
    if (typeof f.authorizationUrl === "string" && !config.authUrl) config.authUrl = f.authorizationUrl;
    const scopes = asRecord(f.scopes);
    if (scopes && !config.scopes) {
      const names = Object.keys(scopes);
      if (names.length > 0) config.scopes = names.join(" ");
    }
  }
  return config;
}

function firstServerUrl(root: Record<string, unknown>): string | undefined {
  const servers = root.servers;
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const first = asRecord(servers[0]);
  return first && typeof first.url === "string" ? first.url : undefined;
}

async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SPEC_BYTES) {
    throw new Error("Spec is too large.");
  }
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new Error("Spec is too large.");
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
