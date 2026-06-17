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
import {
  buildScriptEnv,
  buildTerminalScriptCommand,
  resolveProjectScripts,
  type ProjectScriptCommand,
} from "../lib/project-scripts.js";
import { childProcessEnv } from "../lib/shell-env.js";

export const worktreesRouter = Router();

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_TERMINAL_ID = "run";

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

worktreesRouter.get("/:projectId/source", async (req, res) => {
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

  const requestedPath = getQueryString(req.query.path);
  if (!requestedPath) {
    res.status(400).json({ error: "path is required" });
    return;
  }

  const absolutePath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(worktree.path, requestedPath);

  try {
    const worktrees = await getProjectWorktrees(project.id);
    const allowedRoots = [
      project.path,
      worktree.path,
      ...worktrees.map((item) => item.path),
    ];
    const [targetRealPath, ...rootRealPaths] = await Promise.all([
      fs.realpath(absolutePath),
      ...Array.from(new Set(allowedRoots)).map((root) => fs.realpath(root)),
    ]);
    const matchingRoot = rootRealPaths
      .map((rootRealPath) => ({
        rootRealPath,
        relativePath: path.relative(rootRealPath, targetRealPath),
      }))
      .filter(
        ({ relativePath }) =>
          relativePath === "" ||
          (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
      )
      .sort((a, b) => b.rootRealPath.length - a.rootRealPath.length)[0];

    if (!matchingRoot) {
      res.status(403).json({ error: "File is outside this project" });
      return;
    }

    const stat = await fs.stat(targetRealPath);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Path does not reference a file" });
      return;
    }

    const maxSourceFileBytes = 1024 * 1024;
    if (stat.size > maxSourceFileBytes) {
      res.status(413).json({ error: "File is too large to preview" });
      return;
    }

    const content = await fs.readFile(targetRealPath, "utf-8");
    res.json({
      path: targetRealPath,
      relativePath: matchingRoot.relativePath || path.basename(targetRealPath),
      content,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    console.error("GET /projects/:projectId/source error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

worktreesRouter.get("/:projectId/files", async (req, res) => {
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

  const requestedPath = getQueryString(req.query.path);
  const absolutePath = requestedPath
    ? path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(worktree.path, requestedPath)
    : worktree.path;

  try {
    const [rootRealPath, targetRealPath] = await Promise.all([
      fs.realpath(worktree.path),
      fs.realpath(absolutePath),
    ]);
    const relativePath = path.relative(rootRealPath, targetRealPath);
    const isInsideWorktree =
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

    if (!isInsideWorktree) {
      res.status(403).json({ error: "Directory is outside the selected worktree" });
      return;
    }

    const stat = await fs.stat(targetRealPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Path does not reference a directory" });
      return;
    }

    const dirents = await fs.readdir(targetRealPath, { withFileTypes: true });
    const entries = dirents
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => {
        const entryPath = path.join(targetRealPath, entry.name);
        const entryRelativePath = path.relative(rootRealPath, entryPath);
        return {
          name: entry.name,
          path: entryPath,
          relativePath: entryRelativePath,
          type: entry.isDirectory() ? "directory" : "file",
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({
      path: targetRealPath,
      relativePath: relativePath || ".",
      entries,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      res.status(404).json({ error: "Directory not found" });
      return;
    }
    console.error("GET /projects/:projectId/files error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
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

worktreesRouter.post("/:projectId/run-script", async (req, res) => {
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

  try {
    const scripts = await resolveProjectScripts(project.path);
    if (scripts.run.length === 0) {
      res.status(404).json({ error: "No run script configured" });
      return;
    }

    const terminalId = scripts.runMode === "nonconcurrent"
      ? RUN_TERMINAL_ID
      : `run-${Date.now().toString(36)}`;

    const terminalKey = `${project.id}:${worktree.id}:${terminalId}`;
    if (scripts.runMode === "nonconcurrent") {
      ptyManager.kill(terminalKey);
    }

    const tabs = await setTerminalTabs(project.id, worktree.id, [
      ...(await getTerminalTabs(project.id, worktree.id)),
      { id: terminalId, label: "Run" },
    ]);

    const command = buildTerminalScriptCommand(
      scripts.run,
      buildScriptEnv({ project, worktree })
    );
    ptyManager.runCommand(terminalKey, worktree.path, command);

    res.json({ ok: true, terminalId, tabs });
  } catch (err) {
    console.error("POST /projects/:projectId/run-script error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
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

  const scripts = await resolveProjectScripts(project.path);
  if (scripts.setup.length > 0) {
    const codingAgentDir = path.join(targetPath, ".coding-agent");
    await fs.mkdir(codingAgentDir, { recursive: true });
    const setupLogPath = path.join(codingAgentDir, "setup.log");

    emit({
      type: "log",
      stream: "stdout",
      text: `Running ${formatScriptLabels(scripts.setup)}\n`,
    });

    const { exitCode, timedOut } = await runScriptCommands(
      scripts.setup,
      targetPath,
      buildScriptEnv({ project, worktree }),
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
        text: `setup timed out after ${SETUP_TIMEOUT_MS / 1000}s`,
      });
    } else if (exitCode !== 0) {
      emit({
        type: "error",
        text: `setup exited with ${exitCode}`,
      });
    }
  } else {
    emit({
      type: "log",
      stream: "stdout",
      text: "No setup script found, skipping setup.\n",
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

    const scripts = await resolveProjectScripts(project.path);
    if (scripts.archive.length > 0) {
      const codingAgentDir = path.join(worktree.path, ".coding-agent");
      await fs.mkdir(codingAgentDir, { recursive: true });
      const archiveLogPath = path.join(codingAgentDir, "archive.log");
      const { exitCode, timedOut } = await runScriptCommands(
        scripts.archive,
        worktree.path,
        buildScriptEnv({ project, worktree }),
        archiveLogPath,
        (chunk, stream) => {
          if (stream === "stderr") process.stderr.write(chunk);
        }
      );
      if (timedOut) {
        res.status(500).json({ error: `archive timed out after ${SETUP_TIMEOUT_MS / 1000}s` });
        return;
      }
      if (exitCode !== 0) {
        res.status(500).json({ error: `archive exited with ${exitCode}` });
        return;
      }
    }

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

async function runScriptCommands(
  commands: ProjectScriptCommand[],
  cwd: string,
  env: Record<string, string>,
  logPath: string,
  onData: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<{ exitCode: number; timedOut: boolean }> {
  const logStream = createWriteStream(logPath, { flags: "w" });
  for (const command of commands) {
    const prompt = `$ ${command.command}\n`;
    logStream.write(prompt);
    onData(prompt, "stdout");

    const result = await runOneScriptCommand(command.command, cwd, env, logStream, onData);
    if (result.timedOut || result.exitCode !== 0) {
      logStream.end();
      return result;
    }
  }

  logStream.end();
  return { exitCode: 0, timedOut: false };
}

function runOneScriptCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  logStream: ReturnType<typeof createWriteStream>,
  onData: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: childProcessEnv(env),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SETUP_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => writeScriptOutput(d, "stdout", logStream, onData));
    child.stderr?.on("data", (d: Buffer) => writeScriptOutput(d, "stderr", logStream, onData));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      onData(`spawn error: ${err.message}\n`, "stderr");
      resolve({ exitCode: 1, timedOut });
    });
  });
}

function writeScriptOutput(
  data: Buffer,
  stream: "stdout" | "stderr",
  logStream: ReturnType<typeof createWriteStream>,
  onData: (chunk: string, stream: "stdout" | "stderr") => void
): void {
  const text = data.toString();
  logStream.write(text);
  onData(text, stream);
}

function formatScriptLabels(commands: ProjectScriptCommand[]): string {
  const labels = new Set(commands.map((command) => command.label));
  return Array.from(labels).join(", ");
}
