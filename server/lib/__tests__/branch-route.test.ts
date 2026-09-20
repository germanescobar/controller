import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #382: `POST /api/projects/:projectId/sessions/branch` branches an
 * existing session into a brand-new one **without spawning an agent**.
 *
 * This is a redesign of the #364 / #380 / #381 route, which always
 * started a provider turn at branch time purely so the new session id
 * had provider backing — the visible side effect was an empty agent
 * reply the moment the user clicked the branch icon. The new route
 * returns synchronously and the *first real turn* the user types is
 * what starts a provider thread; the session file's `providerThreadId`
 * bridges the Controller-chosen UUID (URL / events-file key) to the
 * provider's own thread id (what `--resume` needs).
 *
 * Covered here:
 *   1. Happy path — synchronous 200, Controller UUID, `unstarted: true`,
 *      unlocked pickers (no provider/model copied), `parentId` linkage,
 *      events file = source events + branch marker.
 *   2. `--title` override / auto-derived "Branch of <sourceTitle>".
 *   3. Unknown source -> 404; missing `sourceSessionId` -> 400.
 *   4. Empty source -> events file holds just the branch marker.
 *   5. First real turn on a branched session: no `--resume` is passed
 *      to the provider (fresh thread), the source transcript is inlined
 *      into the prompt, the provider's thread id is captured as
 *      `providerThreadId`, events land under the Controller UUID, and
 *      `unstarted` is cleared.
 *   6. Second turn: the provider IS resumed, on `providerThreadId` —
 *      not on the Controller UUID — while events keep landing under the
 *      Controller UUID.
 */

