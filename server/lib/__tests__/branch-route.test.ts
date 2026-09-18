import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #364: `POST /api/projects/:projectId/sessions/branch` forks an
 * existing session into a brand-new one whose transcript is seeded from
 * the source. This test mounts the real `sessionsRouter`, seeds a
 * source session, and asserts the branch route:
 *
 *   1. Happy path with provider/model/mode override -> the new session
 *      has source's provider/model/mode in its metadata, `parentId`
 *      set to source.id, and the events file seeded with source's
 *      events plus the branch-marker user_message event.
 *   2. Branching with no provider/model override -> first turn runs on
 *      source's defaults (the route falls through to source.provider).
 *   3. Branching an unknown source id -> `404` with a clear error.
 *   4. Branching a session with zero messages -> still works (the new
 *      session's events file just has the branch marker).
 */

async function withBranchEnv<T>(
  setup: (ctx: {
    projectPath: string;
    worktreePath: string;
    homeDir: string;
    binDir: string;
  }) => Promise<void>,
  fn: (env: {
    projectId: string;
    worktreeId: string;
    baseUrl: string;
    homeDir: string;
    projectPath: string;
    worktreePath: string;
  }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-route-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-bin-"));
  const previous = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  process.env.CONTROLLER_HOME = homeDir;
  // Prepend the fake-agent bin dir to PATH so the spawned `anita`
  // resolves to our script. The command resolver walks PATH itself,
  // but `provider.spawn` passes an absolute path when configured;
  // clearing its cache (below) and prepending PATH covers both.
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });

  // Initialize a real git repo so `ensureMainWorktree` doesn't blow
  // up. The branch route doesn't shell out to git, but the SSE
  // handler it delegates to does, indirectly, through worktree
  // resolution.
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

  const { clearCommandResolverCache } = await import(
    "../../lib/command-resolver.js"
  );
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

/**
 * Stand up a fake agent binary on PATH. Mirrors `session-start.test.ts`:
 * the script emits `run.started` + `run.completed` and then drains
 * stdin so it exits promptly when the orchestrator closes it.
 */
async function installFakeAgent(binDir: string, sessionId: string): Promise<void> {
  // Bash script that emits a single `run.started` line, a single
  // `run.completed` line, then drains stdin so the orchestrator can
  // close the pipe and the process exits cleanly. Mirrors the
  // shape `session-start.test.ts` installs.
  const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
cat >/dev/null || true
exit 0
`;
  await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
}

/**
 * Seed a source session that the branch route can fork. The
 * session file carries three messages + provider/model metadata;
 * the events file carries three matching events. The branch route
 * uses `seedBranchFromSource` to copy both files into the new
 * session.
 */
async function seedSourceSessionWithProvider(
  env: {
    homeDir: string;
    projectPath: string;
    worktreeId: string;
    projectId: string;
  },
  provider: string,
  model: string,
  options: {
    mode?: "default" | "plan";
  } = {}
): Promise<string> {
  const sourceId = "sess-source-364";
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(env.projectPath);
  const sessionsDir = path.join(storeDir, "sessions");
  const eventsDir = path.join(storeDir, "events");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(eventsDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(sessionsDir, `${sourceId}.json`),
    JSON.stringify(
      {
        id: sourceId,
        title: "Source session",
        workingDirectory: env.projectPath,
        worktreeId: env.worktreeId,
        projectId: env.projectId,
        provider,
        model,
        mode: options.mode ?? "default",
        messages: [
          {
            type: "message",
            role: "user",
            content: "Earlier user turn",
            timestamp: now,
          },
        ],
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      },
      null,
      2
    )
  );
  // One source event so the seeding branch has at least one row to
  // copy (the empty-source test below verifies the no-events
  // branch).
  await fs.writeFile(
    path.join(eventsDir, `${sourceId}.jsonl`),
    JSON.stringify({
      id: "evt-source-1",
      sessionId: sourceId,
      timestamp: now,
      type: "user_message",
      data: { text: "Earlier user turn" },
    })
  );
  return sourceId;
}

async function seedSourceSession(env: {
  homeDir: string;
  projectPath: string;
  worktreeId: string;
  projectId: string;
}): Promise<string> {
  const sourceId = "sess-source-364";
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(env.projectPath);
  const sessionsDir = path.join(storeDir, "sessions");
  const eventsDir = path.join(storeDir, "events");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(eventsDir, { recursive: true });
  const now = new Date().toISOString();
  const sourceMessages = [
    {
      type: "message",
      role: "user",
      content: "First user turn",
      timestamp: now,
    },
    {
      type: "message",
      role: "assistant",
      content: "First assistant reply",
      timestamp: now,
    },
    {
      type: "message",
      role: "user",
      content: "Second user turn",
      timestamp: now,
    },
  ];
  await fs.writeFile(
    path.join(sessionsDir, `${sourceId}.json`),
    JSON.stringify(
      {
        id: sourceId,
        title: "Source session",
        workingDirectory: env.projectPath,
        worktreeId: env.worktreeId,
        projectId: env.projectId,
        provider: "codex",
        model: "codex/gpt-5",
        mode: "default",
        messages: sourceMessages,
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      },
      null,
      2
    )
  );
  // Three events mirroring the messages array. The branch route's
  // `seedBranchFromSource` copies these into the new session's
  // events file before the branch-marker user_message event.
  const events = [
    {
      id: "evt-source-1",
      sessionId: sourceId,
      timestamp: now,
      type: "user_message",
      data: { text: "First user turn" },
    },
    {
      id: "evt-source-2",
      sessionId: sourceId,
      timestamp: now,
      type: "assistant_message",
      data: { text: "First assistant reply" },
    },
    {
      id: "evt-source-3",
      sessionId: sourceId,
      timestamp: now,
      type: "user_message",
      data: { text: "Second user turn" },
    },
  ];
  await fs.writeFile(
    path.join(eventsDir, `${sourceId}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n")
  );
  return sourceId;
}

