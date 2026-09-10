import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("dismissing user input clears the runtime attention flag", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attention-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "project-attention-dismiss";
  const sessionId = "session-attention-dismiss";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ]),
  );

  const { getProjectWorktrees } = await import("../worktrees.js");
  const [worktree] = await getProjectWorktrees(projectId);
  assert.ok(worktree);

  const { saveSession } = await import("../sessions.js");
  await saveSession(projectPath, {
    id: sessionId,
    workingDirectory: projectPath,
    worktreeId: worktree.id,
    model: "test-model",
    provider: "claude",
    messages: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: "active",
  });

  const {
    listSessionRuntimes,
    markSessionActive,
    markSessionInactive,
    setSessionAwaitingUserInput,
  } = await import("../session-runtime.js");
  markSessionActive(sessionId, { provider: "claude" });
  setSessionAwaitingUserInput(sessionId, true);
  markSessionInactive(sessionId);

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/projects/${projectId}/sessions/${sessionId}/user-input/dismiss?worktreeId=${worktree.id}`,
      { method: "POST" },
    );
    assert.equal(response.status, 200);
    const runtime = listSessionRuntimes().find(
      (entry) => entry.sessionId === sessionId,
    );
    assert.equal(runtime?.awaitingInput, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
