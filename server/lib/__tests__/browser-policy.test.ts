import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateBrowserFilePath,
  validateBrowserUrl,
} from "../browser-policy.js";

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

test("--insecure allows https URLs on localhost", () => {
  const result = validateBrowserUrl("https://localhost:5050", PROJECT_ROOT, {
    insecure: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.url, "https://localhost:5050/");
});

test("--insecure allows http on 127.0.0.1", () => {
  const result = validateBrowserUrl("http://127.0.0.1:3000", PROJECT_ROOT, {
    insecure: true,
  });
  assert.equal(result.allowed, true);
});

test("--insecure rejects https to external hosts", () => {
  const result = validateBrowserUrl("https://example.com", PROJECT_ROOT, {
    insecure: true,
  });
  assert.equal(result.allowed, false);
  assert.match(result.error ?? "", /only applies to localhost/);
});

test("--insecure rejects file://", () => {
  // --insecure is a TLS-cert bypass, not a path-policy bypass.
  const result = validateBrowserUrl("./dist/index.html", PROJECT_ROOT, {
    insecure: true,
  });
  // file:// is still governed by the project-root check; this test mainly
  // documents that adding `insecure` doesn't widen file-access.
  assert.equal(result.allowed, true);
});

// ---------------------------------------------------------------------------
// validateBrowserFilePath — issue #356
// ---------------------------------------------------------------------------
//
// Same boundary tests as the URL side: empty/missing/non-file inputs are
// rejected up front, project-inside files are always allowed, project-outside
// files require the explicit `allowOutside` opt-in.

test("validateBrowserFilePath rejects non-string / empty paths", () => {
  assert.equal(validateBrowserFilePath("", PROJECT_ROOT).allowed, false);
  assert.equal(validateBrowserFilePath("   ", PROJECT_ROOT).allowed, false);
});

test("validateBrowserFilePath rejects paths that do not exist", () => {
  const result = validateBrowserFilePath(
    "/tmp/__definitely_not_a_real_file__1234.bin",
    PROJECT_ROOT
  );
  assert.equal(result.allowed, false);
  assert.equal(result.scope, "invalid");
  assert.match(result.error ?? "", /does not exist/);
});

test("validateBrowserFilePath rejects directory paths", () => {
  // /tmp should be a directory; we should not accept a directory even
  // though statSync succeeds.
  const result = validateBrowserFilePath("/tmp", PROJECT_ROOT);
  assert.equal(result.allowed, false);
  assert.match(result.error ?? "", /not a regular file/);
});

test("validateBrowserFilePath requires a projectRoot", () => {
  // Build a real file in os.tmpdir so the exists check passes; the
  // policy still has to refuse because there's no worktree to scope
  // against.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-"));
  const file = path.join(tmp, "a.txt");
  fs.writeFileSync(file, "hello");
  try {
    const result = validateBrowserFilePath(file, undefined);
    assert.equal(result.allowed, false);
    assert.match(result.error ?? "", /active worktree/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateBrowserFilePath allows a real file inside the worktree", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-"));
  const file = path.join(tmp, "inside.txt");
  fs.writeFileSync(file, "ok");
  try {
    const result = validateBrowserFilePath(file, tmp);
    assert.equal(result.allowed, true);
    // The policy canonicalizes both sides via `realpath` (issue #356
    // review, P1) so the comparison cannot be tricked by a symlink
    // in the worktree. On macOS `os.tmpdir()` itself is a symlink
    // (e.g. `/var/folders/...` → `/private/var/folders/...`), so the
    // canonicalized path differs from `path.resolve` even when the
    // file itself has no symlink component.
    assert.equal(result.path, fs.realpathSync(file));
    assert.equal(result.scope, "inside-project");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateBrowserFilePath rejects a file outside the worktree by default", () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-inside-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-outside-"));
  const file = path.join(outside, "secret.txt");
  fs.writeFileSync(file, "shh");
  try {
    const result = validateBrowserFilePath(file, inside);
    assert.equal(result.allowed, false);
    assert.equal(result.scope, undefined);
    assert.match(result.error ?? "", /--allow-outside/);
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("validateBrowserFilePath allows an outside file when --allow-outside is set", () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-inside-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-outside-"));
  const file = path.join(outside, "report.pdf");
  fs.writeFileSync(file, "pdf-bytes");
  try {
    const result = validateBrowserFilePath(file, inside, { allowOutside: true });
    assert.equal(result.allowed, true);
    // See the inside-project test above for why this is `realpathSync`
    // rather than `path.resolve`.
    assert.equal(result.path, fs.realpathSync(file));
    assert.equal(result.scope, "outside-project");
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("validateBrowserFilePath resolves a relative path against the supplied cwd", () => {
  // Documented as `./dist/screenshot.png` in the CLI help text. The
  // server's own `process.cwd()` is unrelated to the agent's shell
  // in packaged builds, so the route threads the request `cwd`
  // through (issue #356 review, P1).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-"));
  const subdir = path.join(tmp, "dist");
  fs.mkdirSync(subdir);
  const file = path.join(subdir, "screenshot.png");
  fs.writeFileSync(file, "png");
  try {
    const result = validateBrowserFilePath("./dist/screenshot.png", tmp, {
      cwd: tmp,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.path, fs.realpathSync(file));
    assert.equal(result.scope, "inside-project");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateBrowserFilePath rejects a symlink that escapes the worktree", () => {
  // The lexical `path.relative` check the v1 Preview pane used (and
  // the original file-path policy used) is fooled by a symlink that
  // lives in the worktree but points to a target outside it. After
  // `realpath`, the symlink's resolved target lands outside the
  // canonical worktree root, so the canonicalized comparison
  // correctly classifies it as outside-project (issue #356 review,
  // P1).
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-inside-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-outside-"));
  const real = path.join(outside, "secret.txt");
  fs.writeFileSync(real, "shh");
  const link = path.join(inside, "link.txt");
  try {
    fs.symlinkSync(real, link);
    const result = validateBrowserFilePath(link, inside);
    assert.equal(result.allowed, false);
    assert.match(result.error ?? "", /--allow-outside/);
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