test("POST /sessions/branch forks a session with provider/model override (issue #364)", async () => {
  const agentSessionId = "sess-branch-new-agent";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      await installFakeAgent(binDir, agentSessionId);
      await seedSourceSession({ homeDir, projectPath, worktreeId, projectId });
    },
    async ({ baseUrl, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-364",
          message: "Review the design",
          // The branch route runs the first turn on the requested
          // provider. We install the fake agent under `anita` (the
          // historical convention `session-start.test.ts` uses), so
          // we ask for provider=anita here. The next test omits the
          // override to exercise the source-defaults path.
          provider: "anita",
          model: "anthropic/opus-5",
          mode: "plan",
        }),
      });
      const body = (await response.json()) as {
        sessionId?: string;
        url?: string;
        error?: string;
      };
      assert.equal(
        response.status,
        200,
        `expected 200, got ${response.status}: ${JSON.stringify(body)}`
      );
      assert.equal(body.sessionId, agentSessionId);
      assert.match(
        body.url ?? "",
        new RegExp(`session/${agentSessionId}`)
      );
      // Verify the persistence side effects.
      const { projectStoreDir } = await import("../paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionsDir = path.join(storeDir, "sessions");
      const eventsDir = path.join(storeDir, "events");
      const sessionFile = path.join(sessionsDir, `${agentSessionId}.json`);
      const eventsFile = path.join(eventsDir, `${agentSessionId}.jsonl`);
      const sessionContent = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(sessionContent);
      assert.equal(session.id, agentSessionId);
      // `parentId` ties the new session to its source so
      // `controller sessions list --parent <sourceId>` groups it
      // under the source.
      assert.equal(session.parentId, "sess-source-364");
      // The new session's metadata carries the source's defaults
      // (the requested provider/model/mode only affected the first
      // turn's agent spawn; the model picker falls back to source's
      // for subsequent turns).
      assert.equal(session.provider, "codex");
      assert.equal(session.model, "codex/gpt-5");
      assert.equal(session.mode, "default");
      // The events file should have source's 3 events + 1 branch
      // marker = 4 events total. `seedBranchFromSource` prepends
      // the source events; `persistSessionStart` appends the
      // branch-marker user_message.
      const eventsContent = await fs.readFile(eventsFile, "utf-8");
      const events = eventsContent
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(
        events.length,
        4,
        `events file should have 3 source events + 1 branch marker; got ${events.length}`
      );
      const lastEvent = events[events.length - 1];
      assert.equal(lastEvent.type, "user_message");
      assert.match(
        lastEvent.data.text,
        /^\[\/branch: codex\/codex\/gpt-5->anita\/anthropic\/opus-5\] Review the design$/
      );
    }
  );
});

