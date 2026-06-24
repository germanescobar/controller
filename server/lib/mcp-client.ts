/*
 * Minimal MCP client (issues #130, #229).
 *
 * Exposes tools/list and tools/call over either of the two MCP transports:
 *
 *   - stdio: spawn a local server (the connection's `command`), speak
 *     newline-delimited JSON-RPC over its stdin/stdout.
 *   - Streamable HTTP: POST JSON-RPC to the connection's `url`, accepting both
 *     `application/json` and `text/event-stream` (SSE) responses. Auth is
 *     injected at the HTTP boundary from the connection's auth schemes, exactly
 *     as the REST/OpenAPI executor does.
 *
 * Either way we run the same `initialize` → `notifications/initialized` →
 * `tools/list` / `tools/call` flow. A fresh session is opened per gateway
 * operation and torn down after — simple and stateless, which fits the
 * gateway's discovery/call pattern.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IntegrationConnection } from "./integrations.js";
import { resolveConnectionAuth } from "./integration-execute.js";

const TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2024-11-05";

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export async function mcpListTools(connection: IntegrationConnection): Promise<McpTool[]> {
  return withSession(connection, async (session) => {
    const res = (await session.request("tools/list", {})) as { tools?: unknown };
    if (!Array.isArray(res?.tools)) return [];
    return res.tools.map((t) => {
      const tool = t as Record<string, unknown>;
      return {
        name: String(tool.name ?? ""),
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema,
      };
    });
  });
}

export async function mcpCallTool(
  connection: IntegrationConnection,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return withSession(connection, (session) =>
    session.request("tools/call", { name, arguments: args })
  );
}

export async function mcpStatus(connection: IntegrationConnection): Promise<string> {
  return withSession(connection, async (session) => {
    const tools = (await session.request("tools/list", {})) as { tools?: unknown[] };
    const count = Array.isArray(tools?.tools) ? tools.tools.length : 0;
    return `Connected to ${session.serverName} — ${count} tool(s) available.`;
  });
}

interface Session {
  serverName: string;
  request: (method: string, params: unknown) => Promise<unknown>;
}

/* Pick the transport from the connection's config and run `fn` against it. */
async function withSession<T>(
  connection: IntegrationConnection,
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const url = connection.transport.config.url?.trim();
  const command = connection.transport.config.command?.trim();
  if (url) return withHttpSession(connection, url, fn);
  if (command) return withStdioSession(connection, command, fn);
  throw new Error("This MCP connection has no command or URL configured.");
}

// --- Streamable HTTP transport (remote MCP servers) ---

/*
 * Open an HTTP session: resolve auth, run initialize (capturing the optional
 * Mcp-Session-Id the server hands back for subsequent calls), send the
 * initialized notification, then hand a request() to `fn`. Each JSON-RPC
 * message is its own POST; responses arrive as a single JSON object or as SSE
 * `data:` frames, parsed the same way.
 */
async function withHttpSession<T>(
  connection: IntegrationConnection,
  url: string,
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const auth = await resolveConnectionAuth(connection);
  if (auth.status !== "ready") throw new Error(auth.message);
  const authHeaders = auth.resolved.headers;

  let sessionId: string | undefined;
  let nextId = 1;

  async function rpc(message: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("MCP request timed out.");
      }
      throw new Error(`Failed to reach MCP server: ${error instanceof Error ? error.message : error}`);
    } finally {
      clearTimeout(timer);
    }

    const handedSession = res.headers.get("mcp-session-id");
    if (handedSession) sessionId = handedSession;

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `MCP server rejected the credentials (HTTP ${res.status}). ` +
          "Check this integration's auth in Controller → Integrations."
      );
    }
    if (!res.ok) {
      const detail = (await res.text()).trim().slice(0, 500);
      throw new Error(`MCP server returned HTTP ${res.status}.${detail ? ` ${detail}` : ""}`);
    }

    // Notifications (no id) get no JSON-RPC reply — typically a 202 with no body.
    if (message.id === undefined) return undefined;

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : parseJsonBody(text);

    const reply = messages.find(
      (m): m is { id?: unknown; result?: unknown; error?: { message?: string } } =>
        !!m && typeof m === "object" && (m as { id?: unknown }).id === message.id
    );
    if (!reply) throw new Error("MCP server returned no response for the request.");
    if (reply.error) throw new Error(reply.error.message ?? "MCP error");
    return reply.result;
  }

  const request = (method: string, params: unknown): Promise<unknown> =>
    rpc({ jsonrpc: "2.0", id: nextId++, method, params });
  const notify = (method: string, params: unknown): Promise<unknown> =>
    rpc({ jsonrpc: "2.0", method, params });

  const init = (await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "controller", version: "1.0" },
  })) as { serverInfo?: { name?: string } };
  await notify("notifications/initialized", {});
  const serverName = init?.serverInfo?.name ?? hostnameOf(url);
  return fn({ serverName, request });
}

/* Parse SSE `data:` frames into JSON-RPC messages, ignoring comments/keepalives. */
function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Non-JSON data frame — ignore.
    }
  }
  return messages;
}

/* Parse a plain `application/json` body into an array of JSON-RPC messages. */
function parseJsonBody(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// --- stdio transport (local MCP servers) ---

/* Spawn the server, run initialize, hand a request() to `fn`, then tear down. */
async function withStdioSession<T>(
  connection: IntegrationConnection,
  command: string,
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const [bin, ...args] = command.split(/\s+/);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  } catch (error) {
    throw new Error(`Failed to start MCP server: ${error instanceof Error ? error.message : error}`);
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON log lines
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const notify = (method: string, params: unknown): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const exited = new Promise<never>((_, reject) => {
    child.on("error", (e) => reject(new Error(`MCP server error: ${e.message}`)));
    child.on("exit", (code) =>
      reject(new Error(`MCP server exited (code ${code}).${stderr ? ` ${stderr.slice(0, 500)}` : ""}`))
    );
  });
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("MCP request timed out.")), TIMEOUT_MS)
  );

  try {
    return await Promise.race([runSession(), exited, timer]);
  } finally {
    child.kill("SIGKILL");
  }

  async function runSession(): Promise<T> {
    const init = (await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "controller", version: "1.0" },
    })) as { serverInfo?: { name?: string } };
    notify("notifications/initialized", {});
    const serverName = init?.serverInfo?.name ?? bin;
    return fn({ serverName, request });
  }
}
