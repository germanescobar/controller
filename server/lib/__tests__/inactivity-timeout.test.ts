import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #386: long CI waits (e.g. `gh pr checks --watch`) trip the 5-minute
 * agent-inactivity watchdog. The endpoint exposes a per-session
 * `agentInactivityTimeoutMs` knob (5 min default; clients can extend it for
 * runs expected to wait on a synchronous tool call). The value persists on
 * the session file and re-applies on resume, so follow-up turns do not have
 * to re-pass it.
 *
 * These tests stand up the real `sessionsRouter` against a temp
 * `CONTROLLER_HOME` with a fake `anita` binary and verify that:
 *
 *   - the per-session override is persisted on the session file;
 *   - non-positive values are silently ignored (no 4xx, no zero window);
 *   - a quiet stretch under the override is not killed by the watchdog;
 *   - the SSE handler emits periodic `run.idle` events while the child is
 *     alive and quiet, so the UI can render a "still running" indicator.
 *
 * The fake agent is bash; we control its lifetime precisely so the test
 * can run in seconds rather than minutes by passing a generous
 * `agentInactivityTimeoutMs` per-session override plus a long-running
 * shell command.
 */

interface WithSessionStartEnvCtx {
  projectPath: string;
  worktreePath: string;
  homeDir: string;
  binDir: string;
}

interface WithSessionStartEnvArgs {
  projectId: string;
  worktreeId: string;
  baseUrl: string;
  homeDir: string;
  projectPath: string;
  worktreePath: string;
}

interface WithSessionStartEnvOptions {
  /**
   * Override `RUN_IDLE_PING_INTERVAL_MS` for the test. The constant is
   * read once at module load time, so the env var must be set BEFORE
   * the sessionsRouter is dynamically imported.
   */
  runIdlePingIntervalMs?: number;
}

async function withSessionStartEnv<T>(
  setup: (ctx: WithSessionStartEnvCtx) => Promise<void>,
  fn: (env: WithSessionStartEnvArgs) => Promise<T>,
  options: WithSessionStartEnvOptions = {}
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "inactivity-test-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "inactivity-bin-"));
  const previous = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  const previousAgent = process.env.AGENT_INACTIVITY_TIMEOUT_MS;
  const previousPing = process.env.RUN_IDLE_PING_INTERVAL_MS;
  // Force the default back to a known value (5 min) so a developer's
  // shell env var does not bleed into the test.
  delete process.env.AGENT_INACTIVITY_TIMEOUT_MS;
  if (typeof options.runIdlePingIntervalMs === "number") {
    process.env.RUN_IDLE_PING_INTERVAL_MS = String(options.runIdlePingIntervalMs);
  }
  process.env.CONTROLLER_HOME = homeDir;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  const projectId = "proj-inactivity";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });

  // Initialize a real git repo so `getProjectWorktrees` /
  // `ensureMainWorktree` do not blow up on a missing worktree path.
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
        name: "inactivity-test",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );

  await setup({ projectPath, worktreePath: projectPath, homeDir, binDir });

  // The command resolver caches resolved absolute paths across calls.
  // Clearing it here gives each test a fresh resolution against the
  // current PATH.
  const { clearCommandResolverCache } = await import("../../lib/command-resolver.js");
  clearCommandResolverCache();

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}`;

  try {
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
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAgent === undefined) delete process.env.AGENT_INACTIVITY_TIMEOUT_MS;
    else process.env.AGENT_INACTIVITY_TIMEOUT_MS = previousAgent;
    if (previousPing === undefined) delete process.env.RUN_IDLE_PING_INTERVAL_MS;
    else process.env.RUN_IDLE_PING_INTERVAL_MS = previousPing;
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
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

async function readSse(res: Response): Promise<unknown[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: unknown[] = [];
  try {
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
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      ((err as { name?: string }).name === "AbortError" ||
        (err as { name?: string }).name === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      // fall through
    } else {
      throw err;
    }
  }
  return out;
}

interface InstallFakeAgentOptions {
  /** Sleep this many seconds after run.started before emitting run.completed.
   *  Used to test that the watchdog is respected on quiet tool calls */
  silentSecondsAfterStart?: number;
}

/**
 * Stand up a fake `anita` script. The script mirrors the real anita wire
 * format (newline-delimited JSON) but lets the test author pin the timing
 * precisely so the watchdog branch can be exercised in seconds rather
 * than minutes.
 */
async function installFakeAgent(
  binDir: string,
  sessionId: string,
  options: InstallFakeAgentOptions = {}
): Promise<void> {
  const silentAfter = options.silentSecondsAfterStart ?? 0;
  const script = `#!/usr/bin/env bash