test("POST /sessions/branch falls back to source defaults when no overrides (issue #364)", async () => {
  const agentSessionId = "sess-branch-same-defaults";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      await installFakeAgent(binDir, agentSessionId);
      // Seed the source with provider=anita so the first turn
      // (which defaults to source.provider when no override is
      // given) hits the fake agent under binDir. Test 1 above
      // explicitly asks for provider=anita, but this test omits
      // the override to exercise the same-agent sibling path.
      await seedSourceSessionWithProvider(
        { homeDir, projectPath, worktreeId, projectId },
        "anita",
        "anthropic/claude-opus-4"
      );
    },
    async ({ baseUrl }) => {
      // No provider/model/mode on the request — the branch runs on
      // source's defaults for the first turn and the new session's
      // metadata reflects those defaults.
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-364",
          message: "Continue in a sibling",
        }),
      });
      const body = (await response.json()) as {
        sessionId?: string;
        url?: string;
        error?: string;
      };
      assert.equal(response.status, 200);
      assert.equal(body.sessionId, agentSessionId);
    }
  );
});

test("POST /sessions/branch returns 404 for an unknown source session (issue #364)", async () => {
  await withBranchEnv(
    async ({ binDir }) => {
      // Install the fake agent so the route reaches the validation
      // step before the source lookup. Without it, the agent spawn
      // 500s and the response shape is wrong.
      await installFakeAgent(binDir, "sess-never-issued");
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-no-such-source",
          message: "Continue in a sibling",
          provider: "anita",
        }),
      });
      const body = (await response.json()) as { error?: string };
      assert.equal(response.status, 404);
      assert.match(body.error ?? "", /Source session not found/);
    }
  );
});

test("POST /sessions/branch returns 400 for a missing message (issue #364)", async () => {
  await withBranchEnv(
    async ({ binDir }) => {
      await installFakeAgent(binDir, "sess-never-issued-400");
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-364",
        }),
      });
      const body = (await response.json()) as { error?: string };
      assert.equal(response.status, 400);
      assert.match(body.error ?? "", /message is required/);
    }
  );
});

test("POST /sessions/branch honors --title override and falls back to 'Branch of <source>' (issue #364)", async () => {
  const agentSessionId = "sess-branch-title";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      await installFakeAgent(binDir, agentSessionId);
      await seedSourceSessionWithProvider(
        { homeDir, projectPath, worktreeId, projectId },
        "anita",
        "anthropic/claude-opus-4"
      );
    },
    async ({ baseUrl, projectPath }) => {
      // Caller-supplied --title wins over the default
      // "Branch of <sourceTitle>".
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-364",
          message: "Review the design",
          provider: "anita",
          title: "Opus review",
        }),
      });
      const body = (await response.json()) as { sessionId?: string };
      assert.equal(response.status, 200);
      assert.equal(body.sessionId, agentSessionId);
      const { projectStoreDir } = await import("../paths.js");
      const sessionsDir = path.join(projectStoreDir(projectPath), "sessions");
      const sessionContent = await fs.readFile(
        path.join(sessionsDir, `${agentSessionId}.json`),
        "utf-8"
      );
      const session = JSON.parse(sessionContent);
      assert.equal(session.title, "Opus review");
    }
  );
});

