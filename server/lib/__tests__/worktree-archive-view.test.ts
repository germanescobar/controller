import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the dedicated worktree archive view: the soft-restore
 * endpoint, the hard-delete ("purge") endpoint, and the
 * `?includeRemoved=1` filter on `GET /worktrees`. The endpoints
 * live in `server/routes/worktrees.ts`; the underlying registry
 * helpers (`restoreWorktree`, `purgeWorktree`) live in
 * `server/lib/worktrees.ts`.
 *
 * The goal is to lock in the UX contract from the archive view:
 *   • default `GET /worktrees` does NOT list removed rows;
 *   • `GET /worktrees?includeRemoved=1` DOES, and the rows
 *     preserve the same shape the rest of the API already uses;
 *   • `POST /restore` flips a removed row back to active and
 *     rejects non-removed rows with 409;
 *   • `DELETE /purge` only works on removed rows, refuses the
 *     main worktree, and tears down the per-worktree store
 *     directory so a "delete forever" really does delete forever.
 */

interface Env {
  homeDir: string;
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  projectPath: string;
  worktreePath: string;
  secondWorktreeId: string;
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`))
    );
    child.on("error", reject);
  });
}

async function buildRepo(projectPath: string): Promise<void> {
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await runGit(projectPath, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);
}

async function withArchiveEnv<T>(
  fn: (ctx: Env) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-archive-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const worktreeId = "wt-1";
  const secondWorktreeId = "wt-2";
  const projectPath = path.join(homeDir, "source");
  const worktreePath = path.join(projectPath, "wt", "issue-1");
  const secondWorktreePath = path.join(projectPath, "wt", "issue-2");
  await fs.mkdir(projectPath, { recursive: true });
  await buildRepo(projectPath);
  await runGit(projectPath, ["worktree", "add", "-b", "issue-1", worktreePath]);
  await runGit(projectPath, ["worktree", "add", "-b", "issue-2", secondWorktreePath]);

  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
  );
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: "wt-main",
        projectId,
        name: "main",
        path: projectPath,
        branch: "main",
        isMain: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: worktreeId,
        projectId,
        name: "issue-1",
        path: worktreePath,
        branch: "issue-1",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: secondWorktreeId,
        projectId,
        name: "issue-2",
        path: secondWorktreePath,
        branch: "issue-2",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
  );
  // Drop the registry cache so the seeded worktrees.json is re-read
  // fresh — without this, the in-process snapshot from earlier
  // tests in the same run would shadow the fixture.
  const { invalidateWorktreeCache } = await import("../worktrees.js");
  invalidateWorktreeCache();

  // Seed a session file for the first worktree so the purge can
  // exercise its disk-cleanup path. A real session would carry a
  // runtime record; we don't need one for the cleanup test.
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(worktreePath);
  const sessionsDir = path.join(storeDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "seeded.json"),
    JSON.stringify({
      id: "seeded",
      title: "seeded",
      worktreeId,
      workingDirectory: worktreePath,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      messages: [],
    })
  );

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  // Match the production server in `server/index.ts` so JSON bodies
  // are available on the create route.
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/projects/${projectId}`;

