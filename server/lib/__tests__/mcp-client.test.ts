import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * HTTP (Streamable HTTP) transport for the MCP client (issue #229).
 *
 * Each test stands up a local JSON-RPC-over-HTTP MCP server, registers a
 * url-mode connection in a temp home (so auth resolves through the real secret
 * store), and exercises mcpListTools / mcpStatus / mcpCallTool. The stdio path
 * is intentionally not touched here.
 */

type RpcMessage = { id?: number; method?: string; params?: unknown };
type Handler = (msg: RpcMessage, req: http.IncomingMessage) => {
  status?: number;
  contentType?: string;
  body: string;
};

interface Captured {
  headers: http.IncomingHttpHeaders[];
  methods: string[];
}

async function withServer(
  handler: Handler,
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    mcp: typeof import("../mcp-client.js");
    url: string;
    captured: Captured;
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;

  const captured: Captured = { headers: [], methods: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.headers.push(req.headers);
      let msg: RpcMessage = {};
      try {
        msg = JSON.parse(raw);
      } catch {
        // non-JSON body — leave msg empty
      }
      if (msg.method) captured.methods.push(msg.method);

      // Notifications carry no id; ack with 202 and no body.
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const out = handler(msg, req);
      res.writeHead(out.status ?? 200, {
        "Content-Type": out.contentType ?? "application/json",
      });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const integrations = await import("../integrations.js");
    const mcp = await import("../mcp-client.js");
    await fn({ integrations, mcp, url: `http://127.0.0.1:${port}/mcp`, captured });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* JSON-RPC response for the standard initialize → tools/list flow. */
function reply(msg: RpcMessage, tools: { name: string; description?: string }[]): string {
  if (msg.method === "initialize") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "Cloudflare" } },
    });
  }
  if (msg.method === "tools/list") {
    return JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  return JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} });
}

async function createUrlConnection(
  integrations: typeof import("../integrations.js"),
  url: string,
  secret?: string
) {
  return integrations.createConnection({
    name: "Remote",
    transport: { mode: "mcp", config: { url }, headers: {}, query: {} },
    auth: {
      schemes: secret
        ? [
            {
              acquisition: "static",
              attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
              secret,
            },
          ]
        : [],
    },
  });
}

test("mcpListTools lists tools over an application/json response", async () => {
  await withServer(
    (msg) => ({ body: reply(msg, [{ name: "alpha", description: "A tool" }, { name: "beta" }]) }),
    async ({ integrations, mcp, url }) => {
      const connection = await createUrlConnection(integrations, url);
      const tools = await mcp.mcpListTools(connection);
      assert.deepEqual(
        tools.map((t) => t.name),
        ["alpha", "beta"]
      );
      assert.equal(tools[0].description, "A tool");
    }
  );
});

test("mcpListTools parses SSE (text/event-stream) framed responses", async () => {
  await withServer(
    (msg) => {
      const json = reply(msg, [{ name: "sse_tool", description: "via sse" }]);
      // Wrap the JSON-RPC payload in an SSE frame, with a comment + blank lines.
      return {
        contentType: "text/event-stream",
        body: `: keepalive\n\nevent: message\ndata: ${json}\n\n`,
      };
    },
    async ({ integrations, mcp, url }) => {
      const connection = await createUrlConnection(integrations, url);
      const tools = await mcp.mcpListTools(connection);
      assert.deepEqual(
        tools.map((t) => t.name),
        ["sse_tool"]
      );
    }
  );
});

test("the Authorization header is injected from the connection's auth scheme", async () => {
  await withServer(
    (msg) => ({ body: reply(msg, [{ name: "alpha" }]) }),
    async ({ integrations, mcp, url, captured }) => {
      const connection = await createUrlConnection(integrations, url, "API_TOKEN_123");
      await mcp.mcpListTools(connection);
      // Every request (initialize, initialized, tools/list) carries the bearer.
      assert.ok(captured.headers.length >= 2);
      for (const h of captured.headers) {
        assert.equal(h.authorization, "Bearer API_TOKEN_123");
        assert.match(String(h.accept), /text\/event-stream/);
      }
    }
  );
});

test("mcpStatus reports the server name and tool count", async () => {
  await withServer(
    (msg) => ({ body: reply(msg, [{ name: "a" }, { name: "b" }, { name: "c" }]) }),
    async ({ integrations, mcp, url }) => {
      const connection = await createUrlConnection(integrations, url);
      const status = await mcp.mcpStatus(connection);
      assert.equal(status, "Connected to Cloudflare — 3 tool(s) available.");
    }
  );
});

test("mcpCallTool returns the tool result and sends tools/call", async () => {
  await withServer(
    (msg) => {
      if (msg.method === "tools/call") {
        return {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: "done" }] },
          }),
        };
      }
      return { body: reply(msg, []) };
    },
    async ({ integrations, mcp, url, captured }) => {
      const connection = await createUrlConnection(integrations, url);
      const result = (await mcp.mcpCallTool(connection, "alpha", { x: 1 })) as {
        content: { text: string }[];
      };
      assert.equal(result.content[0].text, "done");
      assert.ok(captured.methods.includes("tools/call"));
    }
  );
});

test("a 401 surfaces a credentials error", async () => {
  await withServer(
    () => ({ status: 401, body: JSON.stringify({ error: "unauthorized" }) }),
    async ({ integrations, mcp, url }) => {
      const connection = await createUrlConnection(integrations, url, "BAD_TOKEN");
      await assert.rejects(mcp.mcpListTools(connection), /rejected the credentials \(HTTP 401\)/);
    }
  );
});

test("a non-2xx response surfaces the status and body", async () => {
  await withServer(
    () => ({ status: 500, body: "boom" }),
    async ({ integrations, mcp, url }) => {
      const connection = await createUrlConnection(integrations, url);
      await assert.rejects(mcp.mcpListTools(connection), /HTTP 500.*boom/s);
    }
  );
});

test("a missing credential blocks the request before any network call", async () => {
  await withServer(
    (msg) => ({ body: reply(msg, []) }),
    async ({ integrations, mcp, url, captured }) => {
      // Bearer scheme configured but no secret stored → not ready.
      const connection = await integrations.createConnection({
        name: "NeedsAuth",
        transport: { mode: "mcp", config: { url }, headers: {}, query: {} },
        auth: {
          schemes: [
            { acquisition: "static", attachment: { kind: "header", name: "Authorization", prefix: "Bearer " } },
          ],
        },
      });
      await assert.rejects(mcp.mcpListTools(connection));
      assert.equal(captured.headers.length, 0);
    }
  );
});

test("a connection with neither command nor url is rejected", async () => {
  await withServer(
    (msg) => ({ body: reply(msg, []) }),
    async ({ integrations, mcp }) => {
      const connection = await integrations.createConnection({
        name: "Empty",
        transport: { mode: "mcp", config: {}, headers: {}, query: {} },
        auth: { schemes: [] },
      });
      await assert.rejects(mcp.mcpListTools(connection), /no command or URL configured/);
    }
  );
});
