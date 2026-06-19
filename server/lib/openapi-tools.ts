/*
 * Derive callable "tools" from an OpenAPI spec (issue #130).
 *
 * Each (path, method) operation becomes a tool the agent can discover and call.
 * Output is bounded: `listTools` returns names + one-line summaries; the full
 * parameter schema is only produced by `describeTool`. `buildCallRequest` turns
 * a tool name + args into the RequestInput the executor runs, so a schema-backed
 * `call` validates required params before hitting the network.
 */

import { fetchSpecJson } from "./openapi-auth.js";
import type { RequestInput } from "./integration-execute.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ToolParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  type?: string;
}

export interface OpenApiTool {
  name: string;
  method: string;
  path: string;
  summary: string;
  parameters: ToolParam[];
  hasBody: boolean;
}

const cache = new Map<string, { tools: OpenApiTool[]; fetchedAt: number }>();

/** Fetch (cached) and parse the spec's operations into tools. */
export async function loadTools(specUrl: string): Promise<OpenApiTool[]> {
  const cached = cache.get(specUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.tools;
  const tools = parseTools(await fetchSpecJson(specUrl));
  cache.set(specUrl, { tools, fetchedAt: Date.now() });
  return tools;
}

/** Pure: extract tools from a spec object. */
export function parseTools(spec: unknown): OpenApiTool[] {
  const root = asRecord(spec) ?? {};
  const paths = asRecord(root.paths) ?? {};
  const tools: OpenApiTool[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = asRecord(rawItem);
    if (!pathItem) continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = asRecord(pathItem[method]);
      if (!op) continue;
      const operationId =
        typeof op.operationId === "string" && op.operationId.trim()
          ? op.operationId.trim()
          : `${method.toUpperCase()} ${path}`;
      const rawParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const parameters = rawParams
        .map(parseParam)
        .filter((p): p is ToolParam => p !== null);
      const summary =
        (typeof op.summary === "string" && op.summary) ||
        (typeof op.description === "string" && op.description) ||
        "";

      tools.push({
        name: operationId,
        method: method.toUpperCase(),
        path,
        summary: summary.split("\n")[0].slice(0, 200),
        parameters,
        hasBody: asRecord(op.requestBody) !== null,
      });
    }
  }
  return tools;
}

export function findTool(tools: OpenApiTool[], name: string): OpenApiTool | null {
  const lower = name.toLowerCase();
  return (
    tools.find((t) => t.name.toLowerCase() === lower) ??
    tools.find((t) => `${t.method} ${t.path}`.toLowerCase() === lower) ??
    null
  );
}

export function searchTools(tools: OpenApiTool[], query: string): OpenApiTool[] {
  const q = query.toLowerCase();
  return tools.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.path.toLowerCase().includes(q) ||
      t.summary.toLowerCase().includes(q)
  );
}

/**
 * Turn a tool + args into a request. Path params are substituted, declared
 * query/header params are pulled from args, and `args.body` becomes the JSON
 * body. Throws with a clear message when a required param is missing.
 */
export function buildCallRequest(tool: OpenApiTool, args: Record<string, unknown>): RequestInput {
  const missing: string[] = [];
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};

  let path = tool.path;
  for (const param of tool.parameters) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) missing.push(`${param.name} (${param.in})`);
      continue;
    }
    const str = String(value);
    if (param.in === "path") path = path.replace(`{${param.name}}`, encodeURIComponent(str));
    else if (param.in === "query") query[param.name] = str;
    else if (param.in === "header") headers[param.name] = str;
  }

  // Any unsubstituted path placeholder is a missing required path param.
  const leftover = path.match(/\{([^}]+)\}/g);
  if (leftover) for (const m of leftover) missing.push(`${m.slice(1, -1)} (path)`);

  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${[...new Set(missing)].join(", ")}.`);
  }

  const body = (args.body ?? null) as RequestInput["body"];
  return { method: tool.method, path, query, headers, body: tool.hasBody ? body : null };
}

// --- helpers ---

function parseParam(raw: unknown): ToolParam | null {
  const p = asRecord(raw);
  if (!p || typeof p.name !== "string") return null;
  const where = p.in;
  if (where !== "path" && where !== "query" && where !== "header") return null;
  return {
    name: p.name,
    in: where,
    required: where === "path" ? true : p.required === true,
    description: typeof p.description === "string" ? p.description : undefined,
    type: typeof asRecord(p.schema)?.type === "string" ? (asRecord(p.schema)!.type as string) : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
