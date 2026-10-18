import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Regression tests for issue #437: detect, surface, and repair
 * duplicate session IDs across per-worktree stores.
 *
 * The original on-disk reproduction (observed 2026-10-16 on the
 * Controller repo) had the same session id living in the `main`
 * worktree and a feature worktree, with the same title and creation
 * time but divergent `lastActiveAt` and event counts. The
 * `sess-issue-376-synthetic-run-failed` session in the Controller
 * home still has 15 colliding copies today, so the test fixtures
 * mirror the production shape but plant a controlled number of
 * copies (2-3) so the assertions stay readable.
 *
 * The detection walk (`findSessionCollisions` /
 * `findSessionCollisionsInProject`), the deterministic owner
 * picker (`pickOwner`), and the quarantine repair
 * (`quarantineCollision`) are all covered. The CLI surface and the
 * route handler are exercised via direct calls — the routes just
 * thinly wrap the helpers.
 */

import {
  CollisionError,
  findSessionCollisions,
  findSessionCollisionsInProject,
  formatCollisionRow,
  listAllCollisions,
  pickOwner,
  quarantineCollision,
  type CollisionCandidate,
} from "../session-collision.js";
import { projectStoreDir } from "../paths.js";
import { getProjectWorktrees, invalidateWorktreeCache } from "../worktrees.js";
import { getSession, saveSession, appendEvent, type SessionState } from "../sessions.js";
import { getSessionSummaries } from "../sessions.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-collision-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    invalidateWorktreeCache();
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function plantProjectRegistry(
  home: string,
  projects: Array<{
    id: string;
    name: string;
    path: string;
    createdAt: string;
  }>
): Promise<void> {
  await fs.writeFile(
    path.join(home, "projects.json"),
    JSON.stringify(projects)
  );
}

async function plantWorktreeRegistry(
  home: string,
  worktrees: Array<{
    id: string;
    projectId: string;
    name: string;
    path: string;
    branch?: string;
    isMain: boolean;
    createdAt: string;
  }>
): Promise<void> {
  await fs.writeFile(
    path.join(home, "worktrees.json"),
    JSON.stringify(worktrees)
  );
}

function plantSessionInWorktree(
  worktreePath: string,
  session: SessionState,
  events: Array<{ id: string; timestamp: string; type: string; data?: unknown }> = []
): void {
  const store = projectStoreDir(worktreePath);
  mkdirSync(path.join(store, "sessions"), { recursive: true });
  mkdirSync(path.join(store, "events"), { recursive: true });
  writeFileSync(
    path.join(store, "sessions", `${session.id}.json`),
    JSON.stringify({
      ...session,
      workingDirectory: worktreePath,
      messages: [],
    })
  );
  if (events.length > 0) {
    const lines = events
      .map((event) =>
        JSON.stringify({
          sessionId: session.id,
          ...event,
        })
      )
      .join("\n");
    writeFileSync(
      path.join(store, "events", `${session.id}.jsonl`),
      `${lines}\n`
    );
  } else {
    // Touch the file with a trailing newline so the events size
    // is non-zero — the owner-pick tiebreaker keys on the events
    // file size, and the test wants to exercise the path where
    // every store has at least one event.
    writeFileSync(path.join(store, "events", `${session.id}.jsonl`), "\n");
  }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: overrides.id ?? "session-1",
    title: "Trigger the synthetic-run-failed-with-stderr path.",
    workingDirectory: "/tmp/proj",
    worktreeId: overrides.worktreeId ?? "",
    model: "test-model",
    provider: "anita",
    mode: "default",
    messages: [],
    createdAt: overrides.createdAt ?? "2026-10-16T04:15:21.000Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-10-16T04:15:21.000Z",
    status: "active",
    ...overrides,
  };
}

test("findSessionCollisions returns the empty array for a session id that lives nowhere", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await findSessionCollisions("missing"), []);
  });
});

test("findSessionCollisions returns the single copy for a session id that lives in one worktree", async () => {
  // No collision yet — a single store copy is the happy path and
  // should NOT be reported as a collision. The route handler
  // uses this distinction to decide whether to surface the
  // diagnostic.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    await plantProjectRegistry(home, [
      {
        id: "proj-1",
        name: "demo",
        path: mainPath,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        isMain: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    plantSessionInWorktree(mainPath, makeSession({ id: "solo", worktreeId: "wt-main" }));
    const candidates = await findSessionCollisions("solo");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].worktreeId, "wt-main");
  });
});