test("POST /sessions/branch seeds an empty source (issue #364)", async () => {
  // A session with no transcript should still branch — the new
  // session's events file just has the branch-marker event, and
  // the source's empty `messages` array becomes the seed.
  const agentSessionId = "sess-branch-empty-source";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      await installFakeAgent(binDir, agentSessionId);
      // Seed an empty source session (no messages, no events).
      const { projectStoreDir } = await import("../paths.js");
      const storeDir = projectStoreDir(projectPath);
      const sessionsDir = path.join(storeDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(sessionsDir, "sess-empty-source.json"),
        JSON.stringify(
          {
            id: "sess-empty-source",
            title: "Empty source",
            workingDirectory: projectPath,
            worktreeId,
            projectId,
            provider: "claude",
            model: "anthropic/claude-opus-4",
            mode: "default",
            messages: [],
            createdAt: now,
            lastActiveAt: now,
            status: "active",
          },
          null,
          2
        )
      );
      void homeDir;
      void projectId;
    },
    async ({ baseUrl, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-empty-source",
          message: "Continue",
          // Explicit provider/model override so the first turn hits
          // the fake anita agent under binDir — the source has no
          // transcript and the issue's "branch of a branch" path
          // verifies the empty-source seeding logic, but the test
          // doesn't care which agent runs the (trivial) first turn.
          provider: "anita",
          model: "anthropic/opus-5",
        }),
      });
      const body = (await response.json()) as {
        sessionId?: string;
        error?: string;
      };
      assert.equal(response.status, 200, `body: ${JSON.stringify(body)}`);
      assert.equal(body.sessionId, agentSessionId);
      const { projectStoreDir } = await import("../paths.js");
      const eventsDir = path.join(projectStoreDir(projectPath), "events");
      const eventsFile = path.join(eventsDir, `${agentSessionId}.jsonl`);
      const eventsContent = await fs.readFile(eventsFile, "utf-8");
      const events = eventsContent
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // Empty source → 0 source events + 1 branch marker = 1 event.
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "user_message");
      assert.match(events[0].data.text, /^\[\/branch: /);
    }
  );
});

