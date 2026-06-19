/*
 * Minimal MCP client over stdio (issue #130).
 *
 * Spawns a local MCP server (the connection's `command`), runs the JSON-RPC
 * handshake, and exposes tools/list and tools/call. Messages are
 * newline-delimited JSON-RPC per the MCP stdio transport. A fresh process is
 * spawned per gateway operation and torn down after — simple and stateless,
 * which is fine for the gateway's discovery/call pattern.
 *
 * Remote (HTTP/SSE) MCP servers are not supported yet; a connection configured
 * with only a URL returns a clear message.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IntegrationConnection } from "./integrations.js";

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

/* Spawn the server, run initialize, hand a request() to `fn`, then tear down. */
async function withSession<T>(
  connection: IntegrationConnection,
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const command = connection.transport.config.command?.trim();
  if (!command) {
    if (connection.transport.config.url?.trim()) {
      throw new Error("Remote MCP servers aren't supported yet — configure a command.");
    }
    throw new Error("This MCP connection has no command configured.");
  }

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
