/*
 * Agent-facing gateway service (issue #130).
 *
 * The uniform surface the `integrations` CLI calls: list / search / tools /
 * describe / call / request / status. It resolves a connection by name (only
 * enabled ones are visible) and dispatches to the right backend — OpenAPI tool
 * derivation, the MCP client, or the HTTP executor — while CLI-native
 * connections are reported as "ready, invoke natively" rather than proxied.
 * Secrets are injected server-side by the executor; nothing here returns them.
 */

import { spawn } from "node:child_process";
import {
  listEnabledConnections,
  type IntegrationConnection,
  type ConnectionMode,
} from "./integrations.js";
import { executeRequest, checkStatus, type ExecResult, type RequestInput } from "./integration-execute.js";
import { loadTools, findTool, searchTools, buildCallRequest } from "./openapi-tools.js";
import { mcpListTools, mcpCallTool, mcpStatus } from "./mcp-client.js";

const CLI_VERIFY_TIMEOUT_MS = 15_000;

export interface ListedConnection {
  name: string;
  mode: ConnectionMode;
  /** How the agent uses it: proxied API, MCP tools, or a native CLI. */
  kind: "api" | "mcp" | "cli";
  summary: string;
}

export async function gatewayList(): Promise<ListedConnection[]> {
  const connections = await listEnabledConnections();
  return connections.map((c) => ({
    name: c.name,
    mode: c.transport.mode,
    kind: kindOf(c.transport.mode),
    summary: summaryOf(c),
  }));
}

export interface ToolSummary {
  integration: string;
  tool: string;
  summary: string;
}

export async function gatewaySearch(query: string): Promise<ToolSummary[]> {
  const connections = await listEnabledConnections();
  const results: ToolSummary[] = [];
  for (const connection of connections) {
    try {
      const tools = await toolsFor(connection);
      for (const t of searchByQuery(tools, query)) {
        results.push({ integration: connection.name, tool: t.tool, summary: t.summary });
      }
    } catch {
      // A backend that can't enumerate (offline MCP, bad spec) is skipped.
    }
  }
  return results;
}

export async function gatewayTools(name: string): Promise<{ tools: ToolSummary[]; note?: string }> {
  const connection = await resolve(name);
  if (connection.transport.mode === "cli") {
    return { tools: [], note: "CLI-native integration — invoke the binary directly (see status)." };
  }
  if (connection.transport.mode === "graphql") {
    return {
      tools: [],
      note:
        'GraphQL has no fixed tool list. Send an operation with `request <name> POST "" --data ' +
        "'{\"query\":\"...\"}'`. To explore the schema, POST a GraphQL introspection query the same way.",
    };
  }
  if (kindOf(connection.transport.mode) === "api" && connection.transport.mode !== "openapi") {
    return { tools: [], note: "No schema for this connection — use `request` to call it directly." };
  }
  const tools = await toolsFor(connection);
  return {
    tools: tools.map((t) => ({ integration: connection.name, tool: t.tool, summary: t.summary })),
  };
}

export async function gatewayDescribe(name: string, tool: string): Promise<unknown> {
  const connection = await resolve(name);
  if (connection.transport.mode === "openapi") {
    const found = findTool(await loadTools(specUrlOf(connection)), tool);
    if (!found) throw new Error(`Unknown tool "${tool}".`);
    return found;
  }
  if (connection.transport.mode === "mcp") {
    const found = (await mcpListTools(connection)).find((t) => t.name === tool);
    if (!found) throw new Error(`Unknown tool "${tool}".`);
    return found;
  }
  throw new Error(`"${connection.name}" has no describable tools — use \`request\`.`);
}

export async function gatewayCall(
  name: string,
  tool: string,
  args: Record<string, unknown>
): Promise<ExecResult | { ok: true; result: unknown }> {
  const connection = await resolve(name);
  if (connection.transport.mode === "openapi") {
    const found = findTool(await loadTools(specUrlOf(connection)), tool);
    if (!found) throw new Error(`Unknown tool "${tool}".`);
    return executeRequest(connection, buildCallRequest(found, args));
  }
  if (connection.transport.mode === "mcp") {
    return { ok: true, result: await mcpCallTool(connection, tool, args) };
  }
  throw new Error(`\`call\` needs a schema-backed connection; "${connection.name}" is generic — use \`request\`.`);
}