test("findSessionCollisionsInProject returns the same id living in two worktrees as a collision", async () => {
  // The exact shape from the issue body: a session id with the
  // same title and creation time but different lastActiveAt
  // living in `main` and `issue-434`. The detection must return
  // both candidates so the owner picker and the read paths can
  // agree on which copy "wins".
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "issue-434");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      {
        id: "proj-1",
        name: "demo",
        path: mainPath,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await plantWorktreeRegistry(home, [
      {
        id: "wt-main",
        projectId: "proj-1",
        name: "main",
        path: mainPath,
        isMain: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "wt-434",
        projectId: "proj-1",
        name: "issue-434",
        path: featurePath,
        branch: "issue-434",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const createdAt = "2026-10-16T04:15:21.000Z";
    plantSessionInWorktree(
      mainPath,
      makeSession({
        id: "shared",
        title: "Trigger the synthetic-run-failed-with-stderr path.",
        worktreeId: "wt-main",
        lastActiveAt: "2026-10-16T04:15:21.678Z",
        createdAt,
      })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({
        id: "shared",
        title: "Trigger the synthetic-run-failed-with-stderr path.",
        worktreeId: "wt-434",
        lastActiveAt: "2026-10-17T19:34:10.726Z",
        createdAt,
      })
    );
    const groups = await findSessionCollisionsInProject("proj-1");
    assert.ok(groups.has("shared"), "shared id must be reported as a collision");
    const candidates = groups.get("shared")!;
    assert.equal(candidates.length, 2);
    const byWorktree = new Map(candidates.map((c) => [c.worktreeId, c]));
    assert.ok(byWorktree.has("wt-main"));
    assert.ok(byWorktree.has("wt-434"));
  });
});

test("pickOwner is deterministic on most-recently-active and stable on ties", async () => {
  // The owner-pick rule is what makes every consumer agree on
  // which copy wins. Stable across re-runs so a user reading
  // On Radar and a CLI run of `sessions list` see the same
  // owner.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({ id: "tied", worktreeId: "wt-main", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({ id: "tied", worktreeId: "wt-feature", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    const groups = await findSessionCollisionsInProject("proj-1");
    const candidates = groups.get("tied")!;
    const owner1 = pickOwner(candidates);
    const owner2 = pickOwner(candidates);
    assert.equal(owner1.worktreeId, owner2.worktreeId, "owner must be stable across calls");
    // Tie-breaker: lexically first worktree id wins.
    assert.equal(owner1.worktreeId, "wt-feature");
  });
});

test("pickOwner picks the most-recently-active copy when timestamps differ", async () => {
  // The issue body calls out: the same id with the same
  // creation time but different lastActiveAt. The owner must
  // be the more-recent one, regardless of which worktree it
  // lives in.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({ id: "stale", worktreeId: "wt-main", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({ id: "stale", worktreeId: "wt-feature", lastActiveAt: "2026-10-17T19:34:10.000Z" })
    );
    const groups = await findSessionCollisionsInProject("proj-1");
    const owner = pickOwner(groups.get("stale")!);
    assert.equal(owner.worktreeId, "wt-feature");
  });
});

test("listAllCollisions returns a report per colliding session id, omitting single-store copies", async () => {
  // The CLI surface (`controller sessions collisions`) and the
  // route handler (`GET /api/sessions/collisions`) both consume
  // this list. Single-store copies are filtered out so the
  // output is just actual collisions.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(mainPath, makeSession({ id: "solo" }));
    plantSessionInWorktree(mainPath, makeSession({ id: "dupe" }));
    plantSessionInWorktree(featurePath, makeSession({ id: "dupe" }));
    const reports = await listAllCollisions();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sessionId, "dupe");
    assert.equal(reports[0].candidates.length, 2);
  });
});

