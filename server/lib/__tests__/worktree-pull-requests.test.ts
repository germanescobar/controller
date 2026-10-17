import test from "node:test";
import assert from "node:assert/strict";
import { linkedPrPatch } from "../worktree-pull-requests.js";
import type { Worktree } from "../worktrees.js";

/*
 * Issue #436: task completion is independent of cleanup. A merged PR may
 * finish the task; a closed unmerged PR must not.
 */

const base: Worktree = {
  id: "wt-1",
  projectId: "proj-1",
  name: "feature",
  path: "/tmp/feature",
  branch: "feature",
  isMain: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  presence: "active",
  taskStatus: "active",
};

function prs(state: "OPEN" | "CLOSED" | "MERGED") {
  return new Map([["feature", { number: 7, state, url: "https://github.com/o/r/pull/7" }]]);
}

test("a newly merged PR finishes the task", () => {
  const patch = linkedPrPatch({ ...base, linkedPr: { number: 7, state: "OPEN", url: "u" } }, prs("MERGED"));
  assert.equal(patch?.taskStatus, "finished");
  assert.equal(patch?.linkedPr?.state, "MERGED");
});

test("a closed unmerged PR does not finish the task", () => {
  const patch = linkedPrPatch(base, prs("CLOSED"));
  assert.equal(patch?.linkedPr?.state, "CLOSED");
  assert.equal(patch?.taskStatus, undefined);
});

test("an unchanged merged PR does not override a task reopened by hand", () => {
  const worktree: Worktree = {
    ...base,
    linkedPr: { number: 7, state: "MERGED", url: "https://github.com/o/r/pull/7" },
  };
  assert.equal(linkedPrPatch(worktree, prs("MERGED")), null);
});

test("main and removed worktrees keep their recorded PR", () => {
  assert.equal(linkedPrPatch({ ...base, isMain: true }, prs("OPEN")), null);
  assert.equal(linkedPrPatch({ ...base, presence: "removed" }, prs("OPEN")), null);
});
