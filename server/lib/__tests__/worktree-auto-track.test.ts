import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { addWorktree, getProjectWorktrees, reconcileGitWorktrees } from "../worktrees.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function withRepo(fn: (root: string, source: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "controller-track-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = root;
  const source = path.join(root, "source repo");
  try {
    await fs.mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "commit.gpgsign", "false");
    await fs.writeFile(path.join(source, "README.md"), "initial\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "initial");
    await fs.writeFile(path.join(root, "projects.json"), JSON.stringify([{
      id: "project", name: "Test", path: source, createdAt: new Date().toISOString(),
    }]));
    await fn(root, source);
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("reconciliation tracks existing worktrees, detached HEAD, branch changes, and missing entries", async () => {
  await withRepo(async (root, source) => {
    const spaced = path.join(root, "feature with spaces");
    const detached = path.join(root, "detached checkout");
    await git(source, "worktree", "add", "-b", "feature", spaced);
    await git(source, "worktree", "add", "--detach", detached);
    const spacedReal = await fs.realpath(spaced);
    const detachedReal = await fs.realpath(detached);
    await fs.writeFile(path.join(spaced, "draft.txt"), "keep me");
    const project = { id: "project", name: "Test", path: source, createdAt: "2026-01-01" };

    const [first, second] = await Promise.all([
      reconcileGitWorktrees(project), reconcileGitWorktrees(project),
    ]);
    assert.equal(first.length + second.length, 2);
    const initial = await getProjectWorktrees(project.id);
    const feature = initial.find((item) => item.path === spacedReal)!;
    const headless = initial.find((item) => item.path === detachedReal)!;
    assert.equal(feature.origin, "external");
    assert.equal(feature.branch, "feature");
    assert.equal(headless.branch, undefined);
    assert.deepEqual([feature.portOffset, headless.portOffset].sort(), [3, 6]);
    const created = await addWorktree({ projectId: project.id, name: "owned", path: path.join(root, "owned"), isMain: false });
    assert.equal(created.portOffset, 9);
    assert.equal(await fs.readFile(path.join(spaced, "draft.txt"), "utf8"), "keep me");

    await git(spaced, "branch", "-m", "renamed");
    await reconcileGitWorktrees(project);
    const renamed = (await getProjectWorktrees(project.id)).find((item) => item.id === feature.id)!;
    assert.equal(renamed.branch, "renamed");
    assert.equal(renamed.portOffset, feature.portOffset);

    await fs.rename(spaced, `${spaced}-away`);
    await reconcileGitWorktrees(project);
    assert.equal((await getProjectWorktrees(project.id)).find((item) => item.id === feature.id)?.presence, "missing");
    await fs.rename(`${spaced}-away`, spaced);
    await reconcileGitWorktrees(project);
    assert.equal((await getProjectWorktrees(project.id)).find((item) => item.id === feature.id)?.presence, "active");

    await git(source, "worktree", "remove", "--force", detached);
    await reconcileGitWorktrees(project);
    const missing = (await getProjectWorktrees(project.id)).find((item) => item.id === headless.id)!;
    assert.equal(missing.presence, "missing");
    await git(source, "worktree", "add", "--detach", detached);
    await reconcileGitWorktrees(project);
    const reused = (await getProjectWorktrees(project.id)).filter((item) => item.path === detachedReal);
    assert.equal(reused.length, 1);
    assert.equal(reused[0].presence, "missing");

    const prunable = path.join(root, "prunable");
    await git(source, "worktree", "add", "-b", "prunable", prunable);
    await fs.rm(prunable, { recursive: true, force: true });
    await reconcileGitWorktrees(project);
    assert.ok(!(await getProjectWorktrees(project.id)).some((item) => item.name === "prunable"));
  });
});

test("adding a project discovers linked worktrees immediately", async () => {
  await withRepo(async (root, source) => {
    const linked = path.join(root, "already here");
    await git(source, "worktree", "add", "-b", "already", linked);
    await fs.mkdir(path.join(source, ".controller"));
    await fs.writeFile(path.join(source, ".controller", "setup.sh"),
      `#!/bin/sh\ntouch "${path.join(linked, "setup-ran")}"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(root, "projects.json"), "[]");
    const { projectsRouter } = await import("../../routes/projects.js");
    const app = express();
    app.use(express.json());
    app.use("/api/projects", projectsRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test", path: source }),
      });
      assert.equal(response.status, 201);
      const project = await response.json() as { id: string };
      const rows = await getProjectWorktrees(project.id);
      assert.equal(rows.filter((row) => row.origin === "external").length, 1);
      await assert.rejects(fs.stat(path.join(linked, "setup-ran")), { code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("the worktree route auto-refreshes and DELETE only stops tracking an external checkout", async () => {
  await withRepo(async (root, source) => {
    const linked = path.join(root, "existing linked");
    await git(source, "worktree", "add", "-b", "linked", linked);
    const linkedReal = await fs.realpath(linked);
    const { worktreesRouter } = await import("../../routes/worktrees.js");
    const app = express();
    app.use("/api/projects", worktreesRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}/api/projects/project/worktrees`;
      const listed = await fetch(base);
      assert.equal(listed.status, 200);
      const rows = await listed.json() as Array<{ id: string; path: string; origin?: string }>;
      const external = rows.find((row) => row.path === linkedReal)!;
      assert.equal(external.origin, "external");

      const removed = await fetch(`${base}/${external.id}?force=1`, { method: "DELETE" });
      assert.equal(removed.status, 200);
      assert.equal((await fs.stat(linked)).isDirectory(), true);
      const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: source });
      assert.ok(stdout.includes(linked));
      const after = await fetch(base);
      const history = await after.json() as Array<{ id: string; presence?: string }>;
      assert.equal(history.find((row) => row.id === external.id)?.presence, "removed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