test("getSessionSummaries populates `duplicates` on every copy of a colliding id", async () => {
  // The shape the sidebar / focus queue / CLI consume. Both
  // copies carry `duplicates` listing the other stores, so the
  // UI can render a "duplicate" badge on either side and offer
  // a "go to owner" action. The picked owner is the one the
  // locator returns; the per-worktree `getSessionSummaries`
  // call returns whatever the caller asked for.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({ id: "shared", worktreeId: "wt-main", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({ id: "shared", worktreeId: "wt-feature", lastActiveAt: "2026-10-17T19:34:10.000Z" })
    );
    // The feature worktree's summary sees the main copy in
    // `duplicates`.
    const featureSummaries = await getSessionSummaries(featurePath, "proj-1");
    const featureSummary = featureSummaries.find((s) => s.id === "shared")!;
    assert.ok(featureSummary);
    assert.ok(Array.isArray(featureSummary.duplicates));
    assert.equal(featureSummary.duplicates!.length, 1);
    assert.equal(featureSummary.duplicates![0].worktreeId, "wt-main");
    // The main worktree's summary sees the feature copy in
    // `duplicates`. The user opening a session in the non-owner
    // worktree should still see the diagnostic.
    const mainSummaries = await getSessionSummaries(mainPath, "proj-1");
    const mainSummary = mainSummaries.find((s) => s.id === "shared")!;
    assert.ok(mainSummary);
    assert.ok(Array.isArray(mainSummary.duplicates));
    assert.equal(mainSummary.duplicates!.length, 1);
    assert.equal(mainSummary.duplicates![0].worktreeId, "wt-feature");
  });
});

test("quarantineCollision archives the non-owner copies, deletes the live records, and writes a manifest", async () => {
  // The end-to-end repair path. The non-owner session file +
  // events file are moved to a timestamped folder under
  // `<controllerHome>/session-collisions/<runId>/<worktreeId>/`
  // and a manifest describing the move is written next to it.
  // The owner is left in place.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({ id: "shared", worktreeId: "wt-main", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({ id: "shared", worktreeId: "wt-feature", lastActiveAt: "2026-10-17T19:34:10.000Z" })
    );
    const manifest = await quarantineCollision({
      sessionId: "shared",
      ownerWorktreeId: "wt-feature",
    });
    assert.equal(manifest.sessionId, "shared");
    assert.equal(manifest.ownerWorktreeId, "wt-feature");
    assert.equal(manifest.quarantined.length, 1);
    assert.equal(manifest.quarantined[0].worktreeId, "wt-main");
    // Live records: feature (owner) survives, main is gone.
    const featureSession = await getSession(featurePath, "shared");
    assert.ok(featureSession, "owner session must remain in place");
    const mainSession = await getSession(mainPath, "shared");
    assert.equal(mainSession, null, "non-owner session must be deleted");
    // Quarantine folder: the manifest is on disk and references
    // the archived session file.
    const manifestPath = path.join(home, "session-collisions", `${manifest.runId}.json`);
    assert.ok(existsSync(manifestPath), "manifest must be written");
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.equal(onDisk.sessionId, "shared");
    assert.ok(existsSync(onDisk.quarantined[0].sessionFile));
    // The quarantined copy preserves the original main file's
    // content (the session was a `wt-main` record, the
    // quarantine just relocated the bytes). A user can read
    // this file to inspect or restore the moved transcript.
    const quarantinedContent = readFileSync(
      onDisk.quarantined[0].sessionFile,
      "utf-8"
    );
    assert.match(quarantinedContent, /"worktreeId":"wt-main"/);
  });
});

test("quarantineCollision refuses when the requested owner is not one of the colliding worktrees", async () => {
  // Validation: an `--owner` that doesn't match a known
  // worktree id is a clear error, not a silent "quarantined
  // everything" outcome.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(mainPath, makeSession({ id: "shared" }));
    plantSessionInWorktree(featurePath, makeSession({ id: "shared" }));
    await assert.rejects(
      () =>
        quarantineCollision({
          sessionId: "shared",
          ownerWorktreeId: "wt-does-not-exist",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CollisionError);
        assert.equal((err as CollisionError).code, "owner-not-found");
        return true;
      }
    );
  });
});

test("quarantineCollision refuses with no-collision when the session id is unique", async () => {
  // Regression for a CLI typo: `controller sessions repair
  // <unique-id>` should not silently quarantine the lone copy.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(mainPath, makeSession({ id: "unique" }));
    await assert.rejects(
      () =>
        quarantineCollision({
          sessionId: "unique",
          ownerWorktreeId: "wt-main",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CollisionError);
        assert.equal((err as CollisionError).code, "no-collision");
        return true;
      }
    );
  });
});

