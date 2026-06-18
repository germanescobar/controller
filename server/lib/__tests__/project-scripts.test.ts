import test from "node:test";
import assert from "node:assert/strict";
import { buildScriptEnv } from "../project-scripts.js";

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

test("buildScriptEnv exports base ports and port offset", () => {
  const env = buildScriptEnv(makeContext());
  assert.equal(env.CLIENT_BASE_PORT, "4500");
  assert.equal(env.API_BASE_PORT, "3100");
  assert.equal(env.PORT_OFFSET, "6");
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
