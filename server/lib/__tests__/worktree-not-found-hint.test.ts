/*
 * Issue #367: a 404 from a `worktreeId` route has to say *why* the lookup
 * failed. The motivating bug was an agent handed a project UUID from a UI
 * surface, passing it as `--worktree`, and getting a bare
 * `{ "error": "Worktree not found" }` back with nothing to act on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface Harness {
  baseUrl: string;
  projectId: string;
  otherProjectId: string;
  mainWorktreeId: string;
  close: () => Promise<void>;
}

async function startHarness(label: string): Promise<Harness> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const projectPath = path.join(homeDir, "source");
  const otherProjectPath = path.join(homeDir, "other-source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(otherProjectPath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
      {
        id: otherProjectId,
        name: "other",
        path: otherProjectPath,
        createdAt: new Date().toISOString(),
      },
    ]),
  );

  const { getProjectWorktrees } = await import("../worktrees.js");
  const [main] = await getProjectWorktrees(projectId);
  assert.ok(main);

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    projectId,
    otherProjectId,
    mainWorktreeId: main.id,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
      else process.env.CONTROLLER_HOME = previousHome;
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
}

test("a project id in ?worktreeId 404s with a 'did you mean' hint", async () => {
  const h = await startHarness("worktree-404-project-id");
  try {
    // The exact shape from the real session: the caller passed the id of
    // a project (here, a *different* project than the route's) where a
    // worktree id belonged.
    const response = await fetch(
      `${h.baseUrl}/api/projects/${h.projectId}/sessions?worktreeId=${h.otherProjectId}`,
    );
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Worktree not found");
    assert.equal(body.projectId, h.projectId);
    assert.equal(body.suppliedId, h.otherProjectId);
    assert.equal(body.suppliedIdIsProjectId, true);
    assert.deepEqual(body.knownWorktreeIds, [h.mainWorktreeId]);
    assert.equal(
      body.hint,
      `${h.otherProjectId} is a project id, not a worktree id. Use 'controller worktrees list ${h.otherProjectId}' to discover worktree ids.`,
    );
  } finally {
    await h.close();
  }
});

test("the route's own project id is recognized as a project id too", async () => {
  const h = await startHarness("worktree-404-same-project-id");
  try {
    const response = await fetch(
      `${h.baseUrl}/api/projects/${h.projectId}/sessions?worktreeId=${h.projectId}`,
    );
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.suppliedIdIsProjectId, true);
    assert.match(body.hint, /is a project id, not a worktree id/);
  } finally {
    await h.close();
  }
});

test("an unknown id 404s with the tighter 'no such worktree' hint", async () => {
  const h = await startHarness("worktree-404-unknown-id");
  try {
    const unknown = randomUUID();
    const response = await fetch(
      `${h.baseUrl}/api/projects/${h.projectId}/sessions?worktreeId=${unknown}`,
    );
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Worktree not found");
    assert.equal(body.projectId, h.projectId);
    assert.equal(body.suppliedId, unknown);
    assert.equal(body.suppliedIdIsProjectId, false);
    assert.deepEqual(body.knownWorktreeIds, [h.mainWorktreeId]);
    assert.equal(
      body.hint,
      `No worktree ${unknown} in project ${h.projectId}. Use 'controller worktrees list ${h.projectId}' to discover worktree ids.`,
    );
  } finally {
    await h.close();
  }
});

test("a valid worktree id still lists sessions (happy path unaffected)", async () => {
  const h = await startHarness("worktree-404-happy-path");
  try {
    const response = await fetch(
      `${h.baseUrl}/api/projects/${h.projectId}/sessions?worktreeId=${h.mainWorktreeId}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await h.close();
  }
});

test("worktreeNotFoundPayload stays at the historical shape with no supplied id", async () => {
  // Omitting `worktreeId` resolves to the main worktree, so this branch is
  // only reachable when the lookup fails for an unrelated reason (unknown
  // project, unreadable registry). There is nothing for the caller to fix
  // about the worktree id it never sent, so no hint is invented.
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-404-bare-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  try {
    const { worktreeNotFoundPayload } = await import("../worktrees.js");
    assert.deepEqual(await worktreeNotFoundPayload("project-gone"), {
      error: "Worktree not found",
      projectId: "project-gone",
    });
  } finally {
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("worktreeNotFoundMessage flattens the payload into one line", async () => {
  const { worktreeNotFoundMessage } = await import("../worktrees.js");
  assert.equal(
    worktreeNotFoundMessage({
      error: "Worktree not found",
      projectId: "p",
      hint: "do the thing.",
    }),
    "Worktree not found. do the thing.",
  );
  assert.equal(
    worktreeNotFoundMessage({ error: "Worktree not found", projectId: "p" }),
    "Worktree not found",
  );
});
