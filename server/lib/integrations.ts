/*
 * Integration connection registry (issue #130).
 *
 * A connection is two orthogonal axes that compose:
 *
 *   - transport (how we reach the backend: REST/GraphQL/OpenAPI over HTTP, MCP,
 *     or a native CLI)
 *   - auth (how credentials are obtained and attached)
 *
 * Auth is an AND-set of scheme instances, and each scheme is itself two
 * orthogonal pieces: an *acquisition* (how the credential value is produced)
 * and an *attachment* (where the value is placed on the request). This is why
 * an API token, a Trello query key, and an OAuth access token are nearly the
 * same thing — they differ only in acquisition; most attach the same way (a
 * header or a query param). The UI offers friendly presets over these two axes.
 *
 * This module owns persistence only. Non-secret metadata lives in
 * `integrations.json`; secret values live in the keychain-encrypted store keyed
 * by scheme id, and are never returned to the client.
 */

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { integrationsFile, integrationSecretsFile, ensureOrchestratorHome } from "./paths.js";
import { readSecretJson, writeSecretJson } from "./secret-store.js";

/** How Controller reaches the backend. See the UI descriptor for fields. */
export type ConnectionMode = "mcp" | "openapi" | "rest" | "graphql" | "cli";

/** How a credential value is produced. */
export type Acquisition =
  | "static" // the user pastes the value (stored as the scheme's secret)
  | "basic" // value = base64(username:password); password is the secret
  | "oauth" // value = an access token acquired via interactive OAuth
  | "oauth_client_credentials" // value = an access token fetched machine-to-machine
  | "oauth_dynamic" // value = an access token via OAuth dynamic client registration (MCP)
  | "cloud" // cloud provider credentials (env / SigV4)
  | "hmac" // per-request signature (no static value)
  | "mtls"; // client certificate at the TLS layer

/** Acquisitions whose credential Controller obtains rather than the user pasting. */
export const ACQUIRED_ACQUISITIONS: ReadonlySet<Acquisition> = new Set<Acquisition>([
  "oauth",
  "oauth_client_credentials",
  "oauth_dynamic",
  "cloud",
]);

/** Acquisitions that yield a value placed via an attachment (vs. signing/transport). */
export const ATTACHABLE_ACQUISITIONS: ReadonlySet<Acquisition> = new Set<Acquisition>([
  "static",
  "basic",
  "oauth",
  "oauth_client_credentials",
  "oauth_dynamic",
]);

/** Where a produced credential value is placed on the request. */
export interface Attachment {
  kind: "header" | "query";
  name: string;
  /** Header only: prepended to the value (e.g. "Bearer "). */
  prefix?: string;
}

/**
 * State of a credential Controller acquires on the user's behalf (OAuth tokens,
 * STS sessions). Material lives in the encrypted store; this tracks status for
 * the UI and the re-auth signal. Acquisition isn't implemented yet — acquired
 * schemes start `none`.
 */
export interface AcquiredState {
  status: "none" | "connected" | "expired";
  expiresAt?: string;
}

/** A configured auth scheme. Carries no secret value, only whether one is set. */
export interface AuthScheme {
  id: string;
  acquisition: Acquisition;
  /** Present for attachable acquisitions; absent for hmac/mtls/cloud. */
  attachment?: Attachment;
  /** Non-secret per-scheme fields (username, client id, URLs, key id, ...). */
  config: Record<string, string>;
  hasSecret: boolean;
  /** Present only for acquired-credential acquisitions. */
  acquired?: AcquiredState;
}

/** Transport axis: how to reach the backend. All fields are non-secret. */
export interface TransportConfig {
  mode: ConnectionMode;
  config: Record<string, string>;
  /**
   * Constant headers applied to every request by HTTP-family transports, e.g.
   * Notion's mandatory `Notion-Version`. Not credentials; the future executor
   * merges them with resolved auth headers (auth wins on clash).
   */
  headers: Record<string, string>;
  /**
   * Constant query params applied to every request, e.g. Azure's required
   * `api-version`. Not credentials (use a `query_key` auth scheme for those);
   * merged with resolved auth query params (auth wins on clash).
   */
  query: Record<string, string>;
}

export interface AuthConfig {
  schemes: AuthScheme[];
}

export interface IntegrationConnection {
  id: string;
  name: string;
  transport: TransportConfig;
  auth: AuthConfig;
  createdAt: string;
  updatedAt: string;
}

