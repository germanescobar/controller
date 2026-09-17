import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #351: strict-archive rule. Archiving a session with any
 * active concern (live agent, queued messages, active monitors,
 * live children) must return 409 with a structured `blockers`
 * array so the UI can render a specific tooltip on the Archive
 * button. The "happy path" — no blockers — must still archive
 * cleanly (200 + on-disk state changed).
 *
 * These tests mount the real `sessionsRouter` against a temp
 * `CONTROLLER_HOME`, seed one or two sessions, and exercise each
 * blocker source independently. The route layer is exercised end
 * to end (no route-mocking); the helpers (`getSessionRuntime`,
 * `listMonitors`, `listQueue`, `listChildSessions`) are wired up
 * via the same dynamic imports the route uses.
 */

interface StrictEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
}

async function withStrictRoutes<T>(fn: (env: StrictEnv) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-strict-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "proj-1";
  const worktreeId = "wt-main";
  const worktreePath = path.join(homeDir, "source", "main");
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: worktreePath,
        worktrees: [{ id: worktreeId, path: worktreePath, branch: "main" }],
      },
    ])
  );
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: worktreeId,
        projectId,
        name: "main",
        path: worktreePath,
        branch: "main",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  const sessionId = "sess-target";
  await seedSession(worktreePath, projectId, worktreeId, sessionId, "Target");

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not bind test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl, projectId, worktreeId, sessionId });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Reset in-process runtime + monitor maps so a follow-up
    // test sees a clean slate.
    const { stopAllMonitors, __resetMonitorsForTests } = await import(
      "../../lib/monitors.js"
    );
    stopAllMonitors();
    __resetMonitorsForTests();
    const runtime = await import("../../lib/session-runtime.js");
    // Best-effort reset: `markSessionInactive` flips the in-process
    // runtime map to inactive if it's set. If the test never marked
    // the session active, the function is a no-op.
    runtime.markSessionInactive(sessionId);
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function seedSession(
  worktreePath: string,
  projectId: string,
  worktreeId: string,
  sessionId: string,
  title: string
): Promise<void> {
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(worktreePath);
  const sessionsDir = path.join(storeDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(
      {
        id: sessionId,
        title,
        workingDirectory: worktreePath,
        worktreeId,
        projectId,
        provider: "claude",
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      },
      null,
      2
    )
  );
}

test("archive succeeds when there are no blockers (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
      { method: "POST" }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("archive returns 409 with a live-agent blocker (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    // Mark the session as having a live agent via the runtime map.
    const runtime = await import("../../../server/lib/session-runtime.js");
    runtime.markSessionActive(sessionId);
    try {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        ok: boolean;
        error: string;
        blockers: Array<{ kind: string; message?: string }>;
      };
      assert.equal(body.ok, false);
      assert.equal(body.blockers.length, 1);
      assert.equal(body.blockers[0].kind, "live-agent");
      assert.match(body.error, /live agent/);
    } finally {
      runtime.markSessionInactive(sessionId);
    }
  });
});

test("archive returns 409 with a queued-messages blocker (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const queue = await import("../../../server/lib/session-queue.js");
    await queue.enqueue(sessionId, {
      text: "queued follow-up",
      visibleText: "queued follow-up",
      provider: "claude",
      model: "claude-opus-4",
      attachmentIds: [],
      mode: "default",
    });
    await queue.enqueue(sessionId, {
      text: "another queued",
      visibleText: "another queued",
      provider: "claude",
      model: "claude-opus-4",
      attachmentIds: [],
      mode: "default",
    });
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
      { method: "POST" }
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      ok: boolean;
      error: string;
      blockers: Array<{ kind: string; count?: number }>;
    };
    assert.equal(body.ok, false);
    const queued = body.blockers.find((b) => b.kind === "queued-messages");
    assert.ok(queued, "expected a queued-messages blocker");
    assert.equal((queued as { count: number }).count, 2);
    assert.match(body.error, /2 queued messages/);
  });
});

test("archive returns 409 with an active-monitors blocker (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const monitors = await import("../../../server/lib/monitors.js");
    // Seed a synthetic monitor entry directly into the in-process
    // map. We deliberately avoid `startMonitor` here because that
    // spawns a live child process — the test runner's SIGTERM race
    // with a `sleep 30` subprocess has historically torn down the
    // parent process. `__seedMonitorForTests` is the test-only
    // seam that satisfies `listMonitors` without spawning.
    monitors.__seedMonitorForTests({
      id: "monitor-seeded",
      sessionId,
      worktreePath: path.join(process.env.CONTROLLER_HOME!, "source", "main"),
      description: "CI watcher",
      command: "echo seeded",
      persistent: true,
      deadlineAt: null,
      startedAt: new Date().toISOString(),
      lineCount: 0,
      onLinePattern: null,
    });
    try {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        blockers: Array<{
          kind: string;
          count?: number;
          descriptions?: string[];
        }>;
      };
      const blocker = body.blockers.find((b) => b.kind === "active-monitors");
      assert.ok(blocker, "expected an active-monitors blocker");
      assert.equal((blocker as { count: number }).count, 1);
      assert.deepEqual((blocker as { descriptions: string[] }).descriptions, [
        "CI watcher",
      ]);
    } finally {
      monitors.__resetMonitorsForTests();
    }
  });
});

