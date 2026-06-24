import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #172: creating a worktree from the orchestrator should base off
 * `origin/<branch>` by default, falling back to the local ref when the
 * fetch fails or the remote tracking ref is unavailable. We mount the
 * router against a temp `CONTROLLER_HOME`, build a real git
 * repo with a fake `origin` remote, and exercise `POST /worktrees` over
 * real HTTP/SSE.
 *
 * The narrow-refspec test (#186 review feedback) covers clones created
 * with `--single-branch` (or any repo where the user has overridden
 * `remote.<name>.fetch`): in that case `git fetch origin <ref>` only
 * writes to `FETCH_HEAD`, so we have to read it directly.
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

interface CreateEnv {
  homeDir: string;
  projectId: string;
  projectPath: string;
  baseUrl: string;
}

/** Build a real git repo with a fake `origin` remote, then run `setup`. */
async function buildRepo(
  projectPath: string,
  setup: (ctx: { remoteUrl: string }) => Promise<void>
): Promise<void> {
  // Fake origin: a local bare repo we can push to and fetch from.
  const remoteDir = path.join(path.dirname(projectPath), "remote.git");
  await runGit(projectPath, ["init", "--bare", "--initial-branch=main", remoteDir]);

  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await runGit(projectPath, ["config", "commit.gpgsign", "false"]);
  await runGit(projectPath, ["remote", "add", "origin", remoteDir]);

  // Seed an initial commit on the local branch.
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);

  await setup({ remoteUrl: remoteDir });
}

/**
 * Advance a branch on the bare `origin` by cloning it into a separate
 * working directory, making commits there, and pushing back. The original
 * project repo remains untouched so `refs/heads/<branch>` and
 * `refs/remotes/origin/<branch>` end up pointing at different commits.
 */
async function advanceRemoteBranch(
  remoteUrl: string,
  branch: string,
  parent: { homeDir: string; name: string },
  message: string
): Promise<void> {
  const clonePath = path.join(parent.homeDir, parent.name);
  await fs.mkdir(clonePath, { recursive: true });
  await runGit(clonePath, ["init", "--initial-branch=main"]);
  await runGit(clonePath, ["config", "user.email", "test@example.com"]);
  await runGit(clonePath, ["config", "user.name", "Test"]);
  await runGit(clonePath, ["config", "commit.gpgsign", "false"]);
  await runGit(clonePath, ["remote", "add", "origin", remoteUrl]);
  await runGit(clonePath, ["fetch", "origin", branch]);
  await runGit(clonePath, ["checkout", "-b", branch, `origin/${branch}`]);
  await fs.writeFile(path.join(clonePath, `${parent.name}.txt`), `${message}\n`);
  await runGit(clonePath, ["add", `${parent.name}.txt`]);
  await runGit(clonePath, ["commit", "-m", message]);
  await runGit(clonePath, ["push", "origin", `HEAD:${branch}`]);
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

async function withCreateEnv<T>(
  setup: (ctx: { projectPath: string; homeDir: string }) => Promise<void>,
  fn: (env: CreateEnv) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-create-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
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
    ])
  );

  await setup({ projectPath, homeDir });

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}`;

  try {
    return await fn({ homeDir, projectId, projectPath, baseUrl });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function getTip(cwd: string, ref: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--verify", ref], { cwd });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() : null);
    });
    child.on("error", () => resolve(null));
  });
}

async function createWorktree(
  baseUrl: string,
  body: Record<string, unknown>
): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const res = await fetch(`${baseUrl}/worktrees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const events = (await readSse(res)) as Array<Record<string, unknown>>;
  return { status: res.status, events };
}

test("bases new worktree on origin/main when local main is behind", async () => {
  await withCreateEnv(async ({ projectPath, homeDir }) => {
    await buildRepo(projectPath, async ({ remoteUrl }) => {
      // Push the local commit so origin/main exists. Then advance origin/main
      // one commit ahead of local main via a separate clone, so origin's tip
      // is strictly newer than the project's local tip. Finally, fetch in
      // the project repo so the local remote-tracking ref reflects the new
      // tip — without this, `origin/main` here would still point at the old
      // commit and the precondition would silently hold (or fail).
      await runGit(projectPath, ["push", "-u", "origin", "main"]);
      await advanceRemoteBranch(remoteUrl, "main", { homeDir, name: "remote-tip" }, "remote-only-commit");
      await runGit(projectPath, ["fetch", "origin", "main"]);
      assert.notEqual(
        await getTip(projectPath, "main"),
        await getTip(projectPath, "origin/main"),
        "preconditions: local main should be behind origin/main"
      );
    });
  }, async ({ projectPath, baseUrl }) => {
    const { status, events } = await createWorktree(baseUrl, {
      name: "issue-172",
    });
    assert.equal(status, 200);
    const done = events.find((e) => e.type === "done");
    assert.ok(done, "expected a done event");
    assert.equal(done!.exitCode, 0);

    // The fetch log line should appear in the SSE stream.
    const allLog = events
      .filter((e) => e.type === "log")
      .map((e) => String(e.text ?? ""))
      .join("");
    assert.match(allLog, /git fetch origin main/);

    // The new worktree should be at origin/main's tip, not local main's tip.
    const newWorktreePath = path.join(
      process.env.CONTROLLER_HOME!,
      "worktrees",
      "proj-1",
      "issue-172"
    );
    const newTip = await getTip(newWorktreePath, "HEAD");
    const originTip = await getTip(projectPath, "origin/main");
    assert.equal(newTip, originTip, "worktree HEAD should match origin/main tip");
  });
});

