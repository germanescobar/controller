import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import path from "node:path";
import { getProject } from "../lib/projects.js";
import {
  WORKTREE_NAME_REGEX,
  WORKTREE_NAME_MAX_LENGTH,
  addWorktree,
  getProjectWorktrees,
  getWorktree,
  isMainWorktreeName,
  nextPortOffset,
  removeWorktree,
  resolveWorktree,
  updateWorktree,
} from "../lib/worktrees.js";
import { projectWorktreesDir, worktreePath } from "../lib/paths.js";
import { getSessions } from "../lib/sessions.js";
import { getSessionRuntime } from "../lib/session-runtime.js";
import { ptyManager } from "../lib/pty-manager.js";
import {
  getTerminalTabs,
  removeTerminalTabsForWorktree,
  setTerminalTabs,
} from "../lib/terminal-tabs.js";

export const worktreesRouter = Router();

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

function sseHeaders(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sseSend(res: Response, obj: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function getQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === "string");
    return first;
  }
  return undefined;
}

worktreesRouter.get("/:projectId/branches", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const [branchList, head] = await Promise.all([
      runGitCapture(project.path, ["branch", "--format=%(refname:short)"]),
      runGitCapture(project.path, ["symbolic-ref", "--short", "HEAD"]),
    ]);
    const branches = (branchList ?? "").split("\n").map((b) => b.trim()).filter(Boolean);
    res.json({ branches, head: head ?? null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

worktreesRouter.get("/:projectId/worktrees", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktrees = await getProjectWorktrees(project.id);
  res.json(worktrees);
});

worktreesRouter.get("/:projectId/terminal-tabs", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const worktree = await resolveWorktree(project.id, getQueryString(req.query.worktreeId));
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const tabs = await getTerminalTabs(project.id, worktree.id);
  res.json({ tabs });
});

worktreesRouter.put("/:projectId/terminal-tabs", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const worktree = await resolveWorktree(project.id, getQueryString(req.query.worktreeId));
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const body = req.body as { tabs?: unknown; removeTerminalId?: unknown };
  const removeTerminalId =
    typeof body.removeTerminalId === "string" ? body.removeTerminalId : undefined;
  const tabs = await setTerminalTabs(project.id, worktree.id, body.tabs, {
    removeTerminalId,
  });
  res.json({ tabs });
});

worktreesRouter.get(
  "/:projectId/worktrees/:worktreeId/setup-log",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await getWorktree(project.id, req.params.worktreeId);
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }
    if (!worktree.setupLogPath) {
      res.json({ log: null });
      return;
    }
    try {
      const log = await fs.readFile(worktree.setupLogPath, "utf-8");
      res.json({
        log,
        exitCode: worktree.setupExitCode ?? null,
        ranAt: worktree.setupRanAt ?? null,
      });
    } catch {
      res.json({ log: null });
    }
  }
);

