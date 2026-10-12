import test from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary, Worktree } from "../api.ts";
import {
  fetchProjectSessionSnapshot,
  mergeProjectSessionSnapshot,
} from "./sidebar-project-catch-up.ts";

test("project catch-up fetches every worktree session list for only the newly active project", async () => {
  const requests: string[] = [];
  const worktrees = [
    { id: "existing", projectId: "b" },
    { id: "created-while-inactive", projectId: "b" },
  ] as Worktree[];
  const snapshot = await fetchProjectSessionSnapshot(
    "b",
    async (projectId) => {
      requests.push(`worktrees:${projectId}`);
      return worktrees;
    },
    async (projectId, worktreeId) => {
      requests.push(`sessions:${projectId}:${worktreeId}`);
      return [{ id: `current-${worktreeId}` }] as SessionSummary[];
    },
  );

  assert.deepEqual(requests.sort(), [
    "sessions:b:created-while-inactive",
    "sessions:b:existing",
    "worktrees:b",
  ]);
  assert.deepEqual(
    snapshot.map(({ worktree, sessions }) => [worktree.id, sessions[0].id]),
    [
      ["existing", "current-existing"],
      ["created-while-inactive", "current-created-while-inactive"],
    ],
  );
});

test("project catch-up replaces missed changes and preserves expansion choices", () => {
  const worktree = (id: string) => ({ id, projectId: "b" }) as Worktree;
  const session = (id: string) => ({ id }) as SessionSummary;
  const merged = mergeProjectSessionSnapshot(
    [
      { ...worktree("existing"), sessions: [session("stale")], isExpanded: false },
      { ...worktree("removed"), sessions: [session("gone")], isExpanded: true },
    ],
    [
      { worktree: worktree("existing"), sessions: [session("current")] },
      {
        worktree: worktree("created-while-inactive"),
        sessions: [session("new"), session("archived")],
      },
    ],
    new Set(["archived"]),
    () => true,
  );

  assert.deepEqual(
    merged.map(({ id, sessions, isExpanded }) => ({
      id,
      sessionIds: sessions.map((item) => item.id),
      isExpanded,
    })),
    [
      { id: "existing", sessionIds: ["current"], isExpanded: false },
      { id: "created-while-inactive", sessionIds: ["new"], isExpanded: true },
    ],
  );
});
