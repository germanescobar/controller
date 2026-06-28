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

test("buildTerminalScriptCommand routes env through `env` to avoid argv bloat", () => {
  // Previously the command line was `KEY='v' KEY2='v2' bash -lc 'set -e; body'`.
  // With long paths + UUIDs in env (PORT_OFFSET plus Conductor/Superset
  // compat shims) that prefix could push past zsh's command-line buffer and
  // get silently truncated. Routing through `env` keeps the values out of
  // the shell's argv expansion entirely.
  const env = buildScriptEnv(makeContext());
  const command = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    env
  );

  assert.ok(command.startsWith("env "), `expected to start with "env ", got: ${command}`);
  assert.ok(
    command.endsWith("'bash' '-lc' 'set -e; bash /p/run.sh'"),
    `unexpected tail: ...${command.slice(-60)}`
  );
  // Every Controller export must be passed to env, not dropped or inlined
  // before bash.
  for (const key of Object.keys(env)) {
    assert.ok(
      command.includes(` ${key}=`),
      `expected ${key} assignment in command, got: ${command}`
    );
  }
});

test("buildTerminalScriptCommand keeps the command tail short under heavy env", () => {
  // The whole point: the bash invocation tail must be independent of how
  // much env is in play. Heavy env (long paths, UUIDs) must not lengthen
  // the part the user's shell actually parses.
  const heavy = {
    WORKTREE_PATH: "/" + "a".repeat(2000),
    SOURCE_PATH: "/" + "b".repeat(2000),
    PROJECT_ID: "uuid-" + "c".repeat(2000),
    PORT_OFFSET: "3",
  };
  const command = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    heavy
  );
  assert.ok(
    command.endsWith("'bash' '-lc' 'set -e; bash /p/run.sh'"),
    `command should have a short fixed-size tail, got: ...${command.slice(-80)}`
  );
});

test("buildTerminalScriptCommand preserves Conductor and Superset compat shims", () => {
  // Conductor/Superset projects rely on these names in their scripts.
  // They must keep flowing through to env so those scripts still work.
  const env = buildScriptEnv(makeContext());
  const command = buildTerminalScriptCommand(
    [{ command: "bash /p/run.sh", label: "run.sh", source: "native" }],
    env
  );

  for (const key of [
    "CONDUCTOR_WORKSPACE_PATH",
    "CONDUCTOR_ROOT_PATH",
    "CONDUCTOR_PORT",
    "SUPERSET_WORKSPACE_PATH",
  ]) {
    assert.ok(
      command.includes(` ${key}=`),
      `expected ${key} to be passed through, got: ${command}`
    );
  }
});
