import test from "node:test";
import assert from "node:assert/strict";
import { planPendingRefreshDrain } from "../sidebar.tsx";

const key = (projectId: string, worktreeId: string) =>
  `${projectId}\u0000${worktreeId}`;

const projects = [
  { id: "p1", worktrees: [{ id: "w1" }, { id: "w2" }] },
];

test("planPendingRefreshDrain holds every queued scope while a loadAll is in flight", () => {
  // Regression: a targeted refresh that deferred behind a slow loadAll
  // re-queued itself, the microtask drain replayed it immediately, and
  // the replay deferred again — one request per round-trip until the
  // load finished.
  const plan = planPendingRefreshDrain({
    inFlightLoadAlls: 1,
    lastSuccessToken: 1,
    pendingSessionKeys: [key("p1", "w1"), key("gone", "w9")],
    pendingProjectIds: ["p1", "gone"],
    projects,
  });
  assert.deepEqual(plan, {
    dispatchSessions: [],
    dispatchProjects: [],
    evictSessions: [],
    evictProjects: [],
  });
});

test("planPendingRefreshDrain replays loaded targets once no loadAll is in flight", () => {
  const plan = planPendingRefreshDrain({
    inFlightLoadAlls: 0,
    lastSuccessToken: 3,
    pendingSessionKeys: [key("p1", "w2")],
    pendingProjectIds: ["p1"],
    projects,
  });
  assert.deepEqual(plan.dispatchSessions, [
    { key: key("p1", "w2"), projectId: "p1", worktreeId: "w2" },
  ]);
  assert.deepEqual(plan.dispatchProjects, ["p1"]);
  assert.deepEqual(plan.evictSessions, []);
  assert.deepEqual(plan.evictProjects, []);
});

test("planPendingRefreshDrain keeps a session scope queued until its worktree loads", () => {
  const plan = planPendingRefreshDrain({
    inFlightLoadAlls: 0,
    lastSuccessToken: 3,
    pendingSessionKeys: [key("p1", "w-new")],
    pendingProjectIds: [],
    projects,
  });
  assert.deepEqual(plan.dispatchSessions, []);
  assert.deepEqual(plan.evictSessions, []);
});

test("planPendingRefreshDrain evicts scopes for missing projects only after a successful loadAll", () => {
  const input = {
    inFlightLoadAlls: 0,
    pendingSessionKeys: [key("gone", "w9")],
    pendingProjectIds: ["gone"],
    projects,
  };
  // No loadAll has succeeded yet (initial load failed or hasn't run):
  // the project may simply not be painted, so keep the scopes.
  const beforeSuccess = planPendingRefreshDrain({ ...input, lastSuccessToken: 0 });
  assert.deepEqual(beforeSuccess.evictSessions, []);
  assert.deepEqual(beforeSuccess.evictProjects, []);
  assert.deepEqual(beforeSuccess.dispatchSessions, []);
  assert.deepEqual(beforeSuccess.dispatchProjects, []);

  const afterSuccess = planPendingRefreshDrain({ ...input, lastSuccessToken: 2 });
  assert.deepEqual(afterSuccess.evictSessions, [key("gone", "w9")]);
  assert.deepEqual(afterSuccess.evictProjects, ["gone"]);
});
