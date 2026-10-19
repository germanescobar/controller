import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearCommandResolverCache } from "../command-resolver.js";
import { getEvents } from "../sessions.js";
import { enqueue, listQueue } from "../session-queue.js";
import {
  claimSessionRunStart,
  getSessionRuntime,
  releaseSessionRunLease,
  releaseSessionRunStart,
} from "../session-runtime.js";
import { runQueueRecovery } from "../queue-recovery.js";
import { getProjectWorktrees } from "../worktrees.js";
import { projectStoreDir, sessionQueuesDir } from "../paths.js";
import {
  advanceSessionQueueFromConsumer,
  handleSessionStream,
  sendBySessionIdRouter,
} from "../../routes/sessions.js";

const run = promisify(execFile);

async function withDispatchEnv(
  exercise: (env: {
    baseUrl: string;
    projectId: string;
    worktreeId: string;
    sessionId: string;
    projectPath: string;
    startsFile: string;
  }) => Promise<void>
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "queue-dispatch-"));
  const previousHome = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  process.env.CONTROLLER_HOME = home;
  process.env.PATH = `${path.join(home, "bin")}${path.delimiter}${previousPath ?? ""}`;
  const projectPath = path.join(home, "source");
  const projectId = "dispatch-project";
  const sessionId = "dispatch-target";
  const startsFile = path.join(home, "starts.txt");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(path.join(home, "bin"));
  await run("git", ["init", "--initial-branch=main"], { cwd: projectPath });
  await fs.writeFile(path.join(projectPath, "README.md"), "test\n");
  await fs.writeFile(path.join(home, "projects.json"), JSON.stringify([{
    id: projectId, name: "dispatch", path: projectPath, createdAt: new Date().toISOString(),
  }]));
  const worktree = (await getProjectWorktrees(projectId)).find((item) => item.isMain);
  assert.ok(worktree);
  const sessionsDir = path.join(projectStoreDir(projectPath), "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  for (const id of ["dispatch-parent", sessionId]) {
    await fs.writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify({
      id, title: id, workingDirectory: projectPath, worktreeId: worktree.id,
      projectId, provider: "anita", model: "", mode: "default", status: "active",
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    }));
  }
  await fs.writeFile(path.join(home, "bin", "anita"), `#!/usr/bin/env bash
set -e
printf 'start\\n' >> '${startsFile}'
sleep 0.2
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
sleep 0.2
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:01.000Z"}'
`, { mode: 0o755 });
  clearCommandResolverCache();

  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sendBySessionIdRouter);
  app.get("/api/projects/:projectId/sessions/stream", handleSessionStream);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await exercise({
      baseUrl: `http://127.0.0.1:${address.port}`,
      projectId, worktreeId: worktree.id, sessionId, projectPath, startsFile,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearCommandResolverCache();
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function waitForRun(projectPath: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const events = await getEvents(projectPath, sessionId);
    if (
      Date.now() - startedAt > 500 &&
      events.some((event) => event.type === "user_message") &&
      !getSessionRuntime(sessionId).active
    ) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for queued run to finish");
}

test("idle send and a concurrent consumer tick dispatch one run and one user message", async () => {
  await withDispatchEnv(async (env) => {
    const response = await fetch(`${env.baseUrl}/api/sessions/${env.sessionId}/send-from`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromSessionId: "dispatch-parent", message: "hello" }),
    });
    assert.equal(response.status, 201);
    await advanceSessionQueueFromConsumer(env.projectId, env.worktreeId, env.sessionId);
    await waitForRun(env.projectPath, env.sessionId);
    assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
    const events = await getEvents(env.projectPath, env.sessionId);
    assert.equal(events.filter((event) => event.type === "user_message").length, 1);
    assert.deepEqual(await listQueue(env.sessionId), []);
  });
});

test("two racing queue dispatch attempts start one run", async () => {
  await withDispatchEnv(async (env) => {
    await enqueue(env.sessionId, {
      text: "race", visibleText: "race", provider: "anita", model: "",
      mode: "default", attachmentIds: [],
    });
    await Promise.all([
      advanceSessionQueueFromConsumer(env.projectId, env.worktreeId, env.sessionId),
      advanceSessionQueueFromConsumer(env.projectId, env.worktreeId, env.sessionId),
    ]);
    await waitForRun(env.projectPath, env.sessionId);
    assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
    const events = await getEvents(env.projectPath, env.sessionId);
    assert.equal(events.filter((event) => event.type === "user_message").length, 1);
  });
});