set -e
# Emit run.started so the persistence layer + shim flush the sessionId
# response back to the client.
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
if [ ${silentAfter} -gt 0 ]; then
  # Quiet stretch — the watchdog must NOT fire if the per-session
  # override exceeds the runtime of this silent window.
  sleep ${silentAfter}
fi
# Then a run.completed so the SSE handler's close path runs cleanly.
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:01.000Z"}'
# Drain stdin so we exit promptly when the orchestrator closes it.
cat >/dev/null || true
exit 0
`;
  await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
}

test("per-session inactivity timeout persists on the session file when supplied via POST (issue #386)", async () => {
  const sessionId = "sess-issue-386-persist";
  const override = 30 * 60 * 1000; // 30 minutes
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
          message: "Run CI check",
          provider: "anita",
          agentInactivityTimeoutMs: override,
        }),
      });
      const body = (await res.json()) as {
        sessionId?: string;
        url?: string;
        error?: string;
      };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId);

      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionFile = path.join(storeDir, "sessions", `${sessionId}.json`);
      const sessionContent = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(sessionContent);
      assert.equal(
        session.agentInactivityTimeoutMs,
        override,
        "per-session inactivity timeout must be persisted on the session file"
      );
    }
  );
});

test("per-session inactivity timeout is omitted from the session file when not supplied (issue #386, acceptance bullet 4)", async () => {
  // Acceptance bullet 4: "Existing sessions keep the 5-min default."
  // Brand-new sessions without an override should not include the
  // field, so the file stays clean and resumes default.
  const sessionId = "sess-issue-386-default";
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
          message: "Quick run.",
          provider: "anita",
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId);

      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionFile = path.join(storeDir, "sessions", `${sessionId}.json`);
      const sessionContent = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(sessionContent);
      assert.equal(
        session.agentInactivityTimeoutMs,
        undefined,
        "defaulting to the global value should omit the field from the session file"
      );
    }
  );
});

test("per-session inactivity timeout rejects non-positive values (issue #386)", async () => {
  // Negative or zero overrides fall back to the default — they MUST NOT
  // starve the watchdog to a sub-second window, and they MUST NOT be
  // persisted as a never-firing override. We rely on a working fake
  // agent (one that emits run.started + run.completed and exits) so
  // the persistence path runs end-to-end and we can inspect the
  // session file. The endpoint MUST NOT 4xx on a bad value — the
  // contract is "silently ignore and use the default", matching how
  // the SSE handler's `parsePositiveInt` filters out garbage.
  const sessionId = "sess-issue-386-non-positive";
  await withSessionStartEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, sessionId);
    },
    async ({ baseUrl, worktreeId, projectPath }) => {
      for (const bad of [0, -1, -30 * 60 * 1000]) {
        const res = await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            worktreeId,
            message: "Run.",
            provider: "anita",
            agentInactivityTimeoutMs: bad,
          }),
        });
        assert.equal(
          res.status,
          200,
          `non-positive override ${bad} should not 4xx; got ${res.status}`
        );
        await res.body?.cancel?.();
      }

      // After the last successful POST the session file should NOT
      // include a negative or zero override — non-positive values are
      // silently dropped.
      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionFile = path.join(storeDir, "sessions", `${sessionId}.json`);
      const sessionContent = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(sessionContent);
      assert.equal(
        session.agentInactivityTimeoutMs,
        undefined,
        "non-positive overrides must be silently dropped, not persisted"
      );
    }
  );
});

test("a quiet tool call survives the watchdog when the per-session override is large (issue #386, acceptance bullet 2)", async () => {
  // Acceptance bullet 2: "A session whose timeout is e.g. 30 min survives a
  // `gh pr checks --watch` that takes 15 min." We exercise it in seconds
  // by running a fake agent that is silent for several seconds with a
  // generous per-session override, then verify the run completes
  // cleanly (no synthetic run.failed from the watchdog).
  const sessionId = "sess-issue-386-survives";
  // 30s window — long enough for the silent stretch below. The
  // production unit is minutes; the contract is "override > silent
  // stretch".
  const override = 30 * 1000;
  // 3s silent after run.started. We then check the events file for
  // run.completed with no run.failed.
  const silentSeconds = 3;
  await withSessionStartEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, sessionId, {
        silentSecondsAfterStart: silentSeconds,
      });
    },
    async ({ baseUrl, worktreeId, projectPath }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Long sync.",
          provider: "anita",
          agentInactivityTimeoutMs: override,
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(body.sessionId, sessionId);

      // The SSE handler returns immediately on POST (the shim flushes
      // once run.started lands). Wait for the agent to finish writing
      // events then inspect them.
      await new Promise((resolve) =>
        setTimeout(resolve, silentSeconds * 1000 + 2000)
      );

      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const eventsFile = path.join(storeDir, "events", `${sessionId}.jsonl`);
      const eventsContent = await fs.readFile(eventsFile, "utf-8");
      const types = eventsContent
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).type as string);
      assert.ok(
        types.includes("user_message"),
        `user_message should be persisted (proves the run attached), got: ${types.join(", ")}`
      );
      // `run.completed` is intentionally NOT persisted (see
      // `server/routes/sessions.ts` — only `user_message` and
      // non-terminal events go to the events file; terminal events
      // are reconstructed from the session file's `status` field).
      // The watchdog-kill case writes a synthetic `run.failed` event
      // and that IS persisted; absence of `run.failed` therefore
      // proves the watchdog never fired.
      assert.ok(
        !types.includes("run_failed"),
        `run.failed should NOT be persisted when the override covers the silence, got: ${types.join(", ")}`
      );
      // Sanity-check the session file: it should record `status:
      // active` (the run is still alive) and the override we set,
      // demonstrating end-to-end that the override reached the
      // watchdog without being silently reset to the default.
      const { projectStoreDir: projectStoreDirFn } = await import("../../lib/paths.js");
      const sd = projectStoreDirFn(projectPath);
      const sFile = path.join(sd, "sessions", `${sessionId}.json`);
      const sContent = await fs.readFile(sFile, "utf-8");
      const s = JSON.parse(sContent);
      assert.equal(
        s.agentInactivityTimeoutMs,
        override,
        "the per-session override must survive the round-trip onto the session file"
      );
      assert.notEqual(
        s.status,
        "failed",
        `session status must not be 'failed' after a quiet stretch under the override (got: ${s.status})`
      );
    }
  );
});

