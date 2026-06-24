import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #190: `POST /api/projects/:projectId/sessions` is the headless
 * companion to `GET /api/projects/:projectId/sessions/stream`. It runs the
 * same persistence + agent-spawn pipeline but returns
 * `{ sessionId, url }` once the agent's first `run.started` event lands
 * so the CLI (or any automation) can hand the sessionId back to a human
 * to follow along in the UI.
 *
 * These tests mount the real `sessionsRouter` against a temp
 * `CODING_ORCHESTRATOR_HOME` and stand up a fake `anita` agent on PATH
 * that emits a single `run.started` line and exits. The session file
 * the persistence pipeline writes is then inspected on disk to confirm
 * the side effects the real endpoint is supposed to produce.
 */

async function withSessionStartEnv<T>(
  setup: (ctx: { projectPath: string; worktreePath: string; homeDir: string; binDir: string }) => Promise<void>,
  fn: (env: { projectId: string; worktreeId: string; baseUrl: string; homeDir: string; projectPath: string; worktreePath: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-start-test-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-start-bin-"));
  const previous = process.env.CODING_ORCHESTRATOR_HOME;
  const previousPath = process.env.PATH;
  process.env.CODING_ORCHESTRATOR_HOME = homeDir;
  // Prepend the fake-agent bin dir to PATH so the unified `controller` CLI's
  // bare `anita` invocation resolves to our fake script. `spawn(command)` walks
  // PATH itself, but `provider.spawn` passes an absolute path when one is
  // configured; the absolute path wins over PATH.
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });

  // Initialize a real git repo so `getProjectWorktrees` / `ensureMainWorktree`
  // don't blow up on a missing worktree path. The agent path under test doesn't
  // shell out to git, so the repo contents don't matter.
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);

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

  await setup({ projectPath, worktreePath: projectPath, homeDir, binDir });

  // The command resolver caches resolved absolute paths across calls. The
  // happy-path test's `anita` script lives in a temp binDir that gets
  // deleted in `finally`, so the cache would point at a now-missing
  // binary for the next test. Clearing the cache here gives each test a
  // fresh resolution against the current PATH.
  const { clearCommandResolverCache } = await import("../../lib/command-resolver.js");
  clearCommandResolverCache();

  // Stand up the real router so the new endpoint shares the same validation,
  // skill resolution, and persistence pipeline as the SSE handler.
  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}`;

  try {
    // `ensureMainWorktree` lazily creates the main worktree row on read, so
    // it is already present in the registry by the time we hit the API.
    const { getProjectWorktrees } = await import("../../lib/worktrees.js");
    const worktrees = await getProjectWorktrees(projectId);
    const main = worktrees.find((w) => w.isMain);
    if (!main) throw new Error("main worktree not found in registry");
    return await fn({
      projectId,
      worktreeId: main.id,
      baseUrl,
      homeDir,
      projectPath,
      worktreePath: projectPath,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`));
    });
    child.on("error", reject);
  });
}

/**
 * Stand up a fake agent binary on PATH. The script emits one
 * `run.started` line (with a deterministic sessionId) and a
 * `run.completed` line, then exits 0. The real provider parser only
 * expects newline-delimited JSON; the controller CLI / the SSE handler
 * already speak that shape, so the test exercises the real end-to-end
 * pipeline (validation → persistence → spawn → event stream → shim
 * response) without depending on a real agent install.
 */
async function installFakeAgent(binDir: string, sessionId: string): Promise<void> {
  // A bash script (not a `node` script) keeps the test independent of
  // any `--system-prompt` parsing the real CLI does. The `cat` loop just
  // keeps stdin open until the orchestrator closes it; we don't actually
  // read it.
  const script = `#!/usr/bin/env bash
set -e
# Emit a single run.started line as soon as we're spawned. The orchestrator's
# shim waits for this event before flushing the {sessionId, url} JSON
# response to the client.
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
# Then a run.completed so the SSE handler's close path runs cleanly.
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
# Drain stdin so we exit promptly when the orchestrator closes it.
cat >/dev/null || true
exit 0
`;
  await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
}