export async function gatewayRequest(name: string, input: RequestInput): Promise<ExecResult> {
  const connection = await resolve(name);
  if (kindOf(connection.transport.mode) !== "api") {
    throw new Error(`\`request\` only works for HTTP connections; "${connection.name}" is ${connection.transport.mode}.`);
  }
  return executeRequest(connection, input);
}

export async function gatewayStatus(
  name: string
): Promise<{ ok: boolean; message: string; reauth?: { reason: string; message: string } }> {
  const connection = await resolve(name);
  if (connection.transport.mode === "cli") return cliStatus(connection);
  if (connection.transport.mode === "mcp") {
    try {
      return { ok: true, message: await mcpStatus(connection) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return checkStatus(connection);
}

// --- helpers ---

async function resolve(name: string): Promise<IntegrationConnection> {
  const matches = (await listEnabledConnections()).filter(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  if (matches.length === 0) throw new Error(`No enabled integration named "${name}".`);
  if (matches.length > 1) throw new Error(`Multiple integrations named "${name}" — rename to disambiguate.`);
  return matches[0];
}

function kindOf(mode: ConnectionMode): "api" | "mcp" | "cli" {
  if (mode === "mcp") return "mcp";
  if (mode === "cli") return "cli";
  return "api";
}

function summaryOf(c: IntegrationConnection): string {
  if (c.transport.mode === "cli") {
    return `Native CLI \`${c.transport.config.binary ?? ""}\` — invoke directly.`;
  }
  if (c.transport.mode === "mcp") return "MCP server with structured tools.";
  const base = c.transport.config.baseUrl ?? c.transport.config.endpoint ?? "";
  return base ? `HTTP API at ${base}.` : "HTTP API.";
}

function specUrlOf(c: IntegrationConnection): string {
  const url = c.transport.config.specUrl?.trim();
  if (!url) throw new Error(`"${c.name}" has no OpenAPI spec URL configured.`);
  return url;
}

interface ToolRow {
  tool: string;
  summary: string;
}

async function toolsFor(connection: IntegrationConnection): Promise<ToolRow[]> {
  if (connection.transport.mode === "openapi") {
    return (await loadTools(specUrlOf(connection))).map((t) => ({ tool: t.name, summary: t.summary }));
  }
  if (connection.transport.mode === "mcp") {
    return (await mcpListTools(connection)).map((t) => ({ tool: t.name, summary: t.description }));
  }
  return [];
}

function searchByQuery(tools: ToolRow[], query: string): ToolRow[] {
  const q = query.toLowerCase();
  return tools.filter((t) => t.tool.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q));
}

/* CLI-native: confirm the binary is installed and (optionally) authed, then
 * point the agent at it. Not proxied. */
async function cliStatus(
  connection: IntegrationConnection
): Promise<{ ok: boolean; message: string }> {
  const binary = connection.transport.config.binary?.trim();
  if (!binary) return { ok: false, message: "No binary configured." };

  const installed = await runCommand(`command -v ${binary}`);
  if (installed.code !== 0) {
    return { ok: false, message: `\`${binary}\` is not installed or not on PATH.` };
  }
  const checkCommand = connection.transport.config.checkCommand?.trim();
  if (!checkCommand) {
    return { ok: true, message: `\`${binary}\` is installed (${installed.stdout.trim()}). Invoke it directly.` };
  }
  const check = await runCommand(checkCommand);
  if (check.code === 0) {
    return { ok: true, message: `\`${binary}\` is installed and authenticated. Invoke it directly.` };
  }
  const loginHint = connection.transport.config.loginCommand?.trim();
  return {
    ok: false,
    message: `\`${binary}\` is installed but not authenticated${loginHint ? ` — run \`${loginHint}\`` : ""}.`,
  };
}

function runCommand(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CLI_VERIFY_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
