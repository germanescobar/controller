import test from "node:test";
import assert from "node:assert/strict";
import { buildScriptEnv, buildTerminalScriptCommand } from "../project-scripts.js";

function makeContext(overrides: {
  portOffset?: number;
  branch?: string;
} = {}) {
  return {
    project: {
      id: "proj-1",
      name: "p",
      path: "/project",
      createdAt: "2026-01-01",
    },
    worktree: {
      id: "wt-1",
      projectId: "proj-1",
      name: "issue-2",
      path: "/project/.worktrees/issue-2",
      isMain: false,
      createdAt: "2026-01-01",
      branch: overrides.branch ?? "issue-2",
      portOffset: overrides.portOffset ?? 6,
    },
  };
}

test("buildScriptEnv exports port offset without project port defaults", () => {
  const env = buildScriptEnv(makeContext());
  assert.equal(env.PORT_OFFSET, "6");
  assert.equal(env.CLIENT_BASE_PORT, undefined);
  assert.equal(env.API_BASE_PORT, undefined);
});

test("buildScriptEnv uses zero port offset for main worktree", () => {
  const env = buildScriptEnv(makeContext({ portOffset: 0, branch: "main" }));
  assert.equal(env.PORT_OFFSET, "0");
  assert.equal(env.BRANCH, "main");
});

test("buildScriptEnv exposes source and worktree paths", () => {
  const env = buildScriptEnv(makeContext());
  assert.equal(env.WORKTREE_PATH, "/project/.worktrees/issue-2");
  assert.equal(env.SOURCE_PATH, "/project");
  assert.equal(env.WORKTREE_NAME, "issue-2");
});

test("buildTerminalScriptCommand sources an env file rather than inlining assignments", () => {
  // The command is sent to the user's interactive shell via `tmux send-keys`,
  // so its length must not scale with env size. Inlining `KEY='v' ...`
  // pairs would land them in the shell's input line and trip zsh's
  // command-line buffer / argv truncation. The env file is written by
  // the route handler; here we only assert the resulting command shape.
  const command = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    "/tmp/controller-run-env-wt1.sh"
  );

  // The body is one shell-quoted token, with the env file path inside it
  // escaped via shellQuote so any single quote in the path stays safe.
  // We assert the structural shape rather than exact byte-equality to
  // avoid duplicating shellQuote's behavior here.
  assert.ok(command.startsWith("bash -lc 'set -e; set -a; . "));
  assert.ok(command.includes("/tmp/controller-run-env-wt1.sh"));
  assert.ok(command.includes("set +a; bash /p/run.sh"));
  assert.ok(command.includes("rm -f "));
  assert.ok(command.endsWith("'"));
  // No env values may leak into the command string itself.
  assert.ok(!command.includes("WORKTREE_PATH="));
  assert.ok(!command.includes("PORT_OFFSET="));
  assert.ok(!command.includes("CONDUCTOR_"));
  assert.ok(!command.includes("SUPERSET_"));
});

test("buildTerminalScriptCommand command string is independent of env size", () => {
  // The whole point: the command string the user's shell parses via
  // `tmux send-keys` must stay short and bounded regardless of how big
  // env values are. The env is in a file, not in the command, so this
  // is satisfied by construction — but we assert the outer shape is
  // stable across varied env file paths and command bodies.
  const short = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    "/tmp/e.sh"
  );
  const long = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    "/tmp/controller-run-env-worktree-with-a-long-id-1234567890.sh"
  );
  assert.ok(short.startsWith("bash -lc '"));
  assert.ok(long.startsWith("bash -lc '"));
  assert.ok(short.endsWith("'"));
  assert.ok(long.endsWith("'"));
  // The growth comes only from the env file path; the env values
  // themselves are never in the command. The exact length delta depends
  // on shellQuote's escaping (apostrophes get doubled), so we don't
  // pin a number — just lock in that no env value appears in either.
  for (const value of ["WORKTREE_PATH=", "PORT_OFFSET=", "CONDUCTOR_", "SUPERSET_"]) {
    assert.ok(!short.includes(value), `short should not contain ${value}`);
    assert.ok(!long.includes(value), `long should not contain ${value}`);
  }
});

test("buildTerminalScriptCommand joins multiple commands with newlines inside one body", () => {
  // `;` would split into separate `bash -lc` calls if the body were not
  // a single shell-quoted token. The whole body is one token here, so
  // any metacharacter inside (including newlines) stays inside the
  // script.
  const command = buildTerminalScriptCommand(
    [
      { command: "echo first", label: "1", source: "native" },
      { command: "echo second", label: "2", source: "native" },
    ],
    "/tmp/controller-run-env-wt1.sh"
  );
  assert.ok(command.startsWith("bash -lc '"));
  // The joined body still appears, in order, with newlines intact.
  assert.ok(command.includes("set +a; echo first;\necho second; rm -f "));
  assert.ok(command.endsWith("'"));
});
