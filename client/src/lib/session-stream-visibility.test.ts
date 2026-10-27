import assert from "node:assert/strict";
import { test } from "node:test";
import { isStreamVisible } from "./session-stream-visibility.ts";

const worktree = { projectId: "coliseo", worktreeId: "casa-revalidation" };

test("a running session cannot attach to a new thread in the same worktree", () => {
  assert.equal(isStreamVisible(
    { ...worktree },
    { ...worktree, sessionId: "running" },
    "running",
    null,
  ), false);
});

test("a newly started session attaches to its originating new thread", () => {
  assert.equal(isStreamVisible(worktree, worktree, "created", null), true);
  assert.equal(isStreamVisible(
    { ...worktree, sessionId: "created" },
    { ...worktree, sessionId: "created" },
    "created",
    null,
  ), true);
});

test("a delayed start cannot attach after navigation to another session", () => {
  assert.equal(isStreamVisible(
    { ...worktree, sessionId: "other" },
    worktree,
    "created",
    null,
  ), false);
});
