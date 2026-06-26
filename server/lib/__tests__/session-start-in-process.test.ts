import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #243: `startSessionInProcess` is what the scheduler calls to fire a
 * schedule. It must produce the same result as the headless `POST /sessions`
 * route — a persisted session keyed by the agent's `run.started` id — without
 * a network hop. This test stands up the same fake-agent fixture the
 * session-start route test uses and drives the in-process entry point.
 */

test("startSessionInProcess persists a session and returns its id + url", async () => {
  const sessionId = "sess-scheduled-243";
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "in-process-start-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "in-process-bin-"));
  const previousHome = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  process.env.CONTROLLER_HOME = homeDir;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

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

  const script = `#!/usr/bin/env bash
set -e
printf '%s\\n' '{"type":"run.started","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
printf '%s\\n' '{"type":"run.completed","sessionId":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z"}'
cat >/dev/null || true
exit 0
`;
  await fs.writeFile(path.join(binDir, "anita"), script, { mode: 0o755 });

  const { clearCommandResolverCache } = await import("../command-resolver.js");
  clearCommandResolverCache();

  try {
    const { getProjectWorktrees } = await import("../worktrees.js");
    const main = (await getProjectWorktrees(projectId)).find((w) => w.isMain);
    if (!main) throw new Error("main worktree not found");

    const { startSessionInProcess } = await import("../session-start.js");
    const result = await startSessionInProcess({
      projectId,
      worktreeId: main.id,
      prompt: "Run the scheduled morning check.",
      provider: "anita",
    });

    assert.equal(result.sessionId, sessionId);
    assert.match(result.url, new RegExp(`session/${sessionId}`));

    const { projectStoreDir } = await import("../paths.js");
    const sessionFile = path.join(projectStoreDir(projectPath), "sessions", `${sessionId}.json`);
    const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
    assert.equal(session.id, sessionId);
    assert.equal(session.provider, "anita");
  } finally {
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

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