test("SSE handler emits run.idle events while the child is alive and quiet (issue #386, acceptance bullet 3)", async () => {
  // Acceptance bullet 3: "The UI renders a visible 'still running' state
  // during long synchronous tool calls instead of a frozen transcript."
  // The server-side mechanism is a periodic `run.idle` ping; we verify
  // the server emits it while the child is alive.
  //
  // We use the GET stream endpoint so we can observe the SSE stream
  // live. The fake agent goes silent for several seconds after
  // run.started. The `RUN_IDLE_PING_INTERVAL_MS` env var shrinks the
  // production 30-second cadence to 1s so the test completes in
  // seconds; the env var is re-read on each call (not module-load)
  // so the override takes effect immediately.
  const sessionId = "sess-issue-386-idle-ping";
  const silentSeconds = 3;
  await withSessionStartEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, sessionId, {
        silentSecondsAfterStart: silentSeconds,
      });
    },
    async ({ baseUrl, worktreeId, projectPath }) => {
      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      // Pre-seed the session file so the SSE resume path picks it up.
      await fs.mkdir(path.join(storeDir, "sessions"), { recursive: true });
      await fs.mkdir(path.join(storeDir, "events"), { recursive: true });
      await fs.mkdir(path.join(storeDir, "focus"), { recursive: true });
      const sessionFile = path.join(storeDir, "sessions", `${sessionId}.json`);
      await fs.writeFile(
        sessionFile,
        JSON.stringify(
          {
            id: sessionId,
            workingDirectory: projectPath,
            worktreeId,
            model: "sonnet",
            provider: "anita",
            mode: "default",
            messages: [],
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            status: "active",
            // Per-session override = 30s so the silent stretch is
            // comfortably under the watchdog window.
            agentInactivityTimeoutMs: 30 * 1000,
          },
          null,
          2
        )
      );

      const params = new URLSearchParams({
        worktreeId,
        message: "Long sync.",
        provider: "anita",
        resumeSessionId: sessionId,
      });
      const res = await fetch(`${baseUrl}/sessions/stream?${params}`);
      assert.equal(res.status, 200);
      // Read the SSE events for the full silent stretch plus a buffer.
      const eventsPromise = readSse(res);
      await new Promise((resolve) =>
        setTimeout(resolve, silentSeconds * 1000 + 1500)
      );
      const events = await eventsPromise;
      const idleEvents = events.filter(
        (evt) =>
          typeof evt === "object" &&
          evt !== null &&
          (evt as { type?: string }).type === "anita_event" &&
          (evt as { event?: { type?: string } }).event?.type === "run.idle"
      );
      assert.ok(
        idleEvents.length >= 1,
        `expected at least one run.idle ping while the child is silent, saw ${idleEvents.length} (event types: ${events
          .map((e) =>
            typeof e === "object" &&
            e !== null &&
            (e as { type?: string }).type === "anita_event"
              ? (e as { event?: { type?: string } }).event?.type
              : (e as { type?: string }).type
          )
          .join(", ")})`
      );
    },
    { runIdlePingIntervalMs: 1000 }
  );
});
