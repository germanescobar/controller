import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Issue #351 + #353: cross-worktree children walk.
 *
 * `listChildSessions(parentId)` powers two surfaces:
 *   - `GET /api/sessions/:sessionId/children` and the
 *     `controller sessions children <id>` CLI verb.
 *   - The strict-archive rule's `collectArchiveBlockers` recursion.
 *
 * Both surfaces need to see children that live in a *different*
 * worktree from the parent — the `--parent` flag from #353 makes
 * that a normal case (a coordinator on the main worktree can spawn
 * a child on a feature worktree, or vice versa). The previous
 * single-project implementation only walked the parent's worktree
 * path, so cross-worktree children were silently dropped. These
 * tests plant a parent + cross-worktree children on disk and assert
 * the walker picks all of them up, in `lastActiveAt` desc order,
 * while excluding sessions that belong to a different parent and
 * sessions that have been archived.
 *
 * The test fixture mirrors `session-locator.test.ts`: a temp
 * `CONTROLLER_HOME`, a single project with a main and a feature
 * worktree (registered in `worktrees.json`), and per-worktree
 * session files written into `projectStoreDir(worktree.path)`.
 */

import { listChildSessions } from "../sessions.js";
import { projectStoreDir } from "../paths.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "list-child-sessions-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function plantProject(
  home: string,
  projectId: string,
  projectName: string,
  projectPath: string
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path.join(home, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: projectName,
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );
}

async function plantWorktreeRegistry(
  home: string,
  worktrees: Array<{
    id: string;
    projectId: string;
    name: string;
    path: string;
    branch: string;
    isMain: boolean;
    createdAt: string;
  }>
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path.join(home, "worktrees.json"),
    JSON.stringify(worktrees)
  );
}

function plantSessionFile(worktreePath: string, session: {
  id: string;
  title: string;
  parentId?: string;
  worktreeId?: string;
  lastActiveAt: string;
  status?: string;
}): void {
  const dir = path.join(projectStoreDir(worktreePath), "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${session.id}.json`),
    JSON.stringify({
      id: session.id,
      title: session.title,
      workingDirectory: worktreePath,
      worktreeId: session.worktreeId ?? null,
      model: "test-model",
      provider: "anita",
      mode: "default",
      messages: [],
      createdAt: session.lastActiveAt,
      lastActiveAt: session.lastActiveAt,
      status: session.status ?? "active",
      ...(session.parentId ? { parentId: session.parentId } : {}),
    })
  );
}

test("listChildSessions returns children that live in the same worktree as the parent (regression for the original single-worktree path)", async () => {
  // The previous implementation already handled this case. Lock it
  // in so the cross-worktree walker doesn't regress on the easy
  // path while it learns the harder one.
  const parentId = "sess-parent";
  const childId = "sess-child-same-worktree";
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    plantSessionFile(mainPath, {
      id: parentId,
      title: "Parent on main",
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T22:00:00.000Z",
    });
    plantSessionFile(mainPath, {
      id: childId,
      title: "Child on main",
      parentId,
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T22:05:00.000Z",
    });
    // A noise session with a different parent — must not appear.
    plantSessionFile(mainPath, {
      id: "sess-noise",
      title: "Belongs to someone else",
      parentId: "sess-other-parent",
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T22:10:00.000Z",
    });
    await plantProject(home, "proj-1", "demo", mainPath);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        branch: "main",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    const children = await listChildSessions(parentId);
    assert.deepEqual(
      children.map((c) => c.id),
      [childId],
      "same-worktree child must be returned, noise session must be filtered"
    );
  });
});

test("listChildSessions returns children that live in a different worktree of the same project (issue #353 cross-worktree fix)", async () => {
  // The bug the other agent surfaced: a parent on the main worktree
  // and a child on a feature worktree live in different per-worktree
  // stores (the store key is a hash of the absolute worktree path),
  // so a single-worktree walk misses the child. This is the
  // exact case the parent on the main worktree of project
  // `coding-orchestrator` would hit when a child is spawned via
  // `--parent <self>` on its `issue-351` worktree.
  const parentId = "sess-parent";
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(mainPath, { recursive: true });
    mkdirSync(featurePath, { recursive: true });
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    mkdirSync(path.join(projectStoreDir(featurePath), "sessions"), { recursive: true });
    // Parent on the main worktree.
    plantSessionFile(mainPath, {
      id: parentId,
      title: "Parent on main",
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T21:30:00.000Z",
    });
    // Two children on the feature worktree, both with the parent.
    plantSessionFile(featurePath, {
      id: "sess-child-feature-1",
      title: "Hello 1 (feature)",
      parentId,
      worktreeId: "wt-feature",
      lastActiveAt: "2026-09-13T22:13:18.000Z",
    });
    plantSessionFile(featurePath, {
      id: "sess-child-feature-2",
      title: "Hello 2 (feature)",
      parentId,
      worktreeId: "wt-feature",
      lastActiveAt: "2026-09-13T22:14:00.000Z",
    });
    // A noise session on the feature worktree with a different
    // parent — must not appear.
    plantSessionFile(featurePath, {
      id: "sess-noise-feature",
      title: "Unrelated",
      parentId: "sess-someone-else",
      worktreeId: "wt-feature",
      lastActiveAt: "2026-09-13T22:20:00.000Z",
    });
    // A child on the main worktree too — must also appear.
    plantSessionFile(mainPath, {
      id: "sess-child-main",
      title: "Hello 3 (main, same as parent)",
      parentId,
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T22:00:00.000Z",
    });
    await plantProject(home, "proj-1", "demo", mainPath);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        branch: "main",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "wt-feature",
        projectId: "proj-1",
        name: "feature",
        path: featurePath,
        branch: "feature",
        isMain: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    const children = await listChildSessions(parentId);
    const ids = children.map((c) => c.id);
    // All three children must appear, in lastActiveAt desc order.
    // The unrelated noise session must NOT.
    assert.deepEqual(
      ids,
      [
        "sess-child-feature-2", // 22:14
        "sess-child-feature-1", // 22:13
        "sess-child-main", //      22:00
      ],
      `expected all three cross-worktree children in lastActiveAt desc order, got: ${ids.join(", ")}`
    );
    // Parent is not in its own children list.
    assert.ok(!ids.includes(parentId), "parent must not appear in its own children");
    // Noise session is not in the children list.
    assert.ok(
      !ids.includes("sess-noise-feature"),
      "unrelated session must be filtered out"
    );
  });
});

