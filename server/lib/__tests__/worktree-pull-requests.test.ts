import test from "node:test";
import assert from "node:assert/strict";
import { linkedPrPatch } from "../worktree-pull-requests.js";
import type { Worktree } from "../worktrees.js";

/*
 * Issue #436: each worktree records the PR for the branch it currently has
 * checked out, which can differ from the branch it was created with.
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
};

const pr7 = { number: 7, state: "OPEN" as const, url: "https://github.com/o/r/pull/7" };
const pr9 = { number: 9, state: "OPEN" as const, url: "https://github.com/o/r/pull/9" };
const prs = new Map([["feature", pr7], ["other", pr9]]);

test("a new or changed PR state is recorded", () => {
  assert.deepEqual(linkedPrPatch(base, "feature", prs), { linkedPr: pr7 });
  const merged = new Map([["feature", { ...pr7, state: "MERGED" as const }]]);
  assert.equal(linkedPrPatch({ ...base, linkedPr: pr7 }, "feature", merged)?.linkedPr?.state, "MERGED");
});

test("an unchanged PR produces no update", () => {
  assert.equal(linkedPrPatch({ ...base, linkedPr: pr7 }, "feature", prs), null);
});

test("the PR follows the branch currently checked out", () => {
  assert.deepEqual(linkedPrPatch({ ...base, linkedPr: pr7 }, "other", prs), { linkedPr: pr9 });
});

test("a branch without a PR, or a detached HEAD, clears the recorded PR", () => {
  assert.deepEqual(linkedPrPatch({ ...base, linkedPr: pr7 }, "no-pr", prs), { linkedPr: undefined });
  assert.deepEqual(linkedPrPatch({ ...base, linkedPr: pr7 }, null, prs), { linkedPr: undefined });
  assert.equal(linkedPrPatch(base, null, prs), null);
});