async function withBranchEnv<T>(
  setup: (ctx: {
    projectPath: string;
    worktreePath: string;
    homeDir: string;
    binDir: string;
    worktreeId: string;
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
  // resolves to our script on the first-turn tests.
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });

  // Initialize a real git repo so `ensureMainWorktree` doesn't blow up.
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

  // Resolve (and lazily create) the main worktree before `setup` runs
  // so seeded sessions can carry a real `worktreeId`, exactly as a
  // session written by the orchestrator would.
  const { getProjectWorktrees } = await import("../../lib/worktrees.js");
  const mainWorktree = (await getProjectWorktrees(projectId)).find(
    (w) => w.isMain
  );
  if (!mainWorktree) throw new Error("main worktree not found in registry");

  await setup({
    projectPath,
    worktreePath: projectPath,
    homeDir,
    binDir,
    worktreeId: mainWorktree.id,
  });

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
    return await fn({
      projectId,
      worktreeId: mainWorktree.id,
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
      else
        reject(
          new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`)
        );
    });
    child.on("error", reject);
  });
}

/**
 * Stand up a fake `anita` on PATH that appends its full argv to
 * `argv.txt` before emitting `run.started` + `run.completed`. The argv
 * dump is how the first-turn tests read back whether `--resume` was
 * passed and what prompt the agent actually saw.
 */
async function installFakeAgent(
  binDir: string,
  homeDir: string,
  sessionId: string
): Promise<string> {
  const argvPath = path.join(homeDir, "argv.txt");
  const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' "<<<ARGV>>> $*" >> "${argvPath}"
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
cat >/dev/null || true
exit 0
`;
  await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });
  return argvPath;
}

/** Read back the per-invocation argv lines the fake agent appended. */
async function readArgvInvocations(argvPath: string): Promise<string[]> {
  const raw = await fs.readFile(argvPath, "utf-8");
  return raw
    .split("<<<ARGV>>>")
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

const SOURCE_ID = "sess-source-382";

/**
 * Seed a source session with three turns. The branch route copies the
 * events file verbatim and the `messages` array onto the new session.
 */
async function seedSourceSession(
  env: {
    projectPath: string;
    worktreeId: string;
    projectId: string;
  },
  options: { messages?: unknown[]; events?: unknown[] } = {}
): Promise<string> {
  const { projectStoreDir } = await import("../paths.js");
  const storeDir = projectStoreDir(env.projectPath);
  const sessionsDir = path.join(storeDir, "sessions");
  const eventsDir = path.join(storeDir, "events");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(eventsDir, { recursive: true });
  const now = new Date().toISOString();
  const messages = options.messages ?? [
    { type: "message", role: "user", content: "First user turn", timestamp: now },
    {
      type: "message",
      role: "assistant",
      content: "First assistant reply",
      timestamp: now,
    },
    { type: "message", role: "user", content: "Second user turn", timestamp: now },
  ];
  const events =
    options.events ??
    [
      { type: "user_message", data: { text: "First user turn" } },
      { type: "assistant_response", data: { text: "First assistant reply" } },
      { type: "user_message", data: { text: "Second user turn" } },
    ].map((e, i) => ({
      id: `evt-source-${i + 1}`,
      sessionId: SOURCE_ID,
      timestamp: now,
      ...e,
    }));
  await fs.writeFile(
    path.join(sessionsDir, `${SOURCE_ID}.json`),
    JSON.stringify(
      {
        id: SOURCE_ID,
        title: "Source session",
        workingDirectory: env.projectPath,
        worktreeId: env.worktreeId,
        projectId: env.projectId,
        provider: "codex",
        model: "codex/gpt-5",
        mode: "default",
        messages,
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(eventsDir, `${SOURCE_ID}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n")
  );
  return SOURCE_ID;
}

async function readJsonl(file: string): Promise<Record<string, any>[]> {
  const raw = await fs.readFile(file, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readSessionFile(
  projectPath: string,
  sessionId: string
): Promise<Record<string, any>> {
  const { projectStoreDir } = await import("../paths.js");
  return JSON.parse(
    await fs.readFile(
      path.join(projectStoreDir(projectPath), "sessions", `${sessionId}.json`),
      "utf-8"
    )
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("POST /sessions/branch returns synchronously without spawning an agent (issue #382)", async () => {
  await withBranchEnv(
    async ({ projectPath, worktreeId, binDir, homeDir }) => {
      // Install the fake agent anyway so a regression that *does*
      // spawn one is visible as an argv file rather than a hang.
      await installFakeAgent(binDir, homeDir, "sess-should-not-run");
      await seedSourceSession({ projectPath, worktreeId, projectId: "proj-1" });
    },
    async ({ baseUrl, projectPath, homeDir, worktreeId }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionId: SOURCE_ID }),
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
      // The id is a Controller-chosen UUID, not a provider thread id —
      // that's the whole point of #382. No agent ran.
      assert.match(body.sessionId ?? "", UUID_RE);
      assert.match(body.url ?? "", new RegExp(`session/${body.sessionId}$`));
      await assert.rejects(
        fs.readFile(path.join(homeDir, "argv.txt"), "utf-8"),
        /ENOENT/,
        "the branch route must not spawn an agent"
      );

      const session = await readSessionFile(projectPath, body.sessionId!);
      assert.equal(session.id, body.sessionId);
      assert.equal(session.worktreeId, worktreeId);
      assert.equal(session.parentId, SOURCE_ID);
      assert.equal(session.title, "Branch of Source session");
      // `unstarted` keeps the composer's pickers unlocked, and the
      // source's provider/model/mode are deliberately NOT copied —
      // picking a different agent is why you branch.
      assert.equal(session.unstarted, true);
      assert.equal(session.model, "");
      assert.equal(session.provider, undefined);
      assert.equal(session.mode, undefined);
      // `messages` = source transcript + branch marker; this array is
      // what `handleSessionStream` renders into the first-turn prompt.
      assert.equal(session.messages.length, 4);
      assert.match(
        session.messages[3].text,
        new RegExp(`^\\[/branch: Source session\\] controller://.*${SOURCE_ID}$`)
      );

      const { projectStoreDir } = await import("../paths.js");
      const events = await readJsonl(
        path.join(
          projectStoreDir(projectPath),
          "events",
          `${body.sessionId}.jsonl`
        )
      );
      assert.equal(
        events.length,
        4,
        `expected 3 source events + 1 branch marker; got ${events.length}`
      );
      assert.equal(events[0].data.text, "First user turn");
      assert.equal(events[3].type, "user_message");
      assert.equal(events[3].data.text, session.messages[3].text);
    }
  );
});

test("POST /sessions/branch honors a title override (issue #382)", async () => {
  await withBranchEnv(
    async ({ projectPath, worktreeId }) => {
      await seedSourceSession({ projectPath, worktreeId, projectId: "proj-1" });
    },
    async ({ baseUrl, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: SOURCE_ID,
          title: "  Try this on Opus  ",
        }),
      });
      const body = (await response.json()) as { sessionId?: string };
      assert.equal(response.status, 200);
      const session = await readSessionFile(projectPath, body.sessionId!);
      assert.equal(session.title, "Try this on Opus");
    }
  );
});