  try {
    return await fn({
      homeDir,
      baseUrl,
      projectId,
      worktreeId,
      projectPath,
      worktreePath,
      secondWorktreeId,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
  }
}

test("GET /worktrees default response hides removed rows", async () => {
  await withArchiveEnv(async ({ baseUrl, worktreeId }) => {
    // Archive wt-1 directly via the helper to put it in the
    // `removed` state without going through the full DELETE
    // pipeline (which would also remove the on-disk checkout).
    const { removeWorktree, invalidateWorktreeCache } = await import(
      "../worktrees.js"
    );
    invalidateWorktreeCache();
    const removed = await removeWorktree(worktreeId);
    assert.equal(removed, true);

    const res = await fetch(`${baseUrl}/worktrees`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ id: string; presence?: string }>;
    const ids = rows.map((row) => row.id).sort();
    // main + wt-2 — the archived row is hidden.
    assert.deepEqual(ids, ["wt-2", "wt-main"]);
    // Removed rows are filtered out — not just rendered with a
    // presence field — so a stale UI never has to second-guess.
    assert.equal(
      rows.find((row) => row.id === worktreeId),
      undefined
    );
  });
});

test("GET /worktrees?includeRemoved=1 returns removed rows in the same shape", async () => {
  await withArchiveEnv(async ({ baseUrl, worktreeId }) => {
    const { removeWorktree, invalidateWorktreeCache } = await import(
      "../worktrees.js"
    );
    invalidateWorktreeCache();
    await removeWorktree(worktreeId);

    const res = await fetch(`${baseUrl}/worktrees?includeRemoved=1`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ id: string; presence?: string; branch?: string }>;
    const removed = rows.find((row) => row.id === worktreeId);
    assert.ok(removed, "removed worktree should be in the response");
    assert.equal(removed.presence, "removed");
    // The same field shape the rest of the API uses so the
    // archive view can map rows 1:1 to the Worktree type.
    assert.equal(removed.branch, "issue-1");
  });
});

test("POST /restore flips a removed row back to active and rejects already-active rows", async () => {
  await withArchiveEnv(async ({ baseUrl, worktreeId, secondWorktreeId }) => {
    const { removeWorktree, invalidateWorktreeCache } = await import(
      "../worktrees.js"
    );
    invalidateWorktreeCache();
    await removeWorktree(worktreeId);

    const restore = await fetch(`${baseUrl}/worktrees/${worktreeId}/restore`, {
      method: "POST",
    });
    assert.equal(restore.status, 200);
    const restored = (await restore.json()) as { worktree: { id: string; presence?: string } };
    assert.equal(restored.worktree.id, worktreeId);
    assert.equal(restored.worktree.presence, "active");

    // The default response should now include the row again.
    const list = await fetch(`${baseUrl}/worktrees`);
    const rows = (await list.json()) as Array<{ id: string; presence?: string }>;
    const found = rows.find((row) => row.id === worktreeId);
    assert.ok(found, "restored worktree should reappear in the default response");
    assert.equal(found.presence, "active");

    // A second restore against an already-active row is a 409.
    const repeat = await fetch(`${baseUrl}/worktrees/${worktreeId}/restore`, {
      method: "POST",
    });
    assert.equal(repeat.status, 409);
    const body = (await repeat.json()) as { error: string };
    assert.match(body.error, /not archived/);

    // 404 for an unknown worktree id.
    const missing = await fetch(`${baseUrl}/worktrees/wt-unknown/restore`, {
      method: "POST",
    });
    assert.equal(missing.status, 404);
    void secondWorktreeId;
  });
});

test("DELETE /purge refuses non-archived, main, and unknown rows", async () => {
  await withArchiveEnv(async ({ baseUrl, secondWorktreeId, projectId }) => {
    // Active worktree → 409.
    const active = await fetch(`${baseUrl}/worktrees/${secondWorktreeId}/purge`, {
      method: "DELETE",
    });
    assert.equal(active.status, 409);
    const activeBody = (await active.json()) as { error: string };
    assert.match(activeBody.error, /not archived/);

    // Main worktree → 400 even if hypothetically archived.
    const { getProjectWorktrees, updateWorktree, invalidateWorktreeCache } =
      await import("../worktrees.js");
    invalidateWorktreeCache();
    const main = (await getProjectWorktrees(projectId, { includeRemoved: true })).find(
      (w) => w.isMain
    );
    assert.ok(main);
    await updateWorktree(main.id, { presence: "removed" });
    const mainPurge = await fetch(`${baseUrl}/worktrees/${main.id}/purge`, {
      method: "DELETE",
    });
    assert.equal(mainPurge.status, 400);

    // Unknown id → 404.
    const missing = await fetch(`${baseUrl}/worktrees/wt-unknown/purge`, {
      method: "DELETE",
    });
    assert.equal(missing.status, 404);
  });
});

test("DELETE /purge tears down the per-worktree store and removes the registry row", async () => {
  await withArchiveEnv(async ({ baseUrl, worktreeId, worktreePath }) => {
    const { removeWorktree, getProjectWorktrees, invalidateWorktreeCache } =
      await import("../worktrees.js");
    invalidateWorktreeCache();
    await removeWorktree(worktreeId);

    // Sanity check: the seeded session file is on disk before the
    // purge so the assertion below proves the cleanup actually
    // happened.
    const { projectStoreDir } = await import("../paths.js");
    const storeDir = projectStoreDir(worktreePath);
    await assert.doesNotReject(fs.access(path.join(storeDir, "sessions", "seeded.json")));

    const purge = await fetch(`${baseUrl}/worktrees/${worktreeId}/purge`, {
      method: "DELETE",
    });
    assert.equal(purge.status, 200);

    // The registry row is gone — both the default and the
    // includeRemoved response no longer mention it.
    invalidateWorktreeCache();
    const defaultRows = await getProjectWorktrees("proj-1");
    const allRows = await getProjectWorktrees("proj-1", { includeRemoved: true });
    assert.equal(
      defaultRows.find((row) => row.id === worktreeId),
      undefined
    );
    assert.equal(
      allRows.find((row) => row.id === worktreeId),
      undefined
    );

    // The per-worktree store directory was wiped.
    await assert.rejects(
      fs.access(storeDir),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
        return true;
      }
    );

    // A second purge is a 404 (already gone). Treated as success
    // by the client wrapper; here we just assert the server
    // response is the documented 404.
    const repeat = await fetch(`${baseUrl}/worktrees/${worktreeId}/purge`, {
      method: "DELETE",
    });
    assert.equal(repeat.status, 404);
  });
});

test("the create endpoint still refuses to reuse a name while the row is archived", async () => {
  // Regression guard: the worktree-create collision check must
  // continue to see removed rows even though the default
  // `getProjectWorktrees` response hides them. Otherwise
  // re-creating an archived worktree would silently merge its
  // session history into the new checkout.
  await withArchiveEnv(async ({ baseUrl, worktreeId }) => {
    const { removeWorktree, invalidateWorktreeCache } = await import(
      "../worktrees.js"
    );
    invalidateWorktreeCache();
    await removeWorktree(worktreeId);

    const reuse = await fetch(`${baseUrl}/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "issue-1" }),
    });
    assert.equal(reuse.status, 409);
    const body = (await reuse.json()) as { error: string };
    assert.match(body.error, /removed worktree/);
  });
});