test("explicit baseBranch is resolved against origin when it exists remotely", async () => {
  await withCreateEnv(async ({ projectPath, homeDir }) => {
    await buildRepo(projectPath, async ({ remoteUrl }) => {
      // Push main, create a feature branch locally + on origin, then
      // advance origin/feature one commit beyond the local tip. Finally,
      // fetch in the project repo so the local remote-tracking ref
      // reflects the new tip before the precondition check.
      await runGit(projectPath, ["push", "-u", "origin", "main"]);
      await runGit(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "feature-local.txt"), "local\n");
      await runGit(projectPath, ["add", "feature-local.txt"]);
      await runGit(projectPath, ["commit", "-m", "feature-local-commit"]);
      await runGit(projectPath, ["push", "-u", "origin", "feature"]);
      await advanceRemoteBranch(remoteUrl, "feature", { homeDir, name: "feature-remote" }, "feature-remote-commit");
      await runGit(projectPath, ["fetch", "origin", "feature"]);
      assert.notEqual(
        await getTip(projectPath, "feature"),
        await getTip(projectPath, "origin/feature"),
        "preconditions: local feature should be behind origin/feature"
      );
    });
  }, async ({ projectPath, baseUrl }) => {
    const { status, events } = await createWorktree(baseUrl, {
      name: "issue-172",
      branch: "wt-from-feature",
      baseBranch: "feature",
    });
    assert.equal(status, 200);
    assert.equal(events.find((e) => e.type === "done")?.exitCode, 0);

    // The fetch log line should appear even when the user passed an
    // explicit baseBranch — we always check the remote tip.
    const allLog = events
      .filter((e) => e.type === "log")
      .map((e) => String(e.text ?? ""))
      .join("");
    assert.match(allLog, /git fetch origin feature/);

    // The new worktree is at origin/feature's tip, not local feature's tip.
    const newTip = await getTip(
      path.join(
        process.env.CONTROLLER_HOME!,
        "worktrees",
        "proj-1",
        "issue-172"
      ),
      "HEAD"
    );
    const originFeatureTip = await getTip(projectPath, "origin/feature");
    assert.equal(newTip, originFeatureTip, "worktree should match origin/<baseBranch>");
  });
});

test("falls back to local ref when baseBranch does not exist on origin", async () => {
  await withCreateEnv(async ({ projectPath }) => {
    await buildRepo(projectPath, async () => {
      await runGit(projectPath, ["push", "-u", "origin", "main"]);
      // Create a local-only branch with no counterpart on origin.
      await runGit(projectPath, ["checkout", "-b", "local-only"]);
      await fs.writeFile(path.join(projectPath, "local.txt"), "local\n");
      await runGit(projectPath, ["add", "local.txt"]);
      await runGit(projectPath, ["commit", "-m", "local-only-commit"]);
    });
  }, async ({ projectPath, baseUrl }) => {
    const { status, events } = await createWorktree(baseUrl, {
      name: "issue-172",
      branch: "wt-local-only",
      baseBranch: "local-only",
    });
    assert.equal(status, 200);
    assert.equal(events.find((e) => e.type === "done")?.exitCode, 0);

    // We attempt the fetch, but origin/local-only does not exist — git
    // exits 128 ("couldn't find remote ref") and we fall back to the
    // local ref. Both log lines should appear so the user can see what
    // happened.
    const allLog = events
      .filter((e) => e.type === "log")
      .map((e) => String(e.text ?? ""))
      .join("");
    assert.match(allLog, /git fetch origin local-only/);
    assert.match(
      allLog,
      /git fetch origin local-only failed|origin\/local-only not found/,
      "should log either the fetch failure or the not-found fallback"
    );

    // The new worktree is at the local-only commit.
    const newTip = await getTip(
      path.join(
        process.env.CONTROLLER_HOME!,
        "worktrees",
        "proj-1",
        "issue-172"
      ),
      "HEAD"
    );
    const localOnlyTip = await getTip(projectPath, "local-only");
    assert.equal(newTip, localOnlyTip);
  });
});