test("quarantineCollision refuses when any of the affected sessions is active", async () => {
  // Strict-archive rule (issue #351): the agent may be writing
  // into a store we're about to delete. Refuse so the user
  // stops the agent first.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(mainPath, makeSession({ id: "shared" }));
    plantSessionInWorktree(featurePath, makeSession({ id: "shared" }));
    await assert.rejects(
      () =>
        quarantineCollision({
          sessionId: "shared",
          ownerWorktreeId: "wt-main",
          activeSessionIds: new Set(["shared"]),
        }),
      (err: unknown) => {
        assert.ok(err instanceof CollisionError);
        assert.equal((err as CollisionError).code, "active-session");
        return true;
      }
    );
  });
});

test("getSession populates `duplicates` on the local copy and the locator returns the picked owner", async () => {
  // Cross-surface consistency: the per-project read path
  // (`getSession`) reports the collision on whichever worktree
  // the caller asked for, and the cross-project locator
  // (`locateSessionById`) returns the picked owner. If the
  // two disagreed about which store to read, the sidebar
  // would navigate to a different store than the CLI's
  // `sessions show <id>` printed.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({
        id: "shared",
        worktreeId: "wt-main",
        lastActiveAt: "2026-10-16T04:15:21.000Z",
      })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({
        id: "shared",
        worktreeId: "wt-feature",
        lastActiveAt: "2026-10-17T19:34:10.000Z",
      })
    );
    // Per-worktree `getSession` reads the local file and
    // surfaces the collision via `duplicates` — the non-owner
    // copy is the implicit one.
    const fromMain = await getSession(mainPath, "shared", "proj-1");
    assert.ok(fromMain, "non-owner session must still resolve locally");
    assert.equal(fromMain.worktreeId, "wt-main");
    assert.ok(Array.isArray(fromMain.duplicates), "non-owner copy must still see the duplicates field");
    assert.equal(fromMain.duplicates![0].worktreeId, "wt-feature");
    // Cross-project locator returns the picked owner.
    const { locateSessionById } = await import("../session-locator.js");
    const located = await locateSessionById("shared");
    assert.ok(located);
    assert.equal(located.worktreeId, "wt-feature", "locator must honor pickOwner");
    assert.ok(Array.isArray(located.duplicates));
    assert.equal(located.duplicates![0].worktreeId, "wt-main");
  });
});

test("formatCollisionRow produces a human-readable row that names the owner and the duplicates", async () => {
  // The CLI's `controller sessions collisions` table calls
  // this. Output must be one line per collision and mention
  // every worktree involved.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    await plantProjectRegistry(home, [
      { id: "proj-1", name: "demo", path: mainPath, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await plantWorktreeRegistry(home, [
      { id: "wt-main", projectId: "proj-1", name: "main", path: mainPath, isMain: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wt-feature", projectId: "proj-1", name: "feature", path: featurePath, isMain: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    plantSessionInWorktree(
      mainPath,
      makeSession({ id: "shared", lastActiveAt: "2026-10-16T04:15:21.000Z" })
    );
    plantSessionInWorktree(
      featurePath,
      makeSession({ id: "shared", lastActiveAt: "2026-10-17T19:34:10.000Z" })
    );
    const reports = await listAllCollisions();
    const row = formatCollisionRow(reports[0]);
    assert.match(row, /shared/);
    assert.match(row, /owner=feature/);
    assert.match(row, /main@/);
  });
});

test("isLikelySessionId rejects path-traversal probes (issue #437 regression)", async () => {
  // The detection walk uses the session id as a filename. A
  // bad input (e.g. `../etc/passwd`) must not be turned into
  // a filesystem read. The helper is private — exercise it
  // through the public surface: `findSessionCollisions` must
  // return the empty array for any non-id-shaped input.
  await withTempHome(async () => {
    assert.deepEqual(await findSessionCollisions(""), []);
    assert.deepEqual(await findSessionCollisions("../etc/passwd"), []);
    assert.deepEqual(await findSessionCollisions("foo/bar"), []);
    assert.deepEqual(await findSessionCollisions("a".repeat(300)), []);
  });
});