test("two server processes sharing a home dispatch one sent message once", async () => {
  await withDispatchEnv(async (env) => {
    const childCode = `
      import express from "express";
      import http from "node:http";
      import { advanceSessionQueueFromConsumer } from ${JSON.stringify(new URL("../../routes/sessions.ts", import.meta.url).href)};
      const app = express();
      app.post("/advance", async (_req, res) => {
        await advanceSessionQueueFromConsumer(${JSON.stringify(env.projectId)}, ${JSON.stringify(env.worktreeId)}, ${JSON.stringify(env.sessionId)});
        res.end();
      });
      const server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => console.log(server.address().port));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const line = output.split("\n")[0];
          if (/^\d+$/.test(line)) resolve(Number(line));
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Second server exited before ready: ${code}`)));
      });
      const send = fetch(`${env.baseUrl}/api/sessions/${env.sessionId}/send-from`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromSessionId: "dispatch-parent", message: "hello" }),
      });
      const advance = fetch(`http://127.0.0.1:${port}/advance`, { method: "POST" });
      const [sent, advanced] = await Promise.all([send, advance]);
      assert.equal(sent.status, 201);
      assert.equal(advanced.status, 200);
      await waitForRun(env.projectPath, env.sessionId);
      assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
      assert.equal((await getEvents(env.projectPath, env.sessionId)).filter((event) => event.type === "user_message").length, 1);
    } finally {
      child.kill();
    }
  });
});

test("a direct resume refuses a second concurrent run", async () => {
  await withDispatchEnv(async (env) => {
    const url = new URL(`${env.baseUrl}/api/projects/${env.projectId}/sessions/stream`);
    url.searchParams.set("worktreeId", env.worktreeId);
    url.searchParams.set("resumeSessionId", env.sessionId);
    url.searchParams.set("provider", "anita");
    url.searchParams.set("message", "first");
    const first = await fetch(url);
    assert.equal(first.status, 200);
    url.searchParams.set("message", "second");
    const second = await fetch(url);
    assert.equal(second.status, 409);
    await first.text();
    await waitForRun(env.projectPath, env.sessionId);
    assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
  });
});

test("a direct resume that fails preflight drains a message queued behind its lease", async () => {
  await withDispatchEnv(async (env) => {
    await enqueue(env.sessionId, {
      text: "after failure", visibleText: "after failure", provider: "anita",
      model: "", mode: "default", attachmentIds: [],
    });
    const url = new URL(`${env.baseUrl}/api/projects/${env.projectId}/sessions/stream`);
    url.searchParams.set("worktreeId", env.worktreeId);
    url.searchParams.set("resumeSessionId", env.sessionId);
    url.searchParams.set("provider", "unavailable-provider");
    url.searchParams.set("message", "fails preflight");
    const response = await fetch(url);
    assert.equal(response.status, 400);
    await waitForRun(env.projectPath, env.sessionId);
    assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
    assert.equal((await getEvents(env.projectPath, env.sessionId)).filter((event) => event.type === "user_message").length, 1);
    assert.deepEqual(await listQueue(env.sessionId), []);
  });
});

test("owner recovery tick dispatches a plain queue behind a stale lease once", async () => {
  await withDispatchEnv(async (env) => {
    await enqueue(env.sessionId, {
      text: "recover", visibleText: "recover", provider: "anita",
      model: "", mode: "default", attachmentIds: [],
    });
    const lockDir = path.join(sessionQueuesDir(), `${env.sessionId}.run.lock`);
    await fs.mkdir(lockDir);
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, stale, stale);
    const deps = { advanceSessionQueue: advanceSessionQueueFromConsumer };
    await Promise.all([runQueueRecovery(deps), runQueueRecovery(deps)]);
    await waitForRun(env.projectPath, env.sessionId);
    assert.equal((await fs.readFile(env.startsFile, "utf-8")).trim(), "start");
    assert.equal((await getEvents(env.projectPath, env.sessionId)).filter((event) => event.type === "user_message").length, 1);
    assert.deepEqual(await listQueue(env.sessionId), []);
  });
});

test("owner recovery tick leaves a live lease alone", async () => {
  await withDispatchEnv(async (env) => {
    await enqueue(env.sessionId, {
      text: "wait", visibleText: "wait", provider: "anita",
      model: "", mode: "default", attachmentIds: [],
    });
    assert.equal(await claimSessionRunStart(env.sessionId), true);
    try {
      await runQueueRecovery({ advanceSessionQueue: advanceSessionQueueFromConsumer });
      assert.equal((await listQueue(env.sessionId)).length, 1);
      await assert.rejects(fs.readFile(env.startsFile), { code: "ENOENT" });
    } finally {
      releaseSessionRunStart(env.sessionId);
      await releaseSessionRunLease(env.sessionId);
    }
  });
});