test("falls back to local ref when no origin remote is configured", async () => {
  await withCreateEnv(async ({ projectPath }) => {
    // Note: no buildRepo() — just init a plain repo with no remote.
    await runGit(projectPath, ["init", "--initial-branch=main"]);
    await runGit(projectPath, ["config", "user.email", "test@example.com"]);
    await runGit(projectPath, ["config", "user.name", "Test"]);
    await runGit(projectPath, ["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
    await runGit(projectPath, ["add", "README.md"]);
    await runGit(projectPath, ["commit", "-m", "v1"]);
  }, async ({ projectPath, baseUrl }) => {
    const { status, events } = await createWorktree(baseUrl, {
      name: "issue-172",
    });
    assert.equal(status, 200, "no-remote case should still succeed");
    const done = events.find((e) => e.type === "done");
    assert.ok(done);
    assert.equal(done!.exitCode, 0);

    // The fallback log line should be present.
    const allLog = events
      .filter((e) => e.type === "log")
      .map((e) => String(e.text ?? ""))
      .join("");
    assert.match(allLog, /no 'origin' remote configured/);
    assert.doesNotMatch(allLog, /git fetch origin/);

    // The new worktree is at the local main tip (only thing available).
    const newTip = await getTip(
      path.join(
        process.env.CONTROLLER_HOME!,
        "worktrees",
        "proj-1",
        "issue-172"
      ),
      "HEAD"
    );
    const localMainTip = await getTip(projectPath, "main");
    assert.equal(newTip, localMainTip);
  });
});

test("resolves to remote tip via FETCH_HEAD when the fetch refspec is narrow", async () => {
  await withCreateEnv(async ({ projectPath, homeDir }) => {
    await buildRepo(projectPath, async ({ remoteUrl }) => {
      // Narrow the project's fetch refspec so a `git fetch origin feature`
      // only updates FETCH_HEAD and never creates refs/remotes/origin/feature.
      // This is the same shape as a `--single-branch` clone.
      await runGit(projectPath, [
        "config",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);

      // Push main, then create + push a feature branch, and advance
      // origin/feature one commit beyond the local tip.
      await runGit(projectPath, ["push", "-u", "origin", "main"]);
      await runGit(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "feature-local.txt"), "local\n");
      await runGit(projectPath, ["add", "feature-local.txt"]);
      await runGit(projectPath, ["commit", "-m", "feature-local-commit"]);
      await runGit(projectPath, ["push", "-u", "origin", "feature"]);
      await advanceRemoteBranch(remoteUrl, "feature", { homeDir, name: "feature-remote" }, "feature-remote-commit");

      // Sanity: after a fetch, refs/remotes/origin/feature does NOT exist
      // (because of the narrow refspec), but FETCH_HEAD does. This is the
      // exact bug shape the reviewer flagged.
      await runGit(projectPath, ["fetch", "origin", "feature"]);
      assert.equal(
        await getTip(projectPath, "refs/remotes/origin/feature"),
        null,
        "preconditions: narrow refspec should prevent refs/remotes/origin/feature from being created"
      );
      assert.ok(
        await getTip(projectPath, "FETCH_HEAD"),
        "preconditions: FETCH_HEAD should be populated by the fetch"
      );
    });
  }, async ({ projectPath, baseUrl }) => {
    const { status, events } = await createWorktree(baseUrl, {
      name: "issue-172",
      branch: "wt-narrow",
      baseBranch: "feature",
    });
    assert.equal(status, 200);
    assert.equal(events.find((e) => e.type === "done")?.exitCode, 0);

    // The FETCH_HEAD fallback log line should appear.
    const allLog = events
      .filter((e) => e.type === "log")
      .map((e) => String(e.text ?? ""))
      .join("");
    assert.match(allLog, /no refs\/remotes\/origin\/feature after fetch/);
    assert.match(allLog, /FETCH_HEAD/);

    // The new worktree is at the origin/feature tip (read via FETCH_HEAD),
    // not at the stale local feature tip.
    const newTip = await getTip(
      path.join(
        process.env.CONTROLLER_HOME!,
        "worktrees",
        "proj-1",
        "issue-172"
      ),
      "HEAD"
    );
    const originFeatureTip = await getTip(projectPath, "FETCH_HEAD");
    assert.equal(
      newTip,
      originFeatureTip,
      "worktree should match the freshly fetched tip via FETCH_HEAD"
    );
  });
});
