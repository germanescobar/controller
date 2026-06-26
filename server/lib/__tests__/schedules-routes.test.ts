import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #243: request-level tests for the schedules REST surface. Mounts the
 * real `schedulesRouter` against a temp `CONTROLLER_HOME` with a real git
 * project so `resolveWorktree` can resolve the main worktree, then drives the
 * full CRUD lifecycle over HTTP.
 */

async function withRoutes<T>(
  fn: (env: { baseUrl: string; projectId: string; worktreeId: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "schedules-routes-"));
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
    JSON.stringify([{ id: projectId, name: "demo", path: projectPath, createdAt: new Date().toISOString() }])
  );

  const { schedulesRouter } = await import("../../routes/schedules.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/projects", schedulesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}`;

  try {
    const { getProjectWorktrees } = await import("../../lib/worktrees.js");
    const worktrees = await getProjectWorktrees(projectId);
    const main = worktrees.find((w) => w.isMain);
    if (!main) throw new Error("main worktree not found");
    return await fn({ baseUrl, projectId, worktreeId: main.id });
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

test("schedules CRUD lifecycle over HTTP", async () => {
  await withRoutes(async ({ baseUrl, worktreeId }) => {
    // Create a one-shot schedule.
    const createRes = await fetch(`${baseUrl}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worktreeId,
        prompt: "Run the morning health check",
        runAt: "2026-06-26T08:00:00.000Z",
      }),
    });
    const created = (await createRes.json()) as { id?: string; nextRunAt?: string; error?: string };
    assert.equal(createRes.status, 201, JSON.stringify(created));
    assert.ok(created.id);
    assert.equal(created.nextRunAt, "2026-06-26T08:00:00.000Z");

    // List shows it.
    const listRes = await fetch(`${baseUrl}/schedules`);
    const list = (await listRes.json()) as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);

    // Disable, then exclude disabled from the list.
    const disableRes = await fetch(`${baseUrl}/schedules/${created.id}/disable`, { method: "POST" });
    assert.equal(disableRes.status, 200);
    const enabledOnly = (await (await fetch(`${baseUrl}/schedules?includeDisabled=false`)).json()) as unknown[];
    assert.equal(enabledOnly.length, 0);

    // Re-enable.
    const enableRes = await fetch(`${baseUrl}/schedules/${created.id}/enable`, { method: "POST" });
    const enabled = (await enableRes.json()) as { enabled?: boolean };
    assert.equal(enabled.enabled, true);

    // Runs are empty until it fires.
    const runs = (await (await fetch(`${baseUrl}/schedules/${created.id}/runs`)).json()) as unknown[];
    assert.deepEqual(runs, []);

    // Remove.
    const removeRes = await fetch(`${baseUrl}/schedules/${created.id}`, { method: "DELETE" });
    assert.equal(removeRes.status, 200);
    const afterRemove = (await (await fetch(`${baseUrl}/schedules`)).json()) as unknown[];
    assert.equal(afterRemove.length, 0);
  });
});

test("POST /schedules validates required fields and cron/runAt", async () => {
  await withRoutes(async ({ baseUrl, worktreeId }) => {
    const missingPrompt = await fetch(`${baseUrl}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId, runAt: "2026-06-26T08:00:00.000Z" }),
    });
    assert.equal(missingPrompt.status, 400);

    const missingTrigger = await fetch(`${baseUrl}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId, prompt: "x" }),
    });
    assert.equal(missingTrigger.status, 400);

    const badCron = await fetch(`${baseUrl}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId, prompt: "x", cron: "not a cron" }),
    });
    const badCronBody = (await badCron.json()) as { error?: string };
    assert.equal(badCron.status, 400);
    assert.match(badCronBody.error ?? "", /Invalid cron/);
  });
});

test("schedule routes 404 on unknown project and schedule", async () => {
  await withRoutes(async ({ baseUrl }) => {
    const unknownSchedule = await fetch(`${baseUrl}/schedules/does-not-exist`);
    assert.equal(unknownSchedule.status, 404);
  });
});