test("POST /sessions/branch rejects an unknown or missing source (issue #382)", async () => {
  await withBranchEnv(
    async ({ projectPath, worktreeId }) => {
      await seedSourceSession({ projectPath, worktreeId, projectId: "proj-1" });
    },
    async ({ baseUrl }) => {
      const missing = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);
      assert.match(
        ((await missing.json()) as { error?: string }).error ?? "",
        /sourceSessionId is required/
      );

      const unknown = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionId: "sess-nope" }),
      });
      assert.equal(unknown.status, 404);
      assert.match(
        ((await unknown.json()) as { error?: string }).error ?? "",
        /Source session not found/
      );
    }
  );
});

test("POST /sessions/branch seeds an empty source with just the marker (issue #382)", async () => {
  await withBranchEnv(
    async ({ projectPath, worktreeId }) => {
      await seedSourceSession(
        { projectPath, worktreeId, projectId: "proj-1" },
        { messages: [], events: [] }
      );
    },
    async ({ baseUrl, projectPath }) => {
      const response = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionId: SOURCE_ID }),
      });
      const body = (await response.json()) as { sessionId?: string };
      assert.equal(response.status, 200);
      const { projectStoreDir } = await import("../paths.js");
      const events = await readJsonl(
        path.join(
          projectStoreDir(projectPath),
          "events",
          `${body.sessionId}.jsonl`
        )
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "user_message");
      assert.match(events[0].data.text, /^\[\/branch: /);
    }
  );
});

