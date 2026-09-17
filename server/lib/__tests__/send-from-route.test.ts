import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #351: the cross-session send route
 * `POST /api/sessions/:sessionId/send-from` and the children route
 * `GET /api/sessions/:sessionId/children`.
 *
 * Both routes are mounted under `/api/sessions/:sessionId/...` so the
 * CLI doesn't need a project id — they walk every project × worktree
 * pair (the same `locateSessionById` walk the wake + goal + monitor
 * surfaces use).
 *
 * These tests mount the real `sessionsRouter` exports against a temp
 * `CONTROLLER_HOME`, persist two sessions across separate per-worktree
 * stores, and exercise:
 *
 *   1. `POST /send-from` enqueues a durable follow-up whose text is the
 *      canonical `[/from: <parentTitle>] <message>` marker.
 *   2. `POST /send-from` returns 404 when the target or parent is
 *      unknown (so the CLI's `No matches.` error is correct).
 *   3. `GET /children` walks every project × worktree and returns the
 *      children of a parent — including a child that lives on a
 *      different worktree than the parent. This is the cross-worktree
 *      case the issue calls out specifically.
 */

interface RoutesEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  parentId: string;
  childId: string;
}

async function withRoutes<T>(fn: (env: RoutesEnv) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "send-from-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "proj-1";
  const worktreeId = "wt-main";
  const worktreePath = path.join(homeDir, "source", "main");
  // Child lives on a feature worktree, not the main one — the
  // cross-worktree case the issue wants to exercise.
  const featureWorktreeId = "wt-feature";
  const featureWorktreePath = path.join(homeDir, "source", "feature");
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.mkdir(featureWorktreePath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: worktreePath,
        worktrees: [
          { id: worktreeId, path: worktreePath, branch: "main" },
          {
            id: featureWorktreeId,
            path: featureWorktreePath,
            branch: "feature/issue-351",
          },
        ],
      },
    ])
  );
  // The session-locator walks `worktrees.json` to enumerate per-project
  // worktrees. The `queue-routes.test.ts` only seeds `projects.json`
  // and relies on the lazy main-worktree autovivification in
  // `ensureMainInRegistry`, but that only adds the main row — the
  // feature worktree must be registered explicitly so the child is
  // discoverable. Without this, `locateSessionById(childId)` returns
  // `null` and the send route 404s.
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
      {
        id: featureWorktreeId,
        projectId,
        name: "feature",
        path: featureWorktreePath,
        branch: "feature/issue-351",
        isMain: false,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  const parentId = "sess-parent";
  const childId = "sess-child";
  await seedSession(worktreePath, projectId, worktreeId, {
    id: parentId,
    title: "Coordinator",
    parentId: undefined,
  });
  await seedSession(featureWorktreePath, projectId, featureWorktreeId, {
    id: childId,
    title: "Plan the rollout",
    parentId,
  });

  // Mount the two routers under the same prefix the real app uses.
  const { sendBySessionIdRouter, childrenBySessionIdRouter, monitorBySessionIdRouter } = await import(
    "../../routes/sessions.js"
  );
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sendBySessionIdRouter);
  app.use("/api/sessions", childrenBySessionIdRouter);
  app.use("/api/sessions", monitorBySessionIdRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not bind test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl, projectId, worktreeId, parentId, childId });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function seedSession(
  worktreePath: string,
  projectId: string,
  worktreeId: string,
  session: { id: string; title: string; parentId?: string }
): Promise<void> {
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(worktreePath);
  const sessionsDir = path.join(storeDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionState = {
    id: session.id,
    title: session.title,
    workingDirectory: worktreePath,
    worktreeId,
    projectId,
    provider: "claude",
    createdAt: now,
    lastActiveAt: now,
    status: "active",
    ...(session.parentId ? { parentId: session.parentId } : {}),
  };
  await fs.writeFile(
    path.join(sessionsDir, `${session.id}.json`),
    JSON.stringify(sessionState, null, 2)
  );
}

test("POST /send-from enqueues a [/from: title] follow-up on the target", async () => {
  await withRoutes(async ({ baseUrl, parentId, childId }) => {
    const runtime = await import("../session-runtime.js");
    const queue = await import("../session-queue.js");
    // Keep the target active so the route leaves the queued message for this
    // assertion; production drains it when the active turn finishes.
    runtime.markSessionActive(childId);
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${childId}/send-from`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSessionId: parentId,
          message: "ping the child",
        }),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(typeof body.eventId, "string");
      assert.equal(body.parentSessionId, parentId);
      assert.equal(body.parentTitle, "Coordinator");
      const queued = await queue.listQueue(childId);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].id, body.eventId);
      assert.equal(queued[0].text, "[/from: Coordinator] ping the child");
      assert.equal(queued[0].visibleText, queued[0].text);
      assert.equal(queued[0].provider, "claude");
      assert.deepEqual(queued[0].attachmentIds, []);
    } finally {
      runtime.markSessionInactive(childId);
      await queue.clearQueue(childId);
    }
  });
});

test("POST /send-from returns 400 when the message is empty (issue #351)", async () => {
  await withRoutes(async ({ baseUrl, parentId, childId }) => {
    const response = await fetch(`${baseUrl}/api/sessions/${childId}/send-from`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromSessionId: parentId,
        message: "   ",
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /message is required/);
  });
});

test("monitor --on-line enqueues matching output on the target session", async () => {
  await withRoutes(async ({ baseUrl, childId }) => {
    const runtime = await import("../session-runtime.js");
    const queue = await import("../session-queue.js");
    const monitors = await import("../monitors.js");
    runtime.markSessionActive(childId);
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${childId}/monitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "CI watcher",
          command: "printf 'noise\\n[CI] passed\\n'",
          onLine: "^\\[CI\\] passed$",
          timeoutMs: 2_000,
        }),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as { monitor: { id: string } };
      const deadline = Date.now() + 2_000;
      let queued = await queue.listQueue(childId);
      while (queued.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        queued = await queue.listQueue(childId);
      }
      assert.equal(queued.length, 1);
      assert.equal(queued[0].text, "[/monitor: CI watcher] [CI] passed");
      monitors.stopMonitor(body.monitor.id);
    } finally {
      runtime.markSessionInactive(childId);
      await queue.clearQueue(childId);
      monitors.__resetMonitorsForTests();
    }
  });
});

test("POST /send-from returns 404 when the target session is unknown (issue #351)", async () => {
  await withRoutes(async ({ baseUrl, parentId }) => {
    const response = await fetch(
      `${baseUrl}/api/sessions/sess-unknown/send-from`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSessionId: parentId,
          message: "hello?",
        }),
      }
    );
    assert.equal(response.status, 404);
  });
});

test("POST /send-from returns 404 when the parent session is unknown (issue #351)", async () => {
  await withRoutes(async ({ baseUrl, childId }) => {
    const response = await fetch(`${baseUrl}/api/sessions/${childId}/send-from`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromSessionId: "sess-missing-parent",
        message: "hello?",
      }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /From session/);
  });
});

test("GET /children walks every project × worktree and returns the parent's children (issue #351)", async () => {
  await withRoutes(async ({ baseUrl, parentId, childId }) => {
    const response = await fetch(
      `${baseUrl}/api/sessions/${parentId}/children`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      parent: string;
      children: Array<{
        id: string;
        title: string;
        worktreeId: string;
        parentId?: string;
      }>;
    };
    assert.equal(body.parent, parentId);
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].id, childId);
    // The child lives on the feature worktree, not the parent's
    // worktree — this is the cross-worktree case the issue wants.
    assert.equal(body.children[0].worktreeId, "wt-feature");
    assert.equal(body.children[0].parentId, parentId);
  });
});

test("GET /children returns an empty array when the parent has no children (issue #351)", async () => {
  await withRoutes(async ({ baseUrl, childId }) => {
    const response = await fetch(
      `${baseUrl}/api/sessions/${childId}/children`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      children: unknown[];
    };
    assert.deepEqual(body.children, []);
  });
});

test("GET /children returns 404 for an unknown parent (issue #351)", async () => {
  await withRoutes(async ({ baseUrl }) => {
    const response = await fetch(
      `${baseUrl}/api/sessions/sess-not-found/children`
    );
    assert.equal(response.status, 404);
  });
});