worktreesRouter.post("/:projectId/worktrees", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as {
    name?: string;
    branch?: string;
    baseBranch?: string;
  };
  const name = body?.name;
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (name.length > WORKTREE_NAME_MAX_LENGTH) {
    res.status(400).json({ error: "name too long" });
    return;
  }
  if (!WORKTREE_NAME_REGEX.test(name)) {
    res.status(400).json({
      error: "name must match ^[a-z0-9][a-z0-9._-]*$",
    });
    return;
  }
  if (isMainWorktreeName(name)) {
    res.status(400).json({ error: "name 'main' is reserved" });
    return;
  }

  const existingWorktrees = await getProjectWorktrees(project.id);
  if (existingWorktrees.some((w) => w.name === name)) {
    res.status(409).json({ error: "worktree with this name already exists" });
    return;
  }

  const targetPath = worktreePath(project.id, name);
  if (existsSync(targetPath)) {
    res.status(409).json({ error: `path already exists: ${targetPath}` });
    return;
  }
  await fs.mkdir(projectWorktreesDir(project.id), { recursive: true });

  const branch = body.branch?.trim() || name;
  const baseBranch = body.baseBranch?.trim();

  sseHeaders(res);
  let clientConnected = true;
  req.on("close", () => {
    clientConnected = false;
  });

  function emit(obj: Record<string, unknown>) {
    if (clientConnected) sseSend(res, obj);
  }

  emit({ type: "started", name, branch });

  // Resolve baseBranch: provided value, then current HEAD symbolic ref, fallback to commit.
  let resolvedBase = baseBranch;
  if (!resolvedBase) {
    resolvedBase = await runGitCapture(project.path, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    if (!resolvedBase) {
      resolvedBase = await runGitCapture(project.path, [
        "rev-parse",
        "HEAD",
      ]);
    }
  }

  // Does the requested branch already exist?
  const branchExists =
    (await runGitExitCode(project.path, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])) === 0;

  const args = branchExists
    ? ["worktree", "add", targetPath, branch]
    : ["worktree", "add", "-b", branch, targetPath, resolvedBase ?? ""];

  emit({ type: "log", stream: "stdout", text: `git ${args.join(" ")}\n` });

  const gitExit = await runStreamed(
    "git",
    args,
    project.path,
    (chunk, stream) => emit({ type: "log", stream, text: chunk })
  );

  if (gitExit !== 0) {
    emit({
      type: "error",
      text: `git worktree add failed (exit ${gitExit})`,
    });
    emit({ type: "done", exitCode: gitExit });
    if (clientConnected) res.end();
    return;
  }

  const portOffset = await nextPortOffset(project.id);
  const worktree = await addWorktree({
    projectId: project.id,
    name,
    path: targetPath,
    branch,
    isMain: false,
    portOffset,
  });

  emit({ type: "worktree_created", worktree });

  // Run setup script if present.
  const setupScript = path.join(project.path, ".coding-orchestrator", "setup.sh");
  if (existsSync(setupScript)) {
    const codingAgentDir = path.join(targetPath, ".coding-agent");
    await fs.mkdir(codingAgentDir, { recursive: true });
    const setupLogPath = path.join(codingAgentDir, "setup.log");

    emit({
      type: "log",
      stream: "stdout",
      text: `Running ${setupScript}\n`,
    });

    const { exitCode, timedOut } = await runSetupScript(
      setupScript,
      targetPath,
      {
        WORKTREE_PATH: targetPath,
        SOURCE_PATH: project.path,
        WORKTREE_NAME: name,
        BRANCH: branch,
        PROJECT_ID: project.id,
        PORT_OFFSET: String(portOffset),
      },
      setupLogPath,
      (chunk, stream) => emit({ type: "log", stream, text: chunk })
    );

    await updateWorktree(worktree.id, {
      setupRanAt: new Date().toISOString(),
      setupExitCode: timedOut ? -1 : exitCode,
      setupLogPath,
    });

    if (timedOut) {
      emit({
        type: "error",
        text: `setup.sh timed out after ${SETUP_TIMEOUT_MS / 1000}s`,
      });
    } else if (exitCode !== 0) {
      emit({
        type: "error",
        text: `setup.sh exited with ${exitCode}`,
      });
    }
  } else {
    emit({
      type: "log",
      stream: "stdout",
      text: "No .coding-orchestrator/setup.sh found, skipping setup.\n",
    });
  }

  const final = await getWorktree(project.id, worktree.id);
  emit({ type: "done", exitCode: 0, worktree: final });
  if (clientConnected) res.end();
});

worktreesRouter.delete(
  "/:projectId/worktrees/:worktreeId",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await getWorktree(project.id, req.params.worktreeId);
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }
    if (worktree.isMain) {
      res.status(400).json({ error: "cannot delete main worktree" });
      return;
    }

    const sessions = await getSessions(worktree.path);
    const activeIds = sessions
      .filter((s) => getSessionRuntime(s.id).active)
      .map((s) => s.id);
    if (activeIds.length > 0) {
      res.status(409).json({
        error: "worktree has active sessions",
        activeSessionIds: activeIds,
      });
      return;
    }

    ptyManager.killByPrefix(`${project.id}:${worktree.id}:`);

    // Remove via git first; fall back to fs.rm if directory still exists.
    await runGitExitCode(project.path, [
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]);
    if (existsSync(worktree.path)) {
      await fs.rm(worktree.path, { recursive: true, force: true });
    }

    await removeWorktree(worktree.id);
    await removeTerminalTabsForWorktree(project.id, worktree.id);
    res.json({ ok: true });
  }
);

// --- helpers ---

function runStreamed(
  command: string,
  args: string[],
  cwd: string,
  onData: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    child.stdout?.on("data", (d: Buffer) => onData(d.toString(), "stdout"));
    child.stderr?.on("data", (d: Buffer) => onData(d.toString(), "stderr"));
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

function runGitCapture(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() : undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}

function runGitExitCode(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

function runSetupScript(
  script: string,
  cwd: string,
  env: Record<string, string>,
  logPath: string,
  onData: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const logStream = createWriteStream(logPath, { flags: "w" });
    const child = spawn("bash", [script], {
      cwd,
      env: { ...process.env, ...env },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SETUP_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      logStream.write(text);
      onData(text, "stdout");
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      logStream.write(text);
      onData(text, "stderr");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      logStream.end();
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      logStream.end();
      onData(`spawn error: ${err.message}\n`, "stderr");
      resolve({ exitCode: 1, timedOut });
    });
  });
}
