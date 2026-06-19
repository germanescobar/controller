/*
 * Descriptor that drives the integration-connection form (issue #130).
 *
 * The form is data-driven from two orthogonal axes: a transport (connection
 * mode) and an auth scheme set. A connection's auth is a list of scheme
 * instances; each scheme has a type drawn from AUTH_SCHEME_TYPES, a few
 * non-secret config fields, and at most one secret value. Keeping this as data
 * means adding a field or scheme type is a data change, and the server stays
 * generic.
 *
 * The single `secret` per scheme is written to the keychain-encrypted store and
 * never read back; the form shows it as "configured" via the scheme's
 * hasSecret flag. Acquired schemes (OAuth) carry an `acquisition` note instead
 * of a pasted secret; acquisition itself is not implemented yet.
 */

import type { ConnectionMode, Acquisition, Attachment } from "../api.ts";

export interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}

export interface ConnectionModeSpec {
  id: ConnectionMode;
  label: string;
  description: string;
  fields: FieldSpec[];
  /**
   * HTTP-family transports can carry constant request headers (API-version
   * pins like Notion-Version, Accept, etc.). The form renders non-secret
   * name→value rows for these.
   */
  supportsHeaders?: boolean;
  /** OpenAPI transports can derive their auth scheme set from the spec. */
  derivesAuth?: boolean;
  /**
   * CLI-native integrations manage their own auth (the user runs the CLI's own
   * sign-in). The auth axis does not apply.
   */
  managesOwnAuth?: boolean;
}

/**
 * A friendly named option over the (acquisition × attachment) axes. Presets
 * keep the UI approachable while the stored model stays the clean two-axis one:
 * "Bearer token" and "API key (query)" are both `static` acquisitions that
 * differ only in attachment.
 */
export interface AuthPreset {
  id: string;
  label: string;
  description: string;
  acquisition: Acquisition;
  /** Default attachment; omitted for signing/transport presets (hmac/mtls/cloud). */
  attachment?: Attachment;
  /** When set, the user edits the attachment name (API key header/query). */
  attachmentNameField?: { label: string; placeholder?: string };
  /** Non-secret config fields. */
  fields: FieldSpec[];
  /** The single secret value this preset stores, if any. */
  secret?: { label: string; optional?: boolean };
  /** Present when Controller acquires the credential rather than the user pasting it. */
  acquisitionNote?: { interactive: boolean; note: string };
  /**
   * Hidden from the "add scheme" picker because it isn't usable yet (the
   * resolver reports it unsupported). Still kept in the list so stored or
   * spec-derived schemes of this kind classify and render correctly.
   */
  hidden?: boolean;
}

