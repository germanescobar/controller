/*
 * HTTP surface for configuring integration connections (issue #130).
 *
 * This is the UI-facing CRUD for the connection registry. Secret values are
 * accepted on write but never returned: list/get responses carry only each
 * scheme's `hasSecret` flag so the UI can show "configured" without ever seeing
 * the credential. `/openapi/inspect` derives an auth scheme set from a spec URL
 * so OpenAPI connections can be pre-filled rather than hand-modeled.
 *
 * The agent-facing gateway (list/search/describe/call/request) is a separate
 * surface built on top of this registry and is not part of this route.
 */

import { Router } from "express";
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  type ConnectionInput,
  type ConnectionMode,
  type Acquisition,
  type Attachment,
  type TransportInput,
  type AuthInput,
  type AuthSchemeInput,
} from "../lib/integrations.js";
import { fetchOpenApiAuth } from "../lib/openapi-auth.js";

export const integrationsRouter = Router();

const CONNECTION_MODES: ConnectionMode[] = ["mcp", "openapi", "rest", "graphql", "cli"];

const ACQUISITIONS: Acquisition[] = [
  "static",
  "basic",
  "oauth",
  "oauth_client_credentials",
  "oauth_dynamic",
  "cloud",
  "hmac",
  "mtls",
];

integrationsRouter.get("/", async (_req, res) => {
  res.json(await listConnections());
});

integrationsRouter.post("/", async (req, res) => {
  const input = parseInput(req.body, { requireAll: true });
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  res.status(201).json(await createConnection(input.value as ConnectionInput));
});

integrationsRouter.put("/:id", async (req, res) => {
  const input = parseInput(req.body, { requireAll: false });
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  const { id } = req.params;
  const updated = await updateConnection(id, input.value);
  if (!updated) {
    res.status(404).json({ error: "Unknown connection" });
    return;
  }
  res.json(updated);
});

integrationsRouter.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const removed = await deleteConnection(id);
  if (!removed) {
    res.status(404).json({ error: "Unknown connection" });
    return;
  }
  res.json({ ok: true });
});

/* Derive base URL + auth scheme alternatives from an OpenAPI spec URL. */
integrationsRouter.post("/openapi/inspect", async (req, res) => {
  const specUrl = (req.body as { specUrl?: unknown })?.specUrl;
  if (typeof specUrl !== "string" || !specUrl.trim()) {
    res.status(400).json({ error: "specUrl is required" });
    return;
  }
  try {
    res.json(await fetchOpenApiAuth(specUrl.trim()));
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/*
 * Validate and normalize a create/update body. With `requireAll` we enforce the
 * fields needed to create a connection; without it (update) every field is
 * optional and only present fields are validated.
 */
function parseInput(
  body: unknown,
  { requireAll }: { requireAll: boolean }
): { value: Partial<ConnectionInput> } | { error: string } {
  const data = (body ?? {}) as Record<string, unknown>;
  const value: Partial<ConnectionInput> = {};

  if (requireAll || data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim()) {
      return { error: "name is required" };
    }
    value.name = data.name;
  }

  if (requireAll || data.transport !== undefined) {
    const transport = parseTransport(data.transport);
    if ("error" in transport) return transport;
    value.transport = transport.value;
  }

  if (requireAll || data.auth !== undefined) {
    const auth = parseAuth(data.auth);
    if ("error" in auth) return auth;
    value.auth = auth.value;
  }

  return { value };
}

function parseTransport(raw: unknown): { value: TransportInput } | { error: string } {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!CONNECTION_MODES.includes(data.mode as ConnectionMode)) {
    return { error: "Invalid transport.mode" };
  }
  if (data.config !== undefined && !isStringRecord(data.config)) {
    return { error: "transport.config must be a string map" };
  }
  if (data.headers !== undefined && !isStringRecord(data.headers)) {
    return { error: "transport.headers must be a string map" };
  }
  if (data.query !== undefined && !isStringRecord(data.query)) {
    return { error: "transport.query must be a string map" };
  }
  return {
    value: {
      mode: data.mode as ConnectionMode,
      config: data.config as Record<string, string> | undefined,
      headers: data.headers as Record<string, string> | undefined,
      query: data.query as Record<string, string> | undefined,
    },
  };
}

function parseAuth(raw: unknown): { value: AuthInput } | { error: string } {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(data.schemes)) {
    return { error: "auth.schemes must be an array" };
  }
  const schemes: AuthSchemeInput[] = [];
  for (const entry of data.schemes) {
    const scheme = parseScheme(entry);
    if ("error" in scheme) return scheme;
    schemes.push(scheme.value);
  }
  return { value: { schemes } };
}

function parseScheme(raw: unknown): { value: AuthSchemeInput } | { error: string } {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!ACQUISITIONS.includes(data.acquisition as Acquisition)) {
    return { error: "Invalid auth acquisition" };
  }
  if (data.id !== undefined && typeof data.id !== "string") {
    return { error: "scheme.id must be a string" };
  }
  if (data.config !== undefined && !isStringRecord(data.config)) {
    return { error: "scheme.config must be a string map" };
  }
  if (data.secret !== undefined && typeof data.secret !== "string") {
    return { error: "scheme.secret must be a string" };
  }
  const attachment = parseAttachment(data.attachment);
  if ("error" in attachment) return attachment;
  return {
    value: {
      id: data.id as string | undefined,
      acquisition: data.acquisition as Acquisition,
      attachment: attachment.value,
      config: data.config as Record<string, string> | undefined,
      secret: data.secret as string | undefined,
    },
  };
}

function parseAttachment(
  raw: unknown
): { value: Attachment | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { value: undefined };
  const data = raw as Record<string, unknown>;
  if (data.kind !== "header" && data.kind !== "query") {
    return { error: "attachment.kind must be 'header' or 'query'" };
  }
  if (typeof data.name !== "string") {
    return { error: "attachment.name must be a string" };
  }
  if (data.prefix !== undefined && typeof data.prefix !== "string") {
    return { error: "attachment.prefix must be a string" };
  }
  return {
    value: {
      kind: data.kind,
      name: data.name,
      prefix: data.prefix as string | undefined,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
