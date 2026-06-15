import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateBrowserUrl } from "../browser-policy.js";

const PROJECT_ROOT = "/tmp/example-project";

test("allows localhost addresses and normalizes the scheme", () => {
  const result = validateBrowserUrl("localhost:5173", PROJECT_ROOT);
  assert.equal(result.allowed, true);
  assert.equal(result.url, "http://localhost:5173/");
});

test("allows web URLs", () => {
  const result = validateBrowserUrl("https://example.com/path", PROJECT_ROOT);
  assert.equal(result.allowed, true);
  assert.equal(result.url, "https://example.com/path");
});

test("allows project-relative file paths inside the worktree", () => {
  const result = validateBrowserUrl("./dist/index.html", PROJECT_ROOT);
  assert.equal(result.allowed, true);
  assert.equal(
    result.url,
    pathToFileURL(path.join(PROJECT_ROOT, "dist/index.html")).toString()
  );
});

test("rejects file paths outside the worktree", () => {
  const result = validateBrowserUrl("/etc/passwd", PROJECT_ROOT);
  assert.equal(result.allowed, false);
  assert.match(result.error ?? "", /inside the active project/);
});

test("rejects file URLs when no worktree is known", () => {
  const result = validateBrowserUrl("/tmp/example-project/index.html");
  assert.equal(result.allowed, false);
});

test("rejects unsupported schemes", () => {
  const result = validateBrowserUrl("ftp://example.com", PROJECT_ROOT);
  assert.equal(result.allowed, false);
});
