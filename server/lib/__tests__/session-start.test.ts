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
 * `CONTROLLER_HOME` and stand up a fake `anita` agent on PATH
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
  const previous = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  process.env.CONTROLLER_HOME = homeDir;
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
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
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
 * Read SSE events from a streaming response until the server closes the
 * connection. Each event is the JSON payload of a `data: …` line; ignored
 * lines (heartbeats, comments) are dropped. The reader tolerates premature
 * closes (the server may end the stream mid-read during shutdown) and
 * surfaces whatever events it had accumulated.
 *
 * Mirrors the helper in `events.test.ts` so this test file stays
 * self-contained — sharing helpers across `__tests__/` files would require
 * a new test-utility module and the duplication is small.
 */
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
    // Connection aborted (test teardown) or closed by the server — the
    // events we accumulated so far are still useful for assertions.
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      ((err as { name?: string }).name === "AbortError" ||
        (err as { name?: string }).name === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      // fall through and return what we have
    } else {
      throw err;
    }
  }
  return out;
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
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
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
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
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
  // The settings file lives at ${CONTROLLER_HOME}/agents.json —
  // the fixture sets CONTROLLER_HOME to `homeDir`, so we can
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

test("GET /api/projects/:projectId/sessions/stream appends captured stderr to the synthetic run.failed event (issue #376)", async () => {
  // Issue #376: when an agent child crashes mid-run (e.g. Codex rejecting
  // the argv and printing "Reading prompt from stdin... No prompt provided
  // via stdin." to stderr before exiting 1), the SSE handler must surface
  // that stderr in the synthetic `run.failed` event — not just the generic
  // `${providerName} process exited with code ${code}.` banner. Without
  // the captured stderr the user (and on-call engineer) has no clue what
  // actually broke and has to repro by hand. This test pins the behavior
  // by exercising the full SSE stream end-to-end with a shim that emits
  // run.started, prints a distinctive stderr line, and exits 1.
  const sessionId = "sess-issue-376-synthetic-run-failed";
  const stderrMarker =
    "ISSUE_376_STDERR_MARKER: agent crashed mid-run before producing output";
  await withSessionStartEnv(
    async ({ binDir }) => {
      // The shim emits a real run.started (so the SSE handshake completes
      // and we get a connected stream), then writes a recognizable stderr
      // line, and exits 1 — without ever emitting run.completed or
      // run.failed on stdout. This drives the synthetic run.failed branch
      // in the SSE handler's child.on("close") path with `lastStderrText`
      // populated from the stderr data handler.
      const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '${stderrMarker}' >&2
cat >/dev/null || true
exit 1
`;
      await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
    },
    async ({ baseUrl, worktreeId }) => {
      // Open the SSE stream directly. We can't use POST here because the
      // synthetic run.failed event fires AFTER the preflight resolves —
      // the POST response just hands back { sessionId, url } and closes,
      // and the synthetic run.failed event then flows to a connected SSE
      // client (the one that owns this turn's stream).
      const res = await fetch(
        `${baseUrl}/sessions/stream?` +
          new URLSearchParams({
            worktreeId,
            message: "Trigger the synthetic-run-failed-with-stderr path.",
            provider: "anita",
          }).toString(),
        {
          headers: { accept: "text/event-stream" },
        }
      );
      assert.equal(
        res.status,
        200,
        `expected 200 from SSE endpoint, got ${res.status}`
      );
      assert.match(
        res.headers.get("content-type") ?? "",
        /text\/event-stream/,
        `expected text/event-stream content-type, got ${res.headers.get("content-type")}`
      );

      const events = await readSse(res);

      // Locate the synthetic run.failed event. The shim does not emit
      // run.completed or run.failed on stdout, so any run.failed that
      // appears in the stream was synthesized by the SSE handler's close
      // path — the exact code path the issue is about.
      const failedEvents = events.filter(
        (event): event is { type: string; event?: { type?: string; error?: string } } =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "anita_event" &&
          (event as { event?: { type?: unknown } }).event?.type === "run.failed"
      );
      assert.ok(
        failedEvents.length >= 1,
        `expected at least one run.failed event in SSE stream, got: ${JSON.stringify(events)}`
      );

      // Concatenate the error fields from every synthetic run.failed in
      // case the orchestrator emits more than one (e.g. an inactivity
      // timeout firing after the exit). The captured stderr should appear
      // in at least one of them.
      const errors = failedEvents
        .map((event) => event.event?.error ?? "")
        .join("\n");
      assert.match(
        errors,
        /process exited with code 1/,
        `synthetic run.failed must include the generic exit-code banner, got: ${JSON.stringify(errors)}`
      );
      assert.match(
        errors,
        /ISSUE_376_STDERR_MARKER/,
        `synthetic run.failed must include the captured stderr marker, got: ${JSON.stringify(errors)}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions does not apply defaultModel when resumeSessionId is set (PR #218 review)", async () => {
  // PR review from chatgpt-codex-connector on #218: the defaultModel
  // fallback was firing for resume / follow-up / queue-replay turns,
  // silently changing the model under an existing session when the user
  // edited their Settings default. Gate the fallback to brand-new
  // sessions: when `resumeSessionId` is set, the Settings default must
  // be ignored even if no `model` is supplied on the wire.
  const sessionId = "sess-resume-without-model";
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
      const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' "$*" > "${homeDir}/spawned-args.txt"
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
          message: "Resume an existing session.",
          // No `model` on the wire — the Settings default is the
          // obvious temptation for the orchestrator, but the resume
          // path must ignore it.
          provider: "anita",
          resumeSessionId: sessionId,
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(
        res.status,
        200,
        `expected 200, got ${res.status}: ${JSON.stringify(body)}`
      );
      assert.equal(body.sessionId, sessionId);

      const argv = (await fs.readFile(path.join(homeDir, "spawned-args.txt"), "utf-8")).trim();
      const tokens = argv.split(/\s+/);
      // The orchestrator emits `--model <value>` only as a real
      // flag pair, and only between the leading flags and the
      // `--system-prompt` argument. The preamble legitimately
      // mentions `--model` in worked examples (e.g. `branch
      // self ... --agent claude --model opus-5`), so a plain
      // `tokens.includes("--model")` would trip on those when the
      // bash script joins `$*` with spaces. Restrict the check to
      // the flag section before `--system-prompt`: if a real
      // `--model` flag landed, it sits there.
      const sysPromptIdx = tokens.indexOf("--system-prompt");
      const flagSection =
        sysPromptIdx >= 0 ? tokens.slice(0, sysPromptIdx) : tokens;
      const modelIdx = flagSection.indexOf("--model");
      const flagIsReal =
        modelIdx >= 0 &&
        modelIdx + 1 < flagSection.length &&
        !flagSection[modelIdx + 1].startsWith("--");
      assert.ok(
        !flagIsReal,
        `resume must not apply Settings defaultModel, got argv: ${argv}`
      );
    }
  );
});

/*
 * Issue #353: cross-session parent plumbing. The CLI passes `parentId` on
 * the POST body (or as `--parent self`, which the CLI resolves to the
 * calling session via $CONTROLLER_SESSION_ID before the request). The
 * server must:
 *   1. Persist `parentId` on the new session file when present, and
 *      *omit* the field when absent (so the absence is meaningful on
 *      read — coordinators filter `parentId === <self>` client-side).
 *   2. Leave the existing `parentId` alone on the resume path. A later
 *      `--parent` flag on a queue-replay must not re-parent a session.
 *   3. Stamp `CONTROLLER_SESSION_ID` on the agent's env when the
 *      session id is known at spawn time (i.e. on the resume path).
 *      On the brand-new-session path the id isn't known yet — it's
 *      assigned on the agent's first `run.started` event — so the
 *      env var is omitted and the CLI's `--parent self` surfaces a
 *      clear "env var missing" error if the agent tries to spawn
 *      a child before learning its own id.
 *
 * These tests stand up the real `sessionsRouter` so the headless POST
 * endpoint runs through the same `handleSessionStream` code path the
 * composer's SSE call uses, and inspect the persisted session file +
 * the agent's recorded env to lock the contract in.
 */

test("POST /api/projects/:projectId/sessions persists parentId on the session file when supplied (issue #353)", async () => {
  const sessionId = "sess-issue-353-child";
  const parentId = "sess-issue-353-parent";
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
          message: "Spawn a child session.",
          provider: "anita",
          parentId,
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId);

      const { projectStoreDir } = await import("../../lib/paths.js");
      const sessionFile = path.join(
        projectStoreDir(projectPath),
        "sessions",
        `${sessionId}.json`
      );
      const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
      // The `parentId` round-trips through the headless POST endpoint
      // → `handleSessionStream` → `persistSessionStart` → `saveSession`
      // and lands on the session file as a literal field. The CLI's
      // `sessions list --parent <id>` filter reads it back from here.
      assert.equal(
        session.parentId,
        parentId,
        `parentId should be persisted on the session file, got: ${JSON.stringify(session)}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions omits parentId on the session file when not supplied (issue #353)", async () => {
  const sessionId = "sess-issue-353-no-parent";
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
          message: "Start a session with no parent.",
          provider: "anita",
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId);

      const { projectStoreDir } = await import("../../lib/paths.js");
      const sessionFile = path.join(
        projectStoreDir(projectPath),
        "sessions",
        `${sessionId}.json`
      );
      const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
      // The field must be *absent*, not set to `null` or `""`. The
      // CLI's filter is `row.parentId === parentId` — a stored
      // `parentId: ""` would never match a real id, and a stored
      // `parentId: null` would be a surprise for downstream readers.
      assert.ok(
        !Object.prototype.hasOwnProperty.call(session, "parentId"),
        `parentId should be absent from the session file when not supplied, got: ${JSON.stringify(session)}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions preserves an existing parentId on resume (issue #353)", async () => {
  // A queue-replay POST that includes BOTH `resumeSessionId` (the
  // session being replayed) and a different `parentId` (e.g. the
  // agent was re-spawned from a different coordinator) must not
  // re-parent the existing session. The new-session-only path in
  // `persistSessionStart` gates `parentId` writes on `!existing`,
  // so a later `--parent` flag is a no-op for resumed sessions.
  const sessionId = "sess-issue-353-resume";
  const originalParentId = "sess-issue-353-original-parent";
  const attemptedParentId = "sess-issue-353-attempted-reparent";
  await withSessionStartEnv(
    async ({ binDir, projectPath }) => {
      await installFakeAgent(binDir, sessionId);
      // Pre-seed the session file as if it had been created by a
      // previous `start` call with `parentId: originalParentId`.
      // `persistSessionStart` will read this with `getSession` and
      // see `existing`, which gates the `parentId` write.
      const { projectStoreDir } = await import("../../lib/paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionsDir = path.join(storeDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
      await fs.writeFile(
        sessionFile,
        JSON.stringify({
          id: sessionId,
          title: "Pre-existing session",
          workingDirectory: projectPath,
          worktreeId: "wt-main", // overwritten on resume
          model: "",
          provider: "anita",
          mode: "default",
          messages: [],
          parentId: originalParentId,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
          status: "active",
        })
      );
    },
    async ({ baseUrl, worktreeId, projectPath }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Resume an already-parented session.",
          provider: "anita",
          resumeSessionId: sessionId,
          // Different value — must NOT overwrite the existing parentId.
          parentId: attemptedParentId,
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, sessionId);

      // Re-read the same session file and assert the original parentId
      // is intact.
      const { projectStoreDir } = await import("../../lib/paths.js");
      const sessionFile = path.join(
        projectStoreDir(projectPath),
        "sessions",
        `${sessionId}.json`
      );
      const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
      assert.equal(
        session.parentId,
        originalParentId,
        `existing parentId must be preserved on resume, got: ${JSON.stringify(session)}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions does NOT inject CONTROLLER_SESSION_ID on the brand-new-session path (issue #353)", async () => {
  // Brand-new sessions get their id from the agent's first `run.started`
  // event, so the orchestrator doesn't know the id at spawn time. The
  // env var is omitted so a `--parent self` invocation in the child
  // surfaces a clear "env var missing" error and the agent uses
  // `controller sessions list` to learn its own id instead. Stamping
  // an empty string would make the CLI think the env was set to an
  // invalid id and surface a less actionable error.
  const sessionId = "sess-issue-353-no-env-var";
  await withSessionStartEnv(
    async ({ binDir, homeDir }) => {
      // Shim dumps the entire env at spawn time. The orchestrator
      // passes `env` to `provider.spawn`; `provider.spawn` hands it
      // to `child_process.spawn`; the bash script inherits it.
      const script = `#!/usr/bin/env bash
set -e
# Record the orchestrator-injected env (issue #353). We dump the
# whole env so the test can assert presence/absence of specific
# keys without re-tokenizing a flattened string.
env > "${homeDir}/spawned-env.txt"
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
          message: "Brand-new session, no resumeSessionId.",
          provider: "anita",
          // Include parentId to prove the brand-new env-var rule
          // applies regardless of whether a parent was supplied.
          parentId: "sess-issue-353-parent",
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);

      const envText = await fs.readFile(path.join(homeDir, "spawned-env.txt"), "utf-8");
      // Parse `env`-style `KEY=VALUE` lines. The dump uses no
      // quoting because bash's `env` builtin renders each var on
      // its own line; values with newlines are rare here and we
      // only care about presence/absence of `CONTROLLER_SESSION_ID`.
      const envLines = envText.split("\n");
      const sessionIdLine = envLines.find((line) =>
        line.startsWith("CONTROLLER_SESSION_ID=")
      );
      assert.equal(
        sessionIdLine,
        undefined,
        `CONTROLLER_SESSION_ID must be absent for brand-new sessions, got env line: ${sessionIdLine}\nfull env:\n${envText}`
      );
    }
  );
});

test("POST /api/projects/:projectId/sessions injects CONTROLLER_SESSION_ID on the resume path (issue #353)", async () => {
  // The resume path already knows the session id (it came from the
  // persisted `resumeSessionId`). The orchestrator stamps it on the
  // agent's env so a `--parent self` invocation in the resumed
  // agent resolves to its own id without first looking itself up
  // in `controller sessions list`. Without this, the coordinator
  // pattern from #351 can't reliably spawn children of resumed
  // sessions.
  const sessionId = "sess-issue-353-resume-with-env";
  await withSessionStartEnv(
    async ({ binDir, homeDir }) => {
      const script = `#!/usr/bin/env bash
set -e
env > "${homeDir}/spawned-env.txt"
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
          message: "Resume an existing session.",
          provider: "anita",
          resumeSessionId: sessionId,
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);

      const envText = await fs.readFile(path.join(homeDir, "spawned-env.txt"), "utf-8");
      const envLines = envText.split("\n");
      const sessionIdLine = envLines.find((line) =>
        line.startsWith("CONTROLLER_SESSION_ID=")
      );
      assert.ok(
        sessionIdLine,
        `CONTROLLER_SESSION_ID must be present on the resume path, got env:\n${envText}`
      );
      assert.equal(
        sessionIdLine,
        `CONTROLLER_SESSION_ID=${sessionId}`,
        `CONTROLLER_SESSION_ID should equal the resumeSessionId, got: ${sessionIdLine}`
      );
    }
  );
});

test("GET /api/projects/:projectId/sessions sets Cache-Control: no-store so the sidebar re-fetches after a new session starts", async () => {
  // Regression test: without `Cache-Control: no-store`, `res.json()`'s
  // auto-ETag makes the browser (or Electron) reply `304 Not Modified`
  // on soft refreshes, and the sidebar keeps rendering the pre-spawn
  // session list. The result: a freshly-started session is invisible
  // under the worktree in the sidebar even though the focus queue
  // (which has its own refetch path) sees it. The endpoint must opt
  // out of caching so the sidebar always re-reads the worktree's
  // current session list.
  const sessionId = "sess-issue-cache-header";
  await withSessionStartEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, sessionId);
    },
    async ({ baseUrl, worktreeId }) => {
      const res = await fetch(`${baseUrl}/sessions?worktreeId=${worktreeId}`);
      assert.equal(res.status, 200);
      // `no-store` is the strictest of the no-cache directives — it
      // tells the browser to neither cache the response nor store it
      // anywhere. That's the right call here because the session list
      // changes every time an agent run starts in the worktree.
      assert.equal(
        res.headers.get("cache-control"),
        "no-store",
        `Cache-Control: no-store is required so the sidebar re-fetches after a new session starts, got: ${res.headers.get("cache-control")}`
      );
    }
  );
});

/*
 * Issue #390: a codex session that took the `streamCodexPlanSession`
 * (long-lived `codex app-server`) path on its first turn must continue
 * via the same path when the user attaches an image — falling back to
 * `codex exec resume … --image` against the still-alive app-server
 * fails immediately with `thread <id> already has an active writer
 * (code -32600)` because the app-server holds the per-thread writer
 * lock. The route's condition at `server/routes/sessions.ts:1407` was
 * the gate; the tests below pin both halves of the new behavior:
 *
 *   1. **Resumed codex session + attachment → `codex app-server` path.**
 *      The pre-existing session file is enough to make the route treat
 *      the request as a resume (so `resumeSessionId` is set in the
 *      branch the route sees). The fake `codex` records its argv and
 *      implements the JSON-RPC handshake the app-server path expects
 *      so the test exercises the real end-to-end pipeline.
 *
 *   2. **Brand-new codex session + attachment → `codex exec resume`
 *      path.** No pre-existing session file, no `resumeSessionId` —
 *      the legacy fallback is still correct here because no app-server
 *      lock exists yet to compete for. This pins the other half of the
 *      fix so we don't accidentally route brand-new sessions through
 *      the app-server path (which would force every codex turn onto
 *      the long-lived process before the user has any history to
 *      resume against).
 */

interface FakeCodexOptions {
  argvFile: string;
  /** sessionId echoed in the agent's `run.started` JSONL line / app-server `thread/started` event. */
  sessionId: string;
}

/**
 * Stand up a fake `codex` binary on PATH that:
 *   - records its argv (newline-joined) to `argvFile` so the test can
 *     distinguish `codex app-server …` from `codex exec resume …`;
 *   - when invoked as `codex app-server`, speaks just enough
 *     newline-delimited JSON-RPC to satisfy the orchestrator's
 *     `codexAppServerManager.startPlanTurn` flow (`initialize`,
 *     `thread/resume`, `turn/start` + a `thread/started` event +
 *     `turn/completed` event so the SSE handler exits cleanly);
 *   - when invoked as `codex exec …`, emits one `run.started` JSONL
 *     line followed by `run.completed`, like the existing
 *     `installFakeAgent` helper.
 *
 * Writing it in Node keeps the JSON-RPC parsing honest — a bash script
 * would need a hand-rolled line reader and the tests would be harder
 * to read.
 */
async function installFakeCodex(
  binDir: string,
  options: FakeCodexOptions
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argvFile = ${JSON.stringify(options.argvFile)};
const sessionId = ${JSON.stringify(options.sessionId)};

// Record the spawned argv for the test to assert against. Joined with
// spaces so a single \`fs.readFileSync\` produces a grep-friendly
// string ("exec", "app-server", "resume <id>", "--image PATH").
fs.writeFileSync(argvFile, process.argv.slice(2).join(" ") + "\\n");

const isAppServer = process.argv.includes("app-server");

if (isAppServer) {
  // Speak JSON-RPC over stdio. The orchestrator sends requests as
  // newline-delimited JSON; we reply with the matching id and a
  // minimal \`result\` payload, then emit a \`thread/started\` server
  // notification and a \`turn/completed\` notification so the route's
  // SSE handler reaches its \`run.completed\` path and exits cleanly.
  let buffered = "";
  let nextId = 1;
  const threadsById = new Map();

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\\n");
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let nl;
    while ((nl = buffered.indexOf("\\n")) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof req.id !== "undefined" && req.method) {
        if (req.method === "initialize") {
          reply(req.id, {});
        } else if (req.method === "thread/resume") {
          const requested = req.params && req.params.threadId;
          threadsById.set(requested, { id: requested });
          reply(req.id, { thread: { id: requested } });
          // Emit the lifecycle event the parser turns into \`run.started\`.
          send({ jsonrpc: "2.0", method: "thread/started", params: { threadId: requested } });
        } else if (req.method === "turn/start") {
          const turnId = "turn-" + nextId++;
          reply(req.id, { turn: { id: turnId } });
          // Emit the lifecycle event the parser turns into \`run.completed\`.
          const threadId = req.params && req.params.threadId;
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "completed" },
            },
          });
        } else {
          reply(req.id, {});
        }
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  // Legacy \`codex exec …\` shape: newline-delimited JSON events on
  // stdout. The orchestrator's \`mapCodexEvent\` (\`server/lib/agents.ts\`)
  // translates \`thread.started\` → \`run.started\` and \`turn.completed\`
  // → \`run.completed\`, so the legacy fake emits the codex-native event
  // names — not the normalized ones anita uses. Mirrors
  // \`installFakeAgent()\`'s shape so the SSE handler's close path
  // (which only emits a synthetic \`run.failed\` on non-zero exit) sees
  // a clean two-event run.
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sessionId, timestamp: "2026-01-01T00:00:00.000Z" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", timestamp: "2026-01-01T00:00:00.000Z" }) + "\\n");
  process.exit(0);
}
`;
  await fs.writeFile(path.join(binDir, "codex"), script, { mode: 0o755 });
}

async function saveImageAttachment(
  projectPath: string,
  id: string
): Promise<void> {
  // The route resolves attachment ids via
  // \`server/lib/sessions.ts#saveAttachment\`, which writes the file
  // to \`<controllerHome>/projects/<id>/attachments/<attId>/<name>\`
  // and a sidecar \`metadata.json\` containing the path + \`isImage\`.
  // We only need \`isImage: true\` for this test — the path can be a
  // tiny PNG-equivalent placeholder; the route hands the path to the
  // agent, the agent never opens it.
  const { saveAttachment } = await import("../../lib/sessions.js");
  await saveAttachment(
    projectPath,
    {
      id,
      name: "image.png",
      mimeType: "image/png",
      size: 16,
      path: "", // overwritten by saveAttachment
      isImage: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    Buffer.from("fake-png-bytes-1234")
  );
}

test("issue #390: resumed codex session with attachment goes through the codex app-server path (not codex exec)", async () => {
  // Regression: before #390, the route at
  // \`server/routes/sessions.ts:1407\` only used the app-server path
  // when \`attachments.length === 0\`. As soon as the user attached
  // an image, the route fell back to spawning \`codex exec resume
  // <id> <prompt> --image PATH\`. That \`codex exec\` was rejected by
  // codex with "thread already has an active writer (code -32600)"
  // because the long-lived app-server still held the per-thread writer
  // lock from the prior turn. The fix routes resumed sessions through
  // the app-server path regardless of attachments.
  const sessionId = "sess-issue-390-resume-with-image";
  const attachmentId = "att-issue-390-image";
  await withSessionStartEnv(
    async ({ binDir, homeDir, projectPath }) => {
      await installFakeCodex(binDir, { argvFile: path.join(homeDir, "codex-argv.txt"), sessionId });
      // Point the codex provider at our fake. The default
      // \`resolveAgentCommand\` walks PATH, but the test's
      // \`process.env.PATH\` change above already covers that — no
      // \`agents.json\` override needed.
      await saveImageAttachment(projectPath, attachmentId);

      // Pre-seed the session file as a previously-running codex
      // session. The route's \`getSession\` lookup at line 1251 must
      // find it so \`resumeSessionId\` stays set after the
      // unstarted/providerThreadId branch (line 1253). Without this
      // file the route would treat the request as brand-new and never
      // take either branch we're trying to pin.
      const { projectStoreDir } = await import("../../lib/paths.js");
      const sessionsDir = path.join(projectStoreDir(projectPath), "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          title: "Pre-existing codex session",
          workingDirectory: projectPath,
          worktreeId: "wt-main",
          model: "",
          provider: "codex",
          mode: "default",
          messages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
          status: "active",
        })
      );
    },
    async ({ baseUrl, worktreeId, homeDir }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Here's an image to look at.",
          provider: "codex",
          resumeSessionId: sessionId,
          attachmentIds: [attachmentId],
        }),
      });
      // The shim returns 200 + { sessionId, url } once the agent's
      // first run.started-equivalent event lands. Both codex paths
      // surface that event, so a 200 here only confirms the request
      // reached the spawn step — the argv file below is what pins
      // which path was taken.
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(
        res.status,
        200,
        `expected 200, got ${res.status}: ${JSON.stringify(body)}`
      );

      const argv = (await fs.readFile(path.join(homeDir, "codex-argv.txt"), "utf-8")).trim();
      assert.ok(
        argv.includes("app-server"),
        `resumed codex session with attachment must use the app-server path; got argv: ${argv}`
      );
      assert.ok(
        !argv.includes("exec"),
        `resumed codex session must not fall back to codex exec (writer-lock conflict, issue #390); got argv: ${argv}`
      );
    }
  );
});

