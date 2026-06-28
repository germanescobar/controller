import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #261: request-level tests for the terminal surface. Mounts the real
 * `terminalRouter` against a temp `CONTROLLER_HOME` with a real git project so
 * `findWorktreeByPath` resolves the project's main worktree from a cwd, then
 * exercises the action dispatch and the worktree-scoping guarantee.
 */

interface RoutesEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}

async function withRoutes<T>(fn: (env: RoutesEnv) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-routes-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      { id: projectId, name: "demo", path: projectPath, createdAt: new Date().toISOString() },
    ])
  );

  const { terminalRouter } = await import("../../routes/terminal.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/terminal", terminalRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/terminal`;

  try {
    const { getProjectWorktrees } = await import("../../lib/worktrees.js");
    const worktrees = await getProjectWorktrees(projectId);
    const main = worktrees.find((w) => w.isMain);
    if (!main) throw new Error("main worktree not found");
    return await fn({ baseUrl, projectId, worktreeId: main.id, worktreePath: main.path });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`))
    );
    child.on("error", reject);
  });
}

function command(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("rejects a missing cwd and an unknown action", async () => {
  await withRoutes(async ({ baseUrl, worktreePath }) => {
    const noCwd = await command(baseUrl, { action: "list" });
    assert.equal(noCwd.status, 400);

    const badAction = await command(baseUrl, { cwd: worktreePath, action: "frobnicate" });
    assert.equal(badAction.status, 400);
    assert.match(((await badAction.json()) as { error: string }).error, /Unknown terminal action/);
  });
});

test("404s when the cwd is outside any known worktree", async () => {
  await withRoutes(async ({ baseUrl }) => {
    const res = await command(baseUrl, { cwd: os.tmpdir(), action: "list" });
    assert.equal(res.status, 404);
  });
});

test("list returns the worktree scope and no terminals when none are open", async () => {
  await withRoutes(async ({ baseUrl, projectId, worktreeId, worktreePath }) => {
    const res = await command(baseUrl, { cwd: worktreePath, action: "list" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      projectId: string;
      worktreeId: string;
      terminals: unknown[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.projectId, projectId);
    assert.equal(body.worktreeId, worktreeId);
    assert.deepEqual(body.terminals, []);
  });
});

test("run/snapshot 404 for a terminal the user has not opened", async () => {
  await withRoutes(async ({ baseUrl, worktreePath }) => {
    const run = await command(baseUrl, {
      cwd: worktreePath,
      action: "run",
      params: { terminalId: "build", command: "echo hi" },
    });
    assert.equal(run.status, 404);
    assert.match(((await run.json()) as { error: string }).error, /No terminal "build" is open/);

    const snapshot = await command(baseUrl, {
      cwd: worktreePath,
      action: "snapshot",
      params: { terminalId: "build" },
    });
    assert.equal(snapshot.status, 404);
  });
});

test("rejects an invalid terminal id", async () => {
  await withRoutes(async ({ baseUrl, worktreePath }) => {
    const res = await command(baseUrl, {
      cwd: worktreePath,
      action: "snapshot",
      params: { terminalId: "../etc" },
    });
    assert.equal(res.status, 400);
  });
});

test("a terminal in another worktree is not reachable from this cwd", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }
  await withRoutes(async ({ baseUrl, projectId, worktreeId, worktreePath }) => {
    const { ptyManager } = await import("../../lib/pty-manager.js");
    // Open a terminal under a *different* worktree id for the same project.
    const otherSessionId = `${projectId}:other-worktree:build`;
    const created = ptyManager.getOrCreate(otherSessionId, worktreePath);
    if (created.error) {
      t.skip(`could not spawn a PTY: ${created.error}`);
      return;
    }
    try {
      // This worktree's list never shows the other worktree's terminal.
      const listed = (await (
        await command(baseUrl, { cwd: worktreePath, action: "list" })
      ).json()) as { terminals: Array<{ id: string }> };
      assert.deepEqual(listed.terminals, []);

      // And addressing that id from this cwd builds *this* worktree's session
      // id, which does not exist — so it 404s rather than reaching across.
      const snapshot = await command(baseUrl, {
        cwd: worktreePath,
        action: "snapshot",
        params: { terminalId: "build" },
      });
      assert.equal(snapshot.status, 404);

      // Sanity: the other worktree's session really is live in the manager.
      assert.equal(ptyManager.listByPrefix(`${projectId}:other-worktree:`).length, 1);
      assert.equal(ptyManager.listByPrefix(`${projectId}:${worktreeId}:`).length, 0);
    } finally {
      ptyManager.kill(otherSessionId);
    }
  });
});
