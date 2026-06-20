import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #138: GET /setup-log and POST /run-setup for a worktree. We mount
 * the router against a temp `CODING_ORCHESTRATOR_HOME`, pre-seed a project +
 * worktree, and exercise both endpoints with raw HTTP. The setup script we
 * write is a real shell script so the success/failure paths run the real
 * `runScriptCommands` machinery.
 */

async function readSse(res: Response): Promise<unknown[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: unknown[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (dataLine) {
        try {
          out.push(JSON.parse(dataLine.slice(6)));
        } catch {
          // ignore parse errors
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return out;
}

async function withSetupEnv<T>(
  setup: (ctx: {
    homeDir: string;
    projectId: string;
    worktreeId: string;
    projectPath: string;
    worktreePath: string;
  }) => Promise<void>,
  fn: (ctx: { baseUrl: string; projectId: string; worktreeId: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-setup-test-"));
  const previous = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = homeDir;

  const projectId = "proj-1";
  const worktreeId = "wt-1";
  // Project lives at `<homeDir>/source`; its worktree at `<homeDir>/wt/issue-1`.
  // The native setup.sh the project uses is at `<homeDir>/source/.coding-orchestrator/setup.sh`.
  const projectPath = path.join(homeDir, "source");
  const worktreePath = path.join(homeDir, "wt", "issue-1");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });

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
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: worktreeId,
        projectId,
        name: "issue-1",
        path: worktreePath,
        branch: "issue-1",
        isMain: false,
        createdAt: new Date().toISOString(),
      },
    ])
  );

  await setup({ homeDir, projectId, worktreeId, projectPath, worktreePath });

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}/worktrees/${worktreeId}`;

  try {
    return await fn({ baseUrl, projectId, worktreeId });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("GET /setup-log returns null when no setup has been run yet", async () => {
  await withSetupEnv(async ({ projectPath }) => {
    // Write a setup.sh so the project has a setup script configured, but
    // don't run it — the worktree record has no setupLogPath yet.
    await fs.mkdir(path.join(projectPath, ".coding-orchestrator"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".coding-orchestrator", "setup.sh"),
      "echo ok\n"
    );
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/setup-log`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { log: string | null };
    assert.equal(body.log, null);
  });
});

test("GET /setup-log reads the captured log + exit code + ranAt after a run", async () => {
  await withSetupEnv(async ({ worktreePath }) => {
    // Pre-seed a setup.log so we don't have to actually run bash for this test.
    const codingAgentDir = path.join(worktreePath, ".coding-agent");
    await fs.mkdir(codingAgentDir, { recursive: true });
    await fs.writeFile(path.join(codingAgentDir, "setup.log"), "hello\nworld\n");
    // Persist the matching fields on the worktree record.
    const wtPath = path.join(process.env.CODING_ORCHESTRATOR_HOME!, "worktrees.json");
    const wt = JSON.parse(await fs.readFile(wtPath, "utf-8")) as Array<Record<string, unknown>>;
    wt[0] = {
      ...wt[0],
      setupLogPath: path.join(codingAgentDir, "setup.log"),
      setupExitCode: 7,
      setupRanAt: "2026-06-20T12:00:00.000Z",
    };
    await fs.writeFile(wtPath, JSON.stringify(wt));
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/setup-log`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      log: string | null;
      exitCode: number | null;
      ranAt: string | null;
    };
    assert.equal(body.log, "hello\nworld\n");
    assert.equal(body.exitCode, 7);
    assert.equal(body.ranAt, "2026-06-20T12:00:00.000Z");
  });
});

test("GET /setup-log returns null when the log file is missing on disk", async () => {
  await withSetupEnv(async ({ worktreePath }) => {
    const codingAgentDir = path.join(worktreePath, ".coding-agent");
    await fs.mkdir(codingAgentDir, { recursive: true });
    const wtPath = path.join(process.env.CODING_ORCHESTRATOR_HOME!, "worktrees.json");
    const wt = JSON.parse(await fs.readFile(wtPath, "utf-8")) as Array<Record<string, unknown>>;
    wt[0] = {
      ...wt[0],
      setupLogPath: path.join(codingAgentDir, "does-not-exist.log"),
      setupExitCode: 1,
      setupRanAt: "2026-06-20T12:00:00.000Z",
    };
    await fs.writeFile(wtPath, JSON.stringify(wt));
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/setup-log`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { log: string | null };
    assert.equal(body.log, null);
  });
});

test("POST /run-setup returns 404 when no setup script is configured", async () => {
  await withSetupEnv(async () => {
    // No .coding-orchestrator/setup.sh — the project has no setup script.
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/run-setup`, { method: "POST" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No setup script/);
  });
});

test("POST /run-setup streams log output and updates exit code on success", async () => {
  await withSetupEnv(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, ".coding-orchestrator"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".coding-orchestrator", "setup.sh"),
      "echo greeting-from-setup\n"
    );
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/run-setup`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = (await readSse(res)) as Array<Record<string, unknown>>;
    const logTexts = events
      .filter((event) => event.type === "log" && event.stream === "stdout")
      .map((event) => String(event.text ?? ""))
      .join("");
    assert.match(logTexts, /Running setup\.sh/);
    assert.match(logTexts, /greeting-from-setup/);

    const done = events.find((event) => event.type === "done");
    assert.ok(done, "expected a done event");
    assert.equal(done!.exitCode, 0);

    // After the run, the worktree record should have setupExitCode === 0 and
    // the log file should exist on disk.
    const logRes = await fetch(`${baseUrl}/setup-log`);
    const logBody = (await logRes.json()) as { log: string | null; exitCode: number | null };
    assert.equal(logBody.exitCode, 0);
    assert.ok(logBody.log && logBody.log.includes("greeting-from-setup"));
  });
});

test("POST /run-setup surfaces a non-zero exit code in the done event", async () => {
  await withSetupEnv(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, ".coding-orchestrator"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".coding-orchestrator", "setup.sh"),
      "echo about-to-fail >&2; exit 42\n"
    );
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/run-setup`, { method: "POST" });
    const events = (await readSse(res)) as Array<Record<string, unknown>>;
    const done = events.find((event) => event.type === "done");
    assert.ok(done);
    assert.equal(done!.exitCode, 42);
    const errors = events.filter((event) => event.type === "error");
    assert.ok(errors.length > 0);
    assert.match(String(errors[0].text), /exited with 42/);
  });
});
