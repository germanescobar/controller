import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  mergePathEntries,
  childProcessEnv,
  CONTROLLER_INTERNAL_ENV,
  shellQuote,
  formatEnvAssignments,
  writeEnvFile,
} from "../shell-env.js";

test("mergePathEntries keeps existing entries first and appends new ones", () => {
  const merged = mergePathEntries("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin");
  assert.equal(merged, "/usr/bin:/bin:/opt/homebrew/bin");
});

test("mergePathEntries dedupes within and across inputs", () => {
  const merged = mergePathEntries("/a:/a:/b", "/b:/c:/c");
  assert.equal(merged, "/a:/b:/c");
});

test("mergePathEntries ignores empty segments", () => {
  const merged = mergePathEntries("/a::/b", ":/c:");
  assert.equal(merged, "/a:/b:/c");
});

test("mergePathEntries handles an empty current path", () => {
  const merged = mergePathEntries("", "/usr/local/bin:/usr/bin");
  assert.equal(merged, "/usr/local/bin:/usr/bin");
});

test("childProcessEnv strips Controller's internal runtime vars", () => {
  const saved = { ...process.env };
  try {
    process.env.PORT = "4500";
    process.env.NODE_ENV = "production";
    process.env.SERVE_CLIENT_DIST = "1";
    process.env.CLIENT_DIST_DIR = "/app/dist/client";
    process.env.PATH = "/usr/bin";

    const env = childProcessEnv();

    for (const key of CONTROLLER_INTERNAL_ENV) {
      assert.equal(key in env, false, `${key} should be stripped`);
    }
    assert.equal(env.PATH, "/usr/bin");
  } finally {
    process.env = saved;
  }
});

test("childProcessEnv layers extra vars over the cleaned env", () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.PATH = "/usr/bin";

    const env = childProcessEnv({ NODE_ENV: "test", GIT_TERMINAL_PROMPT: "0" });

    // An explicit extra value wins even over a stripped key.
    assert.equal(env.NODE_ENV, "test");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.PATH, "/usr/bin");
  } finally {
    process.env = saved;
  }
});

test("childProcessEnv drops undefined values", () => {
  const saved = { ...process.env };
  try {
    process.env.DEFINED_VAR = "yes";
    delete process.env.MAYBE_UNDEFINED;

    const env = childProcessEnv();

    assert.equal(env.DEFINED_VAR, "yes");
    assert.equal("MAYBE_UNDEFINED" in env, false);
  } finally {
    process.env = saved;
  }
});

test("shellQuote wraps the value in single quotes and escapes embedded ones", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("with spaces"), "'with spaces'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("formatEnvAssignments renders KEY='value' pairs space-separated", () => {
  assert.equal(
    formatEnvAssignments({ A: "1", B: "two words" }),
    "A='1' B='two words'"
  );
  // Values with embedded single quotes must still be safe shell tokens.
  assert.equal(
    formatEnvAssignments({ GREETING: "hi y'all" }),
    "GREETING='hi y'\\''all'"
  );
});

test("writeEnvFile writes a shell-sourceable export-per-line file", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shell-env-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const file = path.join(tmp, "env.sh");
  await writeEnvFile(file, {
    PORT_OFFSET: "3",
    WORKTREE_PATH: "/p with space",
  });

  const contents = await fs.readFile(file, "utf8");
  assert.equal(
    contents,
    "export PORT_OFFSET='3'\nexport WORKTREE_PATH='/p with space'\n"
  );
});

test("writeEnvFile shell-quotes values with metacharacters so sourcing is safe", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shell-env-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const file = path.join(tmp, "env.sh");
  await writeEnvFile(file, {
    GREETING: "hi y'all",
    WITH_DOLLAR: "$HOME",
    WITH_NEWLINE: "a\nb",
  });

  const contents = await fs.readFile(file, "utf8");
  // Each value is shell-safe; embedded apostrophes, dollars, and newlines
  // never break out of the single-quoted form.
  assert.ok(contents.includes("export GREETING='hi y'\\''all'"));
  assert.ok(contents.includes("export WITH_DOLLAR='$HOME'"));
  assert.ok(contents.includes("export WITH_NEWLINE='a\nb'"));
});
