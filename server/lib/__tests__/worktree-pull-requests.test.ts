import test from "node:test";
import assert from "node:assert/strict";
import { linkedPrPatch } from "../worktree-pull-requests.js";
import type { Worktree } from "../worktrees.js";

/* Issue #436: each worktree records the latest PR for its branch. */

const base: Worktree = {
  id: "wt-1",
  projectId: "proj-1",
  name: "feature",
  path: "/tmp/feature",
  branch: "feature",
  isMain: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  presence: "active",
};

function prs(state: "OPEN" | "CLOSED" | "MERGED") {
  return new Map([["feature", { number: 7, state, url: "https://github.com/o/r/pull/7" }]]);
}

test("a new or changed PR state is recorded", () => {
  assert.equal(linkedPrPatch(base, prs("OPEN"))?.linkedPr?.state, "OPEN");
  const open: Worktree = { ...base, linkedPr: { number: 7, state: "OPEN", url: "u" } };
  assert.equal(linkedPrPatch(open, prs("MERGED"))?.linkedPr?.state, "MERGED");
});

test("an unchanged PR produces no update", () => {
  const merged: Worktree = {
    ...base,
    linkedPr: { number: 7, state: "MERGED", url: "https://github.com/o/r/pull/7" },
  };
  assert.equal(linkedPrPatch(merged, prs("MERGED")), null);
});

test("main and removed worktrees keep their recorded PR", () => {
  assert.equal(linkedPrPatch({ ...base, isMain: true }, prs("OPEN")), null);
  assert.equal(linkedPrPatch({ ...base, presence: "removed" }, prs("OPEN")), null);
});
