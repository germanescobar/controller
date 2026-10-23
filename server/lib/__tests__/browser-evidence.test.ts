import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { saveBrowserScreenshot } from "../browser-evidence.js";

test("screenshot artifact is a private PNG with dimensions and command context", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=", "base64");
  const result = await saveBrowserScreenshot({ data: png.toString("base64"), paneKey: "test:one", url: "http://localhost:3000/?token=secret", fullPage: false, sessionId: "session-123" });
  try {
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.equal(result.sessionId, "session-123");
    assert.equal(result.url, "http://localhost:3000/");
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.match(result.path, new RegExp(`${result.commandId}\\.png$`));
    assert.deepEqual(await readFile(result.path), png);
  } finally {
    await rm(path.dirname(result.path), { recursive: true, force: true });
  }
});

test("screenshot rejects invalid image data", async () => {
  await assert.rejects(saveBrowserScreenshot({ data: Buffer.from("not a PNG").toString("base64"), paneKey: "test:two", url: "about:blank", fullPage: true }), /Invalid or oversized PNG/);
});