test("POST /api/projects/:projectId/sessions returns sessionId + url and persists the session", async () => {
  const sessionId = "sess-issue-190";
  await withSessionStartEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, sessionId);
    },
    async ({ baseUrl, worktreeId, projectPath }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Work on issue 190.",
          provider: "anita",
        }),
      });
      const body = (await res.json()) as {
        sessionId?: string;
        url?: string;
        error?: string;
      };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId, "sessionId should match the agent's run.started id");
      assert.match(body.url ?? "", new RegExp(`controller://project/.+/worktree/.+/session/${sessionId}`));

      // The persistence layer should have written the session file under
      // the worktree's Controller-home store, with the user_message event
      // we sent in the request.
      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionFile = path.join(storeDir, "sessions", `${sessionId}.json`);
      const eventsFile = path.join(storeDir, "events", `${sessionId}.jsonl`);
      const sessionContent = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(sessionContent);
      assert.equal(session.id, sessionId);
      assert.equal(session.provider, "anita");
      assert.equal(session.worktreeId, worktreeId);

      const eventsContent = await fs.readFile(eventsFile, "utf-8");
      const lines = eventsContent.split("\n").filter(Boolean);
      const types = lines.map((line) => JSON.parse(line).type as string);
      assert.ok(
        types.includes("user_message"),
        `user_message should be persisted; got types: ${types.join(", ")}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions returns 400 for missing message", async () => {
  await withSessionStartEnv(
    async () => {
      // No fake agent — the request should never reach the spawn step.
    },
    async ({ baseUrl, worktreeId }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreeId }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 400);
      assert.match(body.error ?? "", /message is required/);
    }
  );
});

test("POST /api/projects/:projectId/sessions returns 400 for missing worktreeId", async () => {
  await withSessionStartEnv(
    async () => {
      // No fake agent — the request should never reach the spawn step.
    },
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 400);
      assert.match(body.error ?? "", /worktreeId is required/);
    }
  );
});

test("POST /api/projects/:projectId/sessions returns 404 for unknown project", async () => {
  // No real setup needed: a request with an unknown project id should fail
  // before any work happens, returning a clean 404.
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-start-404-"));
  const previous = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = homeDir;
  const { clearCommandResolverCache } = await import("../../lib/command-resolver.js");
  clearCommandResolverCache();
  let server: http.Server | null = null;
  try {
    const { sessionsRouter } = await import("../../routes/sessions.js");
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use("/api/projects", sessionsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/no-such-project/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId: "wt-1", message: "hello" }),
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 404);
    assert.match(body.error ?? "", /Project not found/);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (previous === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("POST /api/projects/:projectId/sessions surfaces a 500 when the agent never reports run.started", async () => {
  await withSessionStartEnv(
    async ({ binDir }) => {
      // Fake agent that emits a run.failed event instead of run.started.
      // The shim's lastError tracking should surface the failure to the
      // client instead of "Agent exited before reporting a sessionId".
      const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' '{"type":"run.failed","sessionId":"","timestamp":"2026-01-01T00:00:00.000Z","error":"agent exploded"}'
cat >/dev/null || true
exit 1
`;
      await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
    },
    async ({ baseUrl, worktreeId }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Work on issue 190.",
          provider: "anita",
        }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 500);
      assert.match(body.error ?? "", /agent exploded/);
    }
  );
});

test("POST /api/projects/:projectId/sessions falls back to the agent's configured defaultModel when no --model is sent (issue #213)", async () => {
  const sessionId = "sess-issue-213-default-model";
  // The settings file lives at ${CODING_ORCHESTRATOR_HOME}/agents.json —
  // the fixture sets CODING_ORCHESTRATOR_HOME to `homeDir`, so we can
  // pre-seed it before the request fires.
  await withSessionStartEnv(
    async ({ binDir, homeDir }) => {
      await fs.writeFile(
        path.join(homeDir, "agents.json"),
        JSON.stringify({
          anita: {
            enabled: true,
            path: null,
            defaultModel: "ollama/glm-4.7-flash:latest",
          },
        })
      );
      // Fake anita that dumps its argv to a file the test reads back,
      // then emits run.started + run.completed and exits. The orchestrator
      // resolves the `anita` binary via PATH (with our shim prepended),
      // and `provider.spawn` receives the absolute path, so the shim
      // will see its own argv as `process.argv` only if we use `$@`.
      // Easier path: have the shim echo `$@` into a file at a known
      // location the test fixture knows about.
      const script = `#!/usr/bin/env bash
set -e
# Record the exact argv the orchestrator passed so the test can assert
# which flags made it through (issue #213).
printf '%s\\n' "$*" > "${homeDir}/spawned-args.txt"
# Emit run.started so the preflight shim flushes {sessionId, url}.
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
cat >/dev/null || true
exit 0
`;
      await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
    },
    async ({ baseUrl, worktreeId, homeDir }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Test the defaultModel fallback.",
          // Note: no `model` field — the orchestrator must look it up.
          provider: "anita",
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(
        res.status,
        200,
        `expected 200, got ${res.status}: ${JSON.stringify(body)}`
      );
      assert.equal(body.sessionId, sessionId);

      const argvFile = path.join(homeDir, "spawned-args.txt");
      const argv = (await fs.readFile(argvFile, "utf-8")).trim();
      // The recorded argv is a shell-flattened string; tokenize on
      // whitespace to recover the original argv slots.
      const tokens = argv.split(/\s+/);
      const modelIndex = tokens.indexOf("--model");
      assert.ok(
        modelIndex >= 0,
        `expected --model in argv (defaultModel fallback), got: ${argv}`
      );
      assert.equal(
        tokens[modelIndex + 1],
        "ollama/glm-4.7-flash:latest",
        `defaultModel from settings should be forwarded as --model value, got: ${argv}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions surfaces a stderr line in the preflight error when the agent crashes before reporting run.started (issue #213)", async () => {
  // Pre-fix, this case returned the generic "Agent exited before reporting
  // a sessionId" — useless for debugging. The fix records the most recent
  // stderr line into `lastError` so the user sees the actual diagnostic.
  await withSessionStartEnv(
    async ({ binDir }) => {
      // The shim writes a recognizable stderr line and exits without ever
      // emitting a `run.started` event. Mirrors the real anita failure
      // mode (model validation error on startup).
      const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' 'Invalid model format: "". Expected "provider/model" (e.g. "ollama/glm-4.7-flash:latest")' >&2
cat >/dev/null || true
exit 1
`;
      await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
    },
    async ({ baseUrl, worktreeId }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Trigger the stderr-surfacing path.",
          provider: "anita",
        }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 500);
      assert.match(
        body.error ?? "",
        /Invalid model format/,
        `expected stderr text in preflight error, got: ${JSON.stringify(body)}`
      );
    }
  );
});