test("first turn on a branched session starts a fresh provider thread and captures providerThreadId (issue #382)", async () => {
  // The regression this replaces: #381 spawned an agent at branch time
  // *because* a Controller-chosen UUID had no provider thread to
  // `--resume`. The fix is to not resume at all on the first turn —
  // the provider starts fresh, gets the source transcript inlined into
  // its prompt, and its own thread id is stashed on the session file.
  const providerThreadId = "provider-thread-abc";
  await withBranchEnv(
    async ({ projectPath, worktreeId, binDir, homeDir }) => {
      await installFakeAgent(binDir, homeDir, providerThreadId);
      await seedSourceSession({ projectPath, worktreeId, projectId: "proj-1" });
    },
    async ({ baseUrl, projectPath, homeDir, worktreeId }) => {
      const branchRes = await fetch(`${baseUrl}/sessions/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionId: SOURCE_ID }),
      });
      const branched = (await branchRes.json()) as { sessionId?: string };
      assert.equal(branchRes.status, 200);
      const controllerId = branched.sessionId!;

      // The user types their first turn. The composer sends the
      // Controller id as `resumeSessionId`, exactly as it does on any
      // other session.
      const turnRes = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worktreeId,
          message: "Review the proposal above",
          provider: "anita",
          resumeSessionId: controllerId,
        }),
      });
      const turnBody = (await turnRes.json()) as {
        sessionId?: string;
        error?: string;
      };
      assert.equal(
        turnRes.status,
        200,
        `expected the first turn to succeed; got ${turnRes.status}: ${JSON.stringify(turnBody)}`
      );
      // The response keeps the Controller id — the URL the user is
      // sitting on must not change out from under them.
      assert.equal(turnBody.sessionId, controllerId);

      const invocations = await readArgvInvocations(
        path.join(homeDir, "argv.txt")
      );
      assert.equal(invocations.length, 1, "exactly one agent run so far");
      assert.ok(
        !invocations[0].includes("--resume"),
        `first turn must start a fresh provider thread; argv was: ${invocations[0]}`
      );
      // The source transcript rides along in the prompt so the agent
      // actually knows what "the proposal above" refers to.
      assert.match(invocations[0], /First assistant reply/);
      assert.match(invocations[0], /Review the proposal above/);

      const session = await readSessionFile(projectPath, controllerId);
      assert.equal(
        session.providerThreadId,
        providerThreadId,
        "the provider's own thread id must be captured for later resumes"
      );
      assert.notEqual(
        session.unstarted,
        true,
        "unstarted must be cleared once the user has typed a turn"
      );

      // Events still land under the Controller id — never the provider's.
      const { projectStoreDir } = await import("../paths.js");
      const eventsDir = path.join(projectStoreDir(projectPath), "events");
      await assert.rejects(
        fs.readFile(path.join(eventsDir, `${providerThreadId}.jsonl`), "utf-8"),
        /ENOENT/,
        "no events file may be created under the provider thread id"
      );
      const events = await readJsonl(
        path.join(eventsDir, `${controllerId}.jsonl`)
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "user_message" &&
            e.data.text === "Review the proposal above"
        ),
        `expected the first turn's user_message; got: ${JSON.stringify(events.map((e) => e.type))}`
      );
    }
  );
});

test("second turn on a branched session resumes providerThreadId, not the Controller id (issue #382)", async () => {
  const providerThreadId = "provider-thread-xyz";
  await withBranchEnv(
    async ({ projectPath, worktreeId, binDir, homeDir }) => {
      await installFakeAgent(binDir, homeDir, providerThreadId);
      await seedSourceSession({ projectPath, worktreeId, projectId: "proj-1" });
    },
    async ({ baseUrl, projectPath, homeDir, worktreeId }) => {
      const branched = (await (
        await fetch(`${baseUrl}/sessions/branch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceSessionId: SOURCE_ID }),
        })
      ).json()) as { sessionId?: string };
      const controllerId = branched.sessionId!;

      for (const message of ["First real turn", "Second real turn"]) {
        const res = await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            worktreeId,
            message,
            provider: "anita",
            resumeSessionId: controllerId,
          }),
        });
        assert.equal(res.status, 200, `turn "${message}" should succeed`);
        await res.json();
      }

      const invocations = await readArgvInvocations(
        path.join(homeDir, "argv.txt")
      );
      assert.equal(invocations.length, 2);
      assert.match(
        invocations[1],
        new RegExp(`--resume ${providerThreadId}`),
        `second turn must resume the provider's thread; argv was: ${invocations[1]}`
      );
      assert.ok(
        !invocations[1].includes(`--resume ${controllerId}`),
        "the Controller UUID must never be handed to the provider as a resume target"
      );

      // `providerThreadId` survives the full-file rewrite `saveSession`
      // does on every turn — losing it would break turn three.
      const session = await readSessionFile(projectPath, controllerId);
      assert.equal(session.providerThreadId, providerThreadId);

      const { projectStoreDir } = await import("../paths.js");
      const events = await readJsonl(
        path.join(projectStoreDir(projectPath), "events", `${controllerId}.jsonl`)
      );
      for (const text of ["First real turn", "Second real turn"]) {
        assert.ok(
          events.some((e) => e.type === "user_message" && e.data.text === text),
          `expected a user_message event for "${text}"`
        );
      }
    }
  );
});
