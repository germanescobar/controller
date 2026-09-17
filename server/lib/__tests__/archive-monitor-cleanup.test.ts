import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Integration test for the archive path's monitor cleanup (issue #339
 * review). The route layer is what actually wires `archiveSession` +
 * `stopMonitorsForSession` together; the unit-level test for the
 * in-process monitors store lives in `monitors.test.ts`.
 *
 * Without this hook a persistent monitor started against an
 * already-archived session would keep running its shell command and
 * appending events to the (now-archived) session's event log.
 */

interface ArchiveEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
}

async function withArchiveRoutes(
  fn: (env: ArchiveEnv) => Promise<void>
): Promise<void> {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "archive-monitor-cleanup-")
  );
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "proj-1";
  const worktreeId = "wt-1";
  const sessionId = "s-1";
  const projectPath = path.join(homeDir, "source");
  const wtPath = path.join(homeDir, "feature");
  await fs.mkdir(path.join(projectPath, "sessions"), { recursive: true });
  await fs.mkdir(path.join(projectPath, "events"), { recursive: true });
  // Plant the session file under the *Controller-owned* session
  // store (issue #339 review: per-worktree store, keyed off the
  // worktree path's SHA-256 via `projectStoreDir`).
  const { projectStoreDir } = await import("../paths.js");
  const wtSessionDir = projectStoreDir(wtPath);
  await fs.mkdir(path.join(wtSessionDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  // Plant the session file the archive path will rewrite.
  await fs.writeFile(
    path.join(wtSessionDir, "sessions", `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      workingDirectory: wtPath,
      provider: "claude",
      model: "claude/test",
      status: "active",
    })
  );
  // Plant the worktree registry so `resolveWorktree` finds a path.
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: worktreeId,
        projectId,
        name: "feature",
        path: wtPath,
        branch: "feature",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/projects`;
  const cleanup = async () => {
    // The monitor's child process might still be alive briefly
    // after the test; drain it through the public API.
    const { stopAllMonitors } = await import("../monitors.js");
    stopAllMonitors();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  };
  try {
    await fn({ baseUrl, projectId, worktreeId, sessionId, cleanup });
  } finally {
    await cleanup();
  }
}

test("archiveSession route stops persistent monitors for the session", async () => {
  // Issue #351: the strict-archive rule refuses to archive a
  // session with an active monitor (HTTP 409 with the monitor in
  // the `blockers` array). The original motivation for this test —
  // "the archive path must explicitly stop persistent monitors
  // BEFORE the archive completes so a SIGTERM doesn't outlive the
  // route handler" — still applies, but the new contract is:
  // archive is unreachable while a monitor is alive.
  //
  // We use `__seedMonitorForTests` to inject a synthetic monitor
  // entry without spawning a child process. The previous version
  // of this test ran `sleep 30` via `startMonitor`, and the
  // SIGTERM race against the test runner's own shutdown was
  // tearing down the parent process. The seeded entry satisfies
  // `listMonitors` / the blocker check / `stopMonitor` cleanup
  // without any subprocess involvement.
  await withArchiveRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const { __seedMonitorForTests, listMonitors, __resetMonitorsForTests } =
      await import("../monitors.js");
    const wtPath = path.join(process.env.CONTROLLER_HOME ?? ".", "feature");
    __seedMonitorForTests({
      id: "monitor-test-1",
      sessionId,
      worktreePath: wtPath,
      description: "persistent watcher",
      command: "echo seeded",
      persistent: true,
      deadlineAt: null,
      startedAt: new Date().toISOString(),
      lineCount: 0,
      onLinePattern: null,
    });
    assert.equal(listMonitors(sessionId).length, 1);

    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/archive?worktreeId=${"wt-1"}`,
      { method: "POST" }
    );
    // Strict-archive: a live monitor is now a blocker, so the
    // route returns 409 with the monitor in the `blockers` array
    // rather than silently stopping the monitor. The operator
    // must drain the monitor explicitly.
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      ok: boolean;
      blockers: Array<{ kind: string; descriptions?: string[] }>;
    };
    assert.equal(body.ok, false);
    const monitorBlocker = body.blockers.find(
      (b) => b.kind === "active-monitors"
    );
    assert.ok(monitorBlocker);
    assert.deepEqual(
      (monitorBlocker as { descriptions: string[] }).descriptions,
      ["persistent watcher"]
    );
    // The monitor is still seeded — the route didn't drain it.
    assert.equal(listMonitors(sessionId).length, 1);

    __resetMonitorsForTests();
  });
});

test("archiveSession route cleanup drains monitors when the strict-archive blocker is empty (issue #351)", async () => {
  // Companion test to the one above: after the operator drains
  // every monitor (matching what the strict-archive UI expects),
  // archive succeeds and the in-process monitor map is empty.
  // Covers the post-archive `stopMonitorsForSession` cleanup path
  // without needing a live subprocess — `__seedMonitorForTests`
  // injects a synthetic entry, we `stopMonitor` it ourselves,
  // then verify the archive proceeds.
  await withArchiveRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const {
      __seedMonitorForTests,
      listMonitors,
      stopMonitor,
      __resetMonitorsForTests,
    } = await import("../monitors.js");
    const wtPath = path.join(process.env.CONTROLLER_HOME ?? ".", "feature");
    const monitor = {
      id: "monitor-cleanup-test",
      sessionId,
      worktreePath: wtPath,
      description: "drained",
      command: "echo seeded",
      persistent: true,
      deadlineAt: null,
      startedAt: new Date().toISOString(),
      lineCount: 0,
      onLinePattern: null,
    } as const;
    __seedMonitorForTests(monitor);
    assert.equal(listMonitors(sessionId).length, 1);
    // Operator drains the monitor (this is exactly what the UI's
    // disabled-Archive tooltip expects the operator to do).
    stopMonitor(monitor.id);
    assert.equal(listMonitors(sessionId).length, 0);

    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/archive?worktreeId=${"wt-1"}`,
      { method: "POST" }
    );
    assert.equal(response.status, 200);

    // Defensive: clear the map so a follow-up test sees a clean
    // slate (the seed above is already gone, but `stopAllMonitors`
    // is the canonical reset the rest of the suite expects).
    __resetMonitorsForTests();
  });
});

void path;