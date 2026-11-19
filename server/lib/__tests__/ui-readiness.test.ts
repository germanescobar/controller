import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { assertUiReady, isServerAlive } from "../../../electron/ui-readiness.js";

test("readiness rejects missing entry assets even when API and HTML succeed", async () => {
  let missing = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/agent-providers") {
      res.setHeader("content-type", "application/json");
      res.end("[]");
    } else if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end('<script src="/assets/app.js"></script>');
    } else if (req.url === "/assets/app.js" && !missing) {
      res.setHeader("content-type", "text/javascript");
      res.end("console.log('ready')");
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    await assertUiReady(url);
    missing = true;
    assert.equal(await isServerAlive(url), true);
    await assert.rejects(assertUiReady(url), /app.js HTTP 404/);
    assert.equal(await isServerAlive(url), true);
    // Retry against the original listener after the transient asset failure clears.
    missing = false;
    await assertUiReady(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