test("archive returns 409 with a live-children blocker (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    // Seed a child session whose `parentId` points at the target.
    const home = process.env.CONTROLLER_HOME!;
    const worktreePath = path.join(home, "source", "main");
    const { projectStoreDir } = await import("../../../server/lib/paths.js");
    const sessionsDir = path.join(projectStoreDir(worktreePath), "sessions");
    await fs.writeFile(
      path.join(sessionsDir, "sess-child.json"),
      JSON.stringify(
        {
          id: "sess-child",
          title: "Plan the rollout",
          workingDirectory: worktreePath,
          worktreeId,
          projectId,
          provider: "claude",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: "active",
          parentId: sessionId,
        },
        null,
        2
      )
    );
    const runtime = await import("../../../server/lib/session-runtime.js");
    runtime.markSessionActive("sess-child");
    try {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        blockers: Array<{ kind: string; count?: number; childIds?: string[] }>;
      };
      const blocker = body.blockers.find((b) => b.kind === "live-children");
      assert.ok(blocker, "expected a live-children blocker");
      assert.equal((blocker as { count: number }).count, 1);
      assert.deepEqual((blocker as { childIds: string[] }).childIds, ["sess-child"]);
    } finally {
      runtime.markSessionInactive("sess-child");
    }

    // Once the child has no unfinished work it may survive as an orphan;
    // merely having a persisted, non-archived child is not a blocker.
    const allowed = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
      { method: "POST" }
    );
    assert.equal(allowed.status, 200);
  });
});

test("archive recursively blocks when a descendant has unfinished work", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const home = process.env.CONTROLLER_HOME!;
    const worktreePath = path.join(home, "source", "main");
    const { projectStoreDir } = await import("../../../server/lib/paths.js");
    const sessionsDir = path.join(projectStoreDir(worktreePath), "sessions");
    const now = new Date().toISOString();
    for (const child of [
      { id: "sess-child", parentId: sessionId },
      { id: "sess-grandchild", parentId: "sess-child" },
    ]) {
      await fs.writeFile(
        path.join(sessionsDir, `${child.id}.json`),
        JSON.stringify({
          id: child.id,
          title: child.id,
          workingDirectory: worktreePath,
          worktreeId,
          projectId,
          provider: "claude",
          model: "claude-opus-4",
          createdAt: now,
          lastActiveAt: now,
          status: "active",
          parentId: child.parentId,
        })
      );
    }
    const runtime = await import("../../../server/lib/session-runtime.js");
    runtime.markSessionActive("sess-grandchild");
    try {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        blockers: Array<{ kind: string; childIds?: string[] }>;
      };
      const blocker = body.blockers.find((item) => item.kind === "live-children");
      assert.deepEqual(blocker?.childIds, ["sess-child"]);
    } finally {
      runtime.markSessionInactive("sess-grandchild");
    }
  });
});

test("archive reports every blocker when multiple are present (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const runtime = await import("../../../server/lib/session-runtime.js");
    const monitors = await import("../../../server/lib/monitors.js");
    const queue = await import("../../../server/lib/session-queue.js");
    runtime.markSessionActive(sessionId);
    await queue.enqueue(sessionId, {
      text: "queued",
      visibleText: "queued",
      provider: "claude",
      model: "claude-opus-4",
      attachmentIds: [],
      mode: "default",
    });
    monitors.__seedMonitorForTests({
      id: "monitor-multi-blocker",
      sessionId,
      worktreePath: path.join(process.env.CONTROLLER_HOME!, "source", "main"),
      description: "watcher",
      command: "echo seeded",
      persistent: true,
      deadlineAt: null,
      startedAt: new Date().toISOString(),
      lineCount: 0,
      onLinePattern: null,
    });
    try {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        blockers: Array<{ kind: string }>;
        error: string;
      };
      const kinds = body.blockers.map((b) => b.kind).sort();
      assert.deepEqual(kinds, [
        "active-monitors",
        "live-agent",
        "queued-messages",
      ]);
      // The error message surfaces a single human-readable summary;
      // the structured `blockers` array is what the UI iterates.
      assert.match(body.error, /live agent/);
      assert.match(body.error, /1 queued message/);
      assert.match(body.error, /1 active monitor/);
    } finally {
      runtime.markSessionInactive(sessionId);
      monitors.__resetMonitorsForTests();
    }
  });
});

test("after all blockers clear the archive succeeds (issue #351)", async () => {
  await withStrictRoutes(async ({ baseUrl, projectId, worktreeId, sessionId }) => {
    const queue = await import("../../../server/lib/session-queue.js");
    const runtime = await import("../../../server/lib/session-runtime.js");
    // Add a queued message, attempt archive (expect 409), clear it,
    // retry (expect 200). This is the canonical "user drains the
    // queue and retries" flow.
    const queued = await queue.enqueue(sessionId, {
      text: "first",
      visibleText: "first",
      provider: "claude",
      model: "claude-opus-4",
      attachmentIds: [],
      mode: "default",
    });
    runtime.markSessionActive(sessionId);
    try {
      const blocked = await fetch(
        `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
        { method: "POST" }
      );
      assert.equal(blocked.status, 409);
    } finally {
      runtime.markSessionInactive(sessionId);
    }
    // Drain the queue and try again.
    await queue.removeFromQueue(sessionId, queued.id);
    const ok = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${sessionId}/archive`,
      { method: "POST" }
    );
    assert.equal(ok.status, 200);
  });
});