test("listChildSessions returns children that live in a different project entirely (multi-project case)", async () => {
  // Edge case: a parent in project A and a child in project B.
  // The single-project walker would miss the child. The cross-
  // project walker picks it up.
  const parentId = "sess-parent-projA";
  const childId = "sess-child-projB";
  await withTempHome(async (home) => {
    const projAPath = path.join(home, "projA");
    const projBPath = path.join(home, "projB");
    mkdirSync(projAPath, { recursive: true });
    mkdirSync(projBPath, { recursive: true });
    mkdirSync(path.join(projectStoreDir(projAPath), "sessions"), { recursive: true });
    mkdirSync(path.join(projectStoreDir(projBPath), "sessions"), { recursive: true });
    plantSessionFile(projAPath, {
      id: parentId,
      title: "Parent in A",
      worktreeId: "wt-a",
      lastActiveAt: "2026-09-13T20:00:00.000Z",
    });
    plantSessionFile(projBPath, {
      id: childId,
      title: "Child in B",
      parentId,
      worktreeId: "wt-b",
      lastActiveAt: "2026-09-13T21:00:00.000Z",
    });
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(home, "projects.json"),
      JSON.stringify([
        { id: "proj-a", name: "A", path: projAPath, createdAt: new Date().toISOString() },
        { id: "proj-b", name: "B", path: projBPath, createdAt: new Date().toISOString() },
      ])
    );
    await plantWorktreeRegistry(home, [
      { id: "wt-a", projectId: "proj-a", name: "main", path: projAPath, branch: "main", isMain: true, createdAt: new Date().toISOString() },
      { id: "wt-b", projectId: "proj-b", name: "main", path: projBPath, branch: "main", isMain: true, createdAt: new Date().toISOString() },
    ]);
    const children = await listChildSessions(parentId);
    assert.deepEqual(
      children.map((c) => c.id),
      [childId],
      "child in a different project must be returned"
    );
  });
});

test("listChildSessions excludes archived children (matches the rest of the surface)", async () => {
  // `getSessions` already filters out archived sessions; the
  // children walk uses `getSessions` per worktree, so archived
  // children must not surface in the result. The strict-archive
  // caller relies on this — a freshly-archived child shouldn't
  // block the parent's archive a second time.
  const parentId = "sess-parent";
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    plantSessionFile(mainPath, {
      id: parentId,
      title: "Parent",
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T20:00:00.000Z",
    });
    plantSessionFile(mainPath, {
      id: "sess-active-child",
      title: "Active child",
      parentId,
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T21:00:00.000Z",
    });
    plantSessionFile(mainPath, {
      id: "sess-archived-child",
      title: "Archived child",
      parentId,
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T21:30:00.000Z",
      status: "archived",
    });
    await plantProject(home, "proj-1", "demo", mainPath);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        branch: "main",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    const children = await listChildSessions(parentId);
    assert.deepEqual(
      children.map((c) => c.id),
      ["sess-active-child"],
      "archived children must be excluded from the result"
    );
  });
});

test("listChildSessions returns an empty array when the parent has no children", async () => {
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    plantSessionFile(mainPath, {
      id: "sess-without-kids",
      title: "No children here",
      worktreeId: "wt-main",
      lastActiveAt: "2026-09-13T20:00:00.000Z",
    });
    await plantProject(home, "proj-1", "demo", mainPath);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        branch: "main",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    const children = await listChildSessions("sess-without-kids");
    assert.deepEqual(children, []);
  });
});

test("listChildSessions returns an empty array when no projects are registered", async () => {
  // Defensive: an empty Controller home (e.g. a fresh install or a
  // test fixture) must not throw — the walker should treat the
  // empty project list as "no children" and move on.
  await withTempHome(async () => {
    const children = await listChildSessions("any-parent-id");
    assert.deepEqual(children, []);
  });
});