test("issue #390: brand-new codex session with attachment still uses the legacy codex exec path", async () => {
  // The other half of the fix: a brand-new codex turn (no
  // \`resumeSessionId\`) must keep using \`codex exec …\`. There's no
  // app-server lock yet to compete for, so spawning the short-lived
  // exec process is the right call — the app-server path would force
  // every codex turn onto the long-lived process from turn 1, which
  // is a bigger behavior change than #390 is asking for. Pinning this
  // here means a future "always use app-server" refactor has to
  // explicitly opt in to changing it.
  const sessionId = "sess-issue-390-brand-new-with-image";
  const attachmentId = "att-issue-390-image-2";
  await withSessionStartEnv(
    async ({ binDir, homeDir, projectPath }) => {
      await installFakeCodex(binDir, { argvFile: path.join(homeDir, "codex-argv.txt"), sessionId });
      await saveImageAttachment(projectPath, attachmentId);
    },
    async ({ baseUrl, worktreeId, homeDir }) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Here's an image to look at.",
          provider: "codex",
          // No resumeSessionId — brand-new thread.
          attachmentIds: [attachmentId],
        }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      assert.equal(
        res.status,
        200,
        `expected 200, got ${res.status}: ${JSON.stringify(body)}`
      );

      const argv = (await fs.readFile(path.join(homeDir, "codex-argv.txt"), "utf-8")).trim();
      assert.ok(
        argv.startsWith("exec") || argv.includes(" exec "),
        `brand-new codex session with attachment must use codex exec; got argv: ${argv}`
      );
      assert.ok(
        !argv.includes("app-server"),
        `brand-new codex session must not use app-server (issue #390); got argv: ${argv}`
      );
    }
  );
});
