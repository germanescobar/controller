import test from "node:test";
import assert from "node:assert/strict";
import {
  mergePathEntries,
  childProcessEnv,
  CONTROLLER_INTERNAL_ENV,
  shellQuote,
  formatEnvAssignments,
  buildEnvCommand,
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

test("buildEnvCommand prefixes the command with env KEY=val assignments", () => {
  const out = buildEnvCommand(["bash", "-lc", "run.sh"], {
    PORT_OFFSET: "3",
    WORKTREE_PATH: "/p with space",
  });
  assert.equal(
    out,
    "env PORT_OFFSET='3' WORKTREE_PATH='/p with space' 'bash' '-lc' 'run.sh'"
  );
});

test("buildEnvCommand shell-quotes each command element so metacharacters survive", () => {
  // `;` inside the body must not be parsed as a shell separator — the body
  // is one quoted argument to `bash -lc`.
  const out = buildEnvCommand(["bash", "-lc", "set -e; run.sh"], { A: "1" });
  assert.equal(out, "env A='1' 'bash' '-lc' 'set -e; run.sh'");
});

test("buildEnvCommand keeps the command line short under heavy env payloads", () => {
  // The point of routing through `env` (vs. inlining KEY='v' pairs into the
  // shell command line) is to avoid ARG_MAX / zsh command-line buffer
  // truncation when env carries long paths or UUIDs. The body tail must
  // be the only env-independent part of the command.
  const short = buildEnvCommand(["bash", "-lc", "set -e; run.sh"], { A: "1" });
  const heavy = buildEnvCommand(["bash", "-lc", "set -e; run.sh"], {
    PATH: "/very/long/" + "x".repeat(2000),
    PROJECT_ID: "uuid-" + "y".repeat(2000),
  });
  assert.equal(short, "env A='1' 'bash' '-lc' 'set -e; run.sh'");
  assert.ok(
    heavy.endsWith(" 'bash' '-lc' 'set -e; run.sh'"),
    `unexpected tail: ${heavy.slice(-60)}`
  );
});