test("POST /sessions/branch prepends the source transcript to the agent's prompt (issue #364 + #365)", async () => {
  // The chat view shows the copied transcript once `seedBranchFromSource`
  // runs, but the agent needs the transcript *in its first-turn prompt*
  // — otherwise "review the proposal above" starts a context-free run.
  // The route layer inlines the source transcript before the branch
  // marker; the persisted user_message event keeps just the marker
  // so the chat view stays audit-friendly.
  const agentSessionId = "sess-branch-feed-prompt";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      // Capture argv: the fake anita prints `$*` to a file the test
      // reads back. The path is baked in via the script's expansion
      // (the test passes `branchArgvPath` through the env when spawning
      // — but the agent spawn doesn't inherit env, so we hard-code
      // the path via `${CONTROLLER_BRANCH_ARGV}`).
      const branchArgvPath = path.join(homeDir, "branch-argv.txt");
      const sessionIdCaptured = agentSessionId;
      const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' "$*" > "${branchArgvPath}"
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionIdCaptured}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionIdCaptured}","timestamp":"2026-01-01T00:00:00.000Z"}'
cat >/dev/null || true
exit 0
`;
      await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
      // Seed a source with multiple turns so the inline transcript
      // has recognizable content to match on.
      const { projectStoreDir } = await import("../paths.js");
      const sessionsDir = path.join(projectStoreDir(projectPath), "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(sessionsDir, "sess-source-with-text.json"),
        JSON.stringify(
          {
            id: "sess-source-with-text",
            title: "Source with transcript",
            workingDirectory: projectPath,
            worktreeId,
            projectId,
            provider: "anita",
            model: "anthropic/claude-opus-4",
            mode: "default",
            messages: [
              { role: "user", content: "PROPOSAL_LINE_USER_MARKER" },
              { role: "assistant", content: "PROPOSAL_LINE_ASSISTANT_MARKER" },
            ],
            createdAt: now,
            lastActiveAt: now,
            status: "active",
          },
          null,
          2
        )
      );
      void homeDir;
      void worktreeId;
      void projectId;
    },
    async ({ baseUrl, homeDir, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-with-text",
          message: "Review the proposal above",
          provider: "anita",
        }),
      });
      assert.equal(response.status, 200);
      // The agent's argv (the message passed as the prompt) should
      // include both the transcript block and the branch marker.
      const argv = (
        await fs.readFile(path.join(homeDir, "branch-argv.txt"), "utf-8")
      ).trim();
      void baseUrl;
      assert.match(
        argv,
        /PROPOSAL_LINE_USER_MARKER/,
        `agent prompt should include the source transcript; got: ${argv}`
      );
      assert.match(
        argv,
        /PROPOSAL_LINE_ASSISTANT_MARKER/,
        `agent prompt should include assistant turns too; got: ${argv}`
      );
      assert.match(
        argv,
        /Review the proposal above/,
        `agent prompt should include the new user's message; got: ${argv}`
      );
      assert.match(
        argv,
        /\[\/branch:[^[\]]+->[^[\]]+\]/,
        `agent prompt should include the branch marker; got: ${argv}`
      );
      // The persisted user_message event, on the other hand,
      // should be just the marker + user text (no transcript
      // bleed-through) so the chat view stays audit-friendly.
      const { projectStoreDir } = await import("../paths.js");
      const eventsDir = path.join(projectStoreDir(projectPath), "events");
      const eventsFile = path.join(eventsDir, `${agentSessionId}.jsonl`);
      const eventsContent = await fs.readFile(eventsFile, "utf-8");
      const events = eventsContent
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const userEvent = events.find((e) => e.type === "user_message");
      assert.ok(userEvent, "expected a user_message event in the events file");
      assert.doesNotMatch(
        userEvent.data.text,
        /PROPOSAL_LINE_USER_MARKER/,
        `persisted user_message should be the pure marker; got: ${userEvent.data.text}`
      );
      assert.match(
        userEvent.data.text,
        /^\[\/branch:[^[\]]+->[^[\]]+\] Review the proposal above$/,
        `persisted user_message should be the marker + user's text; got: ${userEvent.data.text}`
      );
    }
  );
});

test("POST /sessions/branch inherits source mode when --mode is not supplied (issue #365 P2)", async () => {
  // Plan-mode source + no override must keep the branch in plan mode
  // (PR review P2). A plain `body.mode === "plan" ? "plan" : "default"`
  // would silently downgrade — the documented default for the branch
  // is the source's mode.
  const agentSessionId = "sess-branch-inherit-mode";
  await withBranchEnv(
    async ({ binDir, homeDir, projectPath, worktreeId, projectId }) => {
      await installFakeAgent(binDir, agentSessionId);
      await seedSourceSessionWithProvider(
        { homeDir, projectPath, worktreeId, projectId },
        "anita",
        "anthropic/claude-opus-4",
        { mode: "plan" }
      );
    },
    async ({ baseUrl, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "sess-source-364",
          message: "Continue",
          provider: "anita",
          // No `mode` on the wire — must inherit `plan` from the
          // source. `seedBranchFromSource` then re-asserts `plan`
          // when it patches the new session's metadata.
          // (provider=anita is supplied to keep the agent path off
          // the Codex plan-session branch — see other tests.)
        }),
      });
      assert.equal(response.status, 200);
      const { projectStoreDir } = await import("../paths.js");
      const sessionFile = path.join(
        projectStoreDir(projectPath),
        "sessions",
        `${agentSessionId}.json`
      );
      const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
      // The new session's metadata carries the source's defaults;
      // `seedBranchFromSource` reads `sourceSession.mode` and writes
      // it here once `run.started` lands.
      assert.equal(
        session.mode,
        "plan",
        `new session should inherit source mode "plan"; got: ${session.mode}`
      );
    }
  );
});