export const CONNECTION_MODES: ConnectionModeSpec[] = [
  {
    id: "rest",
    label: "REST",
    description: "Generic REST/HTTP backend reached via the request escape hatch.",
    fields: [{ key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com" }],
    supportsHeaders: true,
  },
  {
    id: "graphql",
    label: "GraphQL",
    description: "GraphQL endpoint queried via the request escape hatch.",
    fields: [{ key: "endpoint", label: "Endpoint URL", placeholder: "https://api.example.com/graphql" }],
    supportsHeaders: true,
  },
  {
    id: "openapi",
    label: "OpenAPI",
    description: "Schema-backed backend; tools and auth are derived from an OpenAPI spec.",
    fields: [
      { key: "specUrl", label: "Spec URL", placeholder: "https://api.example.com/openapi.json" },
      { key: "baseUrl", label: "Base URL", placeholder: "Derived from the spec", optional: true },
    ],
    supportsHeaders: true,
    derivesAuth: true,
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Model Context Protocol server with structured tools.",
    fields: [
      { key: "command", label: "Command", placeholder: "npx -y @modelcontextprotocol/server-x", optional: true },
      { key: "url", label: "URL", placeholder: "https://mcp.example.com (for remote servers)", optional: true },
    ],
    supportsHeaders: true,
  },
  {
    id: "cli",
    label: "CLI-native",
    description:
      "Points the agent at an installed CLI (aws, gcloud, gh, ntn) — not proxied. The CLI manages its own auth.",
    managesOwnAuth: true,
    fields: [
      { key: "binary", label: "Binary", placeholder: "ntn" },
      { key: "loginCommand", label: "Login command", placeholder: "ntn login", optional: true },
      { key: "checkCommand", label: "Verify command", placeholder: "ntn whoami", optional: true },
    ],
  },
];

const BEARER_ATTACHMENT: Attachment = { kind: "header", name: "Authorization", prefix: "Bearer " };

export const AUTH_PRESETS: AuthPreset[] = [
  {
    id: "bearer",
    label: "Bearer token",
    description: "A token attached as Authorization: Bearer.",
    acquisition: "static",
    attachment: BEARER_ATTACHMENT,
    secret: { label: "Token" },
    fields: [],
  },
  {
    id: "header_key",
    label: "Custom Header",
    description: "A secret value sent in a named request header.",
    acquisition: "static",
    attachment: { kind: "header", name: "", prefix: "" },
    attachmentNameField: { label: "Header name", placeholder: "X-API-Key" },
    secret: { label: "Header value" },
    fields: [],
  },
  {
    id: "query_key",
    label: "Custom Query Param",
    description: "A secret value attached to the URL as a query parameter (e.g. Trello key/token).",
    acquisition: "static",
    attachment: { kind: "query", name: "" },
    attachmentNameField: { label: "Parameter name", placeholder: "key" },
    secret: { label: "Value" },
    fields: [],
  },
  {
    id: "basic",
    label: "Basic auth",
    description: "Username and password sent as HTTP Basic.",
    acquisition: "basic",
    attachment: { kind: "header", name: "Authorization", prefix: "Basic " },
    secret: { label: "Password" },
    fields: [{ key: "username", label: "Username" }],
  },
  {
    id: "oauth",
    label: "OAuth (user)",
    description: "Controller runs an interactive OAuth flow; the token attaches as a bearer.",
    acquisition: "oauth",
    attachment: BEARER_ATTACHMENT,
    secret: { label: "Client secret", optional: true },
    acquisitionNote: {
      interactive: true,
      note: "Controller obtains the access token via a browser sign-in. The agent never performs this step.",
    },
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "authUrl", label: "Authorization URL", placeholder: "https://example.com/oauth/authorize" },
      { key: "tokenUrl", label: "Token URL", placeholder: "https://example.com/oauth/token" },
      { key: "scopes", label: "Scopes", placeholder: "read write", optional: true },
    ],
    // Deferred: needs the interactive browser-redirect acquisition flow.
    hidden: true,
  },
  {
    id: "oauth_client_credentials",
    label: "OAuth (client credentials)",
    description: "Machine-to-machine OAuth; the fetched token attaches as a bearer.",
    acquisition: "oauth_client_credentials",
    attachment: BEARER_ATTACHMENT,
    secret: { label: "Client secret" },
    acquisitionNote: {
      interactive: false,
      note: "Controller fetches the token automatically from the token URL on first use.",
    },
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "tokenUrl", label: "Token URL", placeholder: "https://example.com/oauth/token" },
      { key: "scopes", label: "Scopes", placeholder: "read write", optional: true },
    ],
  },
  {
    id: "oauth_dynamic",
    label: "OAuth (dynamic / MCP)",
    description:
      "For MCP and other servers that advertise OAuth via metadata. Controller discovers the authorization server and registers a client automatically — no client ID/secret to paste.",
    acquisition: "oauth_dynamic",
    attachment: BEARER_ATTACHMENT,
    acquisitionNote: {
      interactive: true,
      note: "Controller discovers the authorization server, registers dynamically, and signs you in via the browser. The agent never performs this step.",
    },
    fields: [{ key: "scopes", label: "Scopes", placeholder: "read write", optional: true }],
    // Deferred: relies on the same browser-redirect acquisition flow.
    hidden: true,
  },
  {
    id: "cloud",
    label: "Cloud-native",
    description: "Cloud provider credentials (AWS keys/profile, etc.).",
    acquisition: "cloud",
    secret: { label: "Secret access key", optional: true },
    fields: [
      { key: "profile", label: "Profile", placeholder: "default", optional: true },
      { key: "region", label: "Region", placeholder: "us-east-1", optional: true },
      { key: "accessKeyId", label: "Access key ID", optional: true },
    ],
    hidden: true,
  },
  {
    id: "hmac",
    label: "HMAC",
    description: "Requests signed with an HMAC key pair.",
    acquisition: "hmac",
    secret: { label: "Secret key" },
    fields: [{ key: "keyId", label: "Key ID" }],
    hidden: true,
  },
  {
    id: "mtls",
    label: "mTLS",
    description: "Mutual TLS using a client certificate and key.",
    acquisition: "mtls",
    fields: [
      { key: "clientCertPath", label: "Client cert path", placeholder: "/path/to/client.crt" },
      { key: "clientKeyPath", label: "Client key path", placeholder: "/path/to/client.key" },
    ],
    hidden: true,
  },
];

export function connectionModeSpec(id: ConnectionMode): ConnectionModeSpec {
  return CONNECTION_MODES.find((m) => m.id === id) ?? CONNECTION_MODES[0];
}

export function authPreset(id: string): AuthPreset {
  return AUTH_PRESETS.find((p) => p.id === id) ?? AUTH_PRESETS[0];
}

/** Classify a stored scheme back to the preset that best represents it. */
export function presetForScheme(scheme: {
  acquisition: Acquisition;
  attachment?: Attachment;
}): AuthPreset {
  const { acquisition, attachment } = scheme;
  if (acquisition === "static") {
    if (attachment?.kind === "query") return authPreset("query_key");
    if (
      attachment?.kind === "header" &&
      attachment.name === "Authorization" &&
      (attachment.prefix ?? "") === "Bearer "
    ) {
      return authPreset("bearer");
    }
    return authPreset("header_key");
  }
  const direct = AUTH_PRESETS.find((p) => p.acquisition === acquisition);
  return direct ?? authPreset("bearer");
}
