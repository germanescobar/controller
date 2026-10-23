import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticMessage, diagnosticUrl, PreviewDiagnosticBuffer } from "./preview-diagnostics.js";

test("diagnostics strip URL credentials, query values, and header-like secrets", () => {
  assert.equal(diagnosticUrl("https://user:secret@example.com/api?token=abc#frag"), "https://example.com/api");
  assert.equal(diagnosticUrl("file:///worktree/dist/index.html?token=abc"), "file:///worktree/dist/index.html");
  const message = diagnosticMessage("GET https://user:secret@example.com/api?token=abc Authorization: Bearer xyz Cookie: sid=def; other=ghi");
  assert.match(message, /https:\/\/example.com\/api/);
  for (const secret of ["user", "secret", "token", "abc", "xyz", "sid=def", "other=ghi"]) {
    assert.equal(message.includes(secret), false);
  }
  assert.equal(diagnosticMessage("Request body: {\"password\":\"secret\"}"), "body: [redacted]");
});

test("diagnostic buffers stay bounded and independent", () => {
  const a = new PreviewDiagnosticBuffer();
  const b = new PreviewDiagnosticBuffer();
  for (let i = 0; i < 60; i++) a.add({ kind: "console", timestamp: String(i), url: "https://example.com", message: String(i) });
  b.add({ kind: "request", timestamp: "b", url: "https://other.test", message: "failed" });
  assert.equal(a.recent(50).length, 50);
  assert.equal(a.recent(1)[0].message, "59");
  a.clear();
  assert.equal(a.recent(50).length, 0);
  assert.equal(b.recent(50).length, 1);
});
