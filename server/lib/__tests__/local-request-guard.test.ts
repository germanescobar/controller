import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { isTrustedLocalRequest, localApiGuard } from "../local-request-guard.js";

test("allows CLI and renderer requests but rejects foreign origins and rebinding hosts", () => {
  const host = "localhost:3102";
  assert.equal(isTrustedLocalRequest({ host }, 3102, 4502), true);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://localhost:3102" }, 3102, 4502), true);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://localhost:4502" }, 3102, 4502), true);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://localhost:4502", "sec-fetch-site": "same-site" }, 3102, 4502), true);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://evil.example", "sec-fetch-site": "same-site" }, 3102, 4502), false);
  assert.equal(isTrustedLocalRequest({ host: "localhost:4502", origin: "http://localhost:4502", "sec-fetch-site": "same-origin" }, 3102, 4502), true);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://localhost:4502" }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host, origin: "http://evil.example" }, 3102, 4502), false);
  assert.equal(isTrustedLocalRequest({ host, origin: "null" }, 3102, 4502), false);
  assert.equal(isTrustedLocalRequest({ host, "sec-fetch-site": "cross-site" }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host, "sec-fetch-site": "same-site" }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host: "evil.example:3102" }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host: "localhost:9999" }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host: ["localhost:3102"] }, 3102), false);
  assert.equal(isTrustedLocalRequest({ host }, 3102, undefined, "192.168.1.5"), false);
  assert.equal(isTrustedLocalRequest({ host }, 3102, undefined, "::ffff:127.0.0.1"), true);
});

test("any Tailscale peer can use a tailnet name or the server's Tailscale IP", () => {
  const check = (host: string, origin: string | undefined, peer: string, site?: string) =>
    isTrustedLocalRequest({ host, ...(origin && { origin }), ...(site && { "sec-fetch-site": site }) },
      3102, 4502, peer, peer.includes("fd7a:") ? "fd7a:115c:a1e0::2" : "100.101.102.103");

  assert.equal(check("macbook:3102", "http://macbook:4502", "100.101.102.104"), true);
  assert.equal(check("macbook:3102", "http://macbook:3102", "::ffff:100.101.102.104"), true);
  assert.equal(check("macbook.tailnet.ts.net:3102", "http://macbook.tailnet.ts.net:4502", "fd7a:115c:a1e0::1"), true);
  assert.equal(check("100.101.102.103:3102", undefined, "100.101.102.104"), true);
  assert.equal(check("100.101.102.105:3102", undefined, "100.101.102.104"), false);
  assert.equal(check("macbook:3102", "http://evil.example", "100.101.102.104"), false);
  assert.equal(check("macbook:3102", "http://localhost:3102", "100.101.102.104"), false);
  assert.equal(check("macbook:3102", "http://macbook.tailnet.ts.net:4502", "100.101.102.104"), false);
  assert.equal(check("macbook:3102", undefined, "100.101.102.104", "cross-site"), false);
  assert.equal(check("macbook:3102", "http://macbook:4502", "192.168.1.5"), false);
  assert.equal(check("macbook:3102", "http://macbook:4502", "100.63.255.255"), false);
  assert.equal(check("macbook:3102", "http://macbook:4502", "100.128.0.1"), false);
  assert.equal(check("macbook:3102", "http://macbook:4502", "fd7a:115c:a1e1::1"), false);
  assert.equal(check("evil.example:3102", "http://evil.example:3102", "100.101.102.104"), false);
  assert.equal(check("localhost:3102", "http://localhost:3102", "100.101.102.104"), false);
  assert.equal(check("macbook:9999", "http://macbook:9999", "100.101.102.104"), false);
  assert.equal(check("macbook:4502", "http://macbook:4502", "100.101.102.104"), false);
  assert.equal(check("macbook:3102", "http://macbook:4502", "127.0.0.1"), false);
  assert.equal(isTrustedLocalRequest({ host: "macbook:3102", origin: "http://macbook:4502" },
    3102, 4502, "100.101.102.104", "192.168.1.5"), false);
  assert.equal(isTrustedLocalRequest({ host: "macbook:3102", origin: "http://macbook:4502" },
    3102, 4502, "100.101.102.104"), false);
  // Vite proxies API requests over loopback while preserving the browser Origin.
  assert.equal(check("localhost:3102", "http://macbook:4502", "127.0.0.1"), true);
  assert.equal(check("localhost:3102", "http://evil.example", "127.0.0.1"), false);
  assert.equal(check("localhost:3102", "http://100.101.102.103:4502", "127.0.0.1"), true);
  assert.equal(check("evil.example:3102", "http://evil.example:3102", "100.101.102.104"), false);
});

test("the API guard covers every CLI route with no CORS response for a foreign page", async () => {
  const app = express();
  const server = http.createServer(app);
  app.use("/api", localApiGuard(() => (server.address() as { port: number }).port));
  for (const route of [
    "/terminal/command",
    "/browser/command",
    "/integrations/gateway/list",
    "/projects/demo/sessions",
    "/projects/demo/schedules",
  ]) app.post(`/api${route}`, (_req, res) => res.sendStatus(204));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const route of [
      "/terminal/command",
      "/browser/command",
      "/integrations/gateway/list",
      "/projects/demo/sessions",
      "/projects/demo/schedules",
    ]) {
      const url = `http://127.0.0.1:${port}/api${route}`;
      const rejected = await fetch(url, { method: "POST", headers: { origin: "https://evil.example" } });
      assert.equal(rejected.status, 403, route);
      assert.equal(rejected.headers.get("access-control-allow-origin"), null);
      const cli = await fetch(url, { method: "POST" });
      assert.equal(cli.status, 204, route);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("terminal and preview WebSockets accept the dev renderer's same-site upgrades", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const port = (server.address() as { port: number }).port;
    if (!req.headers.origin || !isTrustedLocalRequest(req.headers, port, port + 1, req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const route of ["terminal", "preview-browser"]) {
      const url = `ws://127.0.0.1:${port}/ws/${route}`;
      const headers = { "sec-fetch-site": "same-site" };
      const rejected = new WebSocket(url, { origin: "https://evil.example", headers });
      await assert.rejects(new Promise<void>((resolve, reject) => {
        rejected.once("open", resolve);
        rejected.once("error", reject);
      }));
      const accepted = new WebSocket(url, {
        origin: `http://127.0.0.1:${port + 1}`,
        headers,
      });
      await new Promise<void>((resolve, reject) => {
        accepted.once("open", resolve);
        accepted.once("error", reject);
      });
    }
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
