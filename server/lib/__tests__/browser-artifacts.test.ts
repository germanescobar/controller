import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { browserRouter } from "../../routes/browser.js";
import { saveBrowserScreenshot } from "../browser-evidence.js";

test("artifact HTTP route serves PNG bytes and denies substituted scopes and paths", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=";
  const artifact = await saveBrowserScreenshot({ data: png, paneKey: "project:worktree", sessionId: "owner", url: "http://localhost/", fullPage: false });
  const app = express();
  app.use("/api/browser", browserRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(base + artifact.imageUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, "base64"));
    for (const url of [artifact.imageUrl.replace("/owner/", "/other/"), artifact.imageUrl.replace(/artifacts\/[^/]+/, "artifacts/other"), "/api/browser/artifacts/a/b/etc%2Fpasswd", "/api/browser/artifacts/a/b/missing.png"]) {
      assert.equal((await fetch(base + url)).status, 404);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