export interface TransportInput {
  mode: ConnectionMode;
  config?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** A scheme on write. `id` ties it to an existing scheme so its secret is kept. */
export interface AuthSchemeInput {
  id?: string;
  acquisition: Acquisition;
  attachment?: Attachment;
  config?: Record<string, string>;
  /** undefined = keep stored secret; "" = clear it; non-empty = set it. */
  secret?: string;
}

export interface AuthInput {
  schemes: AuthSchemeInput[];
}

export interface ConnectionInput {
  name: string;
  transport: TransportInput;
  auth: AuthInput;
}

/** Connection id -> { scheme id -> secret value }. */
type SecretStore = Record<string, Record<string, string>>;

export async function listConnections(): Promise<IntegrationConnection[]> {
  return readRegistry();
}

export async function getConnection(id: string): Promise<IntegrationConnection | null> {
  const registry = await readRegistry();
  return registry.find((c) => c.id === id) ?? null;
}

export async function createConnection(
  input: ConnectionInput
): Promise<IntegrationConnection> {
  const registry = await readRegistry();
  const now = new Date().toISOString();

  const id = randomUUID();
  const secrets: Record<string, string> = {};
  const schemes = input.auth.schemes.map((s) => {
    const schemeId = randomUUID();
    const secret = s.secret?.trim();
    if (secret) secrets[schemeId] = secret;
    return buildScheme(schemeId, s, !!secret, undefined);
  });

  const connection: IntegrationConnection = {
    id,
    name: input.name.trim(),
    transport: {
      mode: input.transport.mode,
      config: input.transport.config ?? {},
      headers: input.transport.headers ?? {},
      query: input.transport.query ?? {},
    },
    auth: { schemes },
    createdAt: now,
    updatedAt: now,
  };

  registry.push(connection);
  await writeRegistry(registry);
  if (Object.keys(secrets).length > 0) await writeConnectionSecrets(id, secrets);
  return connection;
}

export async function updateConnection(
  id: string,
  patch: Partial<ConnectionInput>
): Promise<IntegrationConnection | null> {
  const registry = await readRegistry();
  const existing = registry.find((c) => c.id === id);
  if (!existing) return null;

  if (patch.name !== undefined) existing.name = patch.name.trim();

  if (patch.transport !== undefined) {
    existing.transport = {
      mode: patch.transport.mode,
      config: patch.transport.config ?? {},
      headers: patch.transport.headers ?? {},
      query: patch.transport.query ?? {},
    };
  }

  if (patch.auth !== undefined) {
    existing.auth.schemes = await reconcileSchemes(id, existing.auth.schemes, patch.auth.schemes);
  }

  existing.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return existing;
}

export async function deleteConnection(id: string): Promise<boolean> {
  const registry = await readRegistry();
  const next = registry.filter((c) => c.id !== id);
  if (next.length === registry.length) return false;
  await writeRegistry(next);
  await removeConnectionSecrets(id);
  return true;
}

/**
 * Read a connection's secret values keyed by scheme id. For server-side auth
 * resolution only — never exposed through the HTTP surface.
 */
export async function getConnectionSecrets(id: string): Promise<Record<string, string>> {
  const store = await readSecrets();
  return store[id] ?? {};
}

// --- Scheme reconciliation ---

/*
 * Rebuild a connection's scheme set from the submitted input, preserving stored
 * secrets and acquired state for schemes the client carried back by id. Schemes
 * the client dropped are removed along with their secrets.
 */
async function reconcileSchemes(
  connectionId: string,
  current: AuthScheme[],
  inputs: AuthSchemeInput[]
): Promise<AuthScheme[]> {
  const store = await readSecrets();
  const secrets = { ...(store[connectionId] ?? {}) };
  const byId = new Map(current.map((s) => [s.id, s]));
  const kept = new Set<string>();

  const schemes = inputs.map((input) => {
    const prior = input.id ? byId.get(input.id) : undefined;
    const schemeId = prior ? prior.id : randomUUID();
    kept.add(schemeId);

    if (input.secret !== undefined) {
      const value = input.secret.trim();
      if (value === "") delete secrets[schemeId];
      else secrets[schemeId] = value;
    }

    // Preserve acquired state only when the acquisition kind is unchanged.
    const priorAcquired =
      prior && prior.acquisition === input.acquisition ? prior.acquired : undefined;
    return buildScheme(schemeId, input, !!secrets[schemeId], priorAcquired);
  });

  for (const schemeId of Object.keys(secrets)) {
    if (!kept.has(schemeId)) delete secrets[schemeId];
  }
  await writeConnectionSecrets(connectionId, secrets);
  return schemes;
}

function buildScheme(
  id: string,
  input: AuthSchemeInput,
  hasSecret: boolean,
  priorAcquired: AcquiredState | undefined
): AuthScheme {
  const scheme: AuthScheme = {
    id,
    acquisition: input.acquisition,
    config: input.config ?? {},
    hasSecret,
  };
  if (ATTACHABLE_ACQUISITIONS.has(input.acquisition) && input.attachment) {
    scheme.attachment = input.attachment;
  }
  if (ACQUIRED_ACQUISITIONS.has(input.acquisition)) {
    scheme.acquired = priorAcquired ?? { status: "none" };
  }
  return scheme;
}

// --- Persistence helpers ---

async function readRegistry(): Promise<IntegrationConnection[]> {
  try {
    const content = await fs.readFile(integrationsFile(), "utf-8");
    const parsed = JSON.parse(content) as IntegrationConnection[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRegistry(registry: IntegrationConnection[]): Promise<void> {
  await ensureOrchestratorHome();
  await fs.writeFile(integrationsFile(), JSON.stringify(registry, null, 2));
}

async function readSecrets(): Promise<SecretStore> {
  return readSecretJson<SecretStore>(integrationSecretsFile(), {});
}

async function writeConnectionSecrets(
  connectionId: string,
  secrets: Record<string, string>
): Promise<void> {
  const store = await readSecrets();
  if (Object.keys(secrets).length === 0) delete store[connectionId];
  else store[connectionId] = secrets;
  await writeSecretJson(integrationSecretsFile(), store);
}

async function removeConnectionSecrets(connectionId: string): Promise<void> {
  const store = await readSecrets();
  if (!(connectionId in store)) return;
  delete store[connectionId];
  await writeSecretJson(integrationSecretsFile(), store);
}
