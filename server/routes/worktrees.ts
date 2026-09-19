import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import os from "node:os";
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
  worktreeNotFoundPayload,
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
import {
  buildFileIndex,
  clampInt,
  MENTION_WALK_DEFAULT_DEPTH,
  MENTION_WALK_DEFAULT_LIMIT,
  MENTION_WALK_MAX_DEPTH,
  MENTION_WALK_MAX_LIMIT,
} from "../lib/file-index.js";
import {
  emitSessionRemoved,
  emitWorktreeAdded,
  emitWorktreeRemoved,
  emitWorktreeUpdated,
} from "../lib/events.js";

export const worktreesRouter = Router();

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_TERMINAL_ID = "run";

// Track worktrees that currently have an in-flight setup run so we can refuse
// overlapping requests instead of racing two `setup.sh` invocations against
// each other.
const activeSetupRuns = new Set<string>();

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
    const [branchList, head, defaultBranch] = await Promise.all([
      runGitCapture(project.path, ["branch", "--format=%(refname:short)"]),
      runGitCapture(project.path, ["symbolic-ref", "--short", "HEAD"]),
      resolveDefaultBranch(project.path),
    ]);
    const branches = sortBranchesWithDefault(
      (branchList ?? "").split("\n").map((b) => b.trim()).filter(Boolean),
      defaultBranch ?? head ?? null
    );
    res.json({ branches, head: head ?? null, defaultBranch: defaultBranch ?? null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  // Prefer the remote's advertised default branch (origin/HEAD), which most
  // clones set automatically. Strip the "origin/" prefix if present.
  const remoteHead = await runGitCapture(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) {
    const short = remoteHead.replace(/^origin\//, "");
    if (short) return short;
  }

  // Fall back to the locally-configured default branch name.
  const initDefault = await runGitCapture(cwd, ["config", "--get", "init.defaultBranch"]);
  if (initDefault) return initDefault;

  return null;
}

// Try to base the new worktree on `origin/<candidate>` so it starts from the
// up-to-date remote tip. Runs `git fetch origin <candidate>` first, streamed
// to the caller via `emit`. If the fetch fails, the remote ref is missing,
// or `origin` is not configured, fall back to the local ref — and ultimately
// to local HEAD — without aborting the request.
async function resolveBaseRef(
  project: { path: string },
  candidateBase: string | null,
  emit: (obj: Record<string, unknown>) => void
): Promise<string | null> {
  if (!candidateBase) {
    return await resolveLocalHead(project.path);
  }

  // Only fetch from `origin`. Repos with a different primary remote still
  // get local-HEAD behavior — the user can opt in by naming that remote
  // explicitly through a project-level setting (out of scope here).
  const remoteUrl = await runGitCapture(project.path, [
    "remote",
    "get-url",
    "origin",
  ]);
  if (!remoteUrl) {
    emit({
      type: "log",
      stream: "stdout",
      text: `no 'origin' remote configured — basing worktree on local ${candidateBase}\n`,
    });
    return await resolveLocalBranchOrHead(project.path, candidateBase);
  }

  const fetchArgs = ["fetch", "origin", candidateBase];
  emit({ type: "log", stream: "stdout", text: `git ${fetchArgs.join(" ")}\n` });
  const fetchExit = await runStreamed(
    "git",
    fetchArgs,
    project.path,
    (chunk, stream) => emit({ type: "log", stream, text: chunk })
  );
  if (fetchExit !== 0) {
    emit({
      type: "log",
      stream: "stderr",
      text: `git fetch origin ${candidateBase} failed (exit ${fetchExit}) — falling back to local ${candidateBase}\n`,
    });
    return await resolveLocalBranchOrHead(project.path, candidateBase);
  }

  // Prefer the freshly fetched remote tracking ref. Fall back to the local
  // ref if it doesn't exist on the remote (branch only exists locally).
  const remoteRef = await runGitExitCode(project.path, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${candidateBase}`,
  ]);
  if (remoteRef === 0) {
    return `origin/${candidateBase}`;
  }

  // In clones with a narrow refspec (e.g. `--single-branch` clones, or any
  // repo where the user has overridden `remote.<name>.fetch`), `git fetch
  // origin <ref>` writes only to `FETCH_HEAD` and does not update
  // `refs/remotes/origin/<ref>`. Read `FETCH_HEAD` directly so the new
  // worktree still bases on the freshly fetched tip instead of falling
  // back to a stale local ref.
  const fetchedHead = await runGitCapture(project.path, [
    "rev-parse",
    "--verify",
    "FETCH_HEAD^{commit}",
  ]);
  if (fetchedHead) {
    emit({
      type: "log",
      stream: "stdout",
      text: `no refs/remotes/origin/${candidateBase} after fetch — basing worktree on FETCH_HEAD (${fetchedHead})\n`,
    });
    return fetchedHead;
  }

  emit({
    type: "log",
    stream: "stdout",
    text: `origin/${candidateBase} not found after fetch — basing worktree on local ${candidateBase}\n`,
  });
  return await resolveLocalBranchOrHead(project.path, candidateBase);
}

async function resolveLocalBranchOrHead(cwd: string, branch: string): Promise<string | null> {
  const exists = await runGitExitCode(cwd, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (exists === 0) return branch;
  return await resolveLocalHead(cwd);
}

async function resolveLocalHead(cwd: string): Promise<string | null> {
  const symbolic = await runGitCapture(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (symbolic) return symbolic;
  const commit = await runGitCapture(cwd, ["rev-parse", "HEAD"]);
  return commit ?? null;
}

function sortBranchesWithDefault(branches: string[], defaultBranch: string | null): string[] {
  if (!defaultBranch || !branches.includes(defaultBranch)) {
    return [...branches].sort((a, b) => a.localeCompare(b));
  }
  return [defaultBranch, ...branches.filter((b) => b !== defaultBranch).sort((a, b) => a.localeCompare(b))];
}

worktreesRouter.get("/:projectId/worktrees", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  // `Cache-Control: no-store` keeps the sidebar from rendering a stale
  // worktree list when a new worktree is created or removed (matches
  // the same fix on the per-worktree sessions endpoint at
  // `server/routes/sessions.ts`).
  res.set("Cache-Control", "no-store");
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
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

/*
 * Recursive file/directory walk for the `@`-mention picker (issue #312).
 * The actual walk lives in `server/lib/file-index.ts` so its bounds
 * and denylist are unit-testable in isolation; this route is a thin
 * adapter that resolves the worktree root and clamps the query
 * parameters.
 */
worktreesRouter.get("/:projectId/file-index", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    project.id,
    getQueryString(req.query.worktreeId),
  );
  if (!worktree) {
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
    return;
  }
  const depth = clampInt(
    getQueryString(req.query.depth),
    MENTION_WALK_DEFAULT_DEPTH,
    1,
    MENTION_WALK_MAX_DEPTH,
  );
  const limit = clampInt(
    getQueryString(req.query.limit),
    MENTION_WALK_DEFAULT_LIMIT,
    1,
    MENTION_WALK_MAX_LIMIT,
  );

  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(worktree.path);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  const result = await buildFileIndex(rootRealPath, depth, limit);
  res.json(result);
});

worktreesRouter.put("/:projectId/terminal-tabs", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const worktree = await resolveWorktree(project.id, getQueryString(req.query.worktreeId));
  if (!worktree) {
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
    return;
  }

  const body = req.body as { tabs?: unknown; removeTerminalId?: unknown };
  const removeTerminalId =
    typeof body.removeTerminalId === "string" ? body.removeTerminalId : undefined;
  // Issue #296: the user closing a tab is authoritative. The WebSocket-based
  // close path can lose the kill (the WS may still be CONNECTING, or the
  // unmount calls plain `ws.close()` which the server treats as a disconnect),
  // and the next 2s `getTerminalTabs` poll would re-merge the still-alive tmux
  // session as a fresh tab. Kill the underlying PTY here, before
  // `setTerminalTabs` reads `listTmuxTerminalIds`, so the tab cannot come back.
  if (removeTerminalId) {
    ptyManager.kill(`${project.id}:${worktree.id}:${removeTerminalId}`);
  }
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        project.id,
        getQueryString(req.query.worktreeId)
      )
    );
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

    const env = buildScriptEnv({ project, worktree });
    const command = buildTerminalScriptCommand(scripts.run);
    ptyManager.runCommand(terminalKey, worktree.path, command, env);

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
      res.status(404).json(
        await worktreeNotFoundPayload(project.id, req.params.worktreeId)
      );
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

worktreesRouter.post(
  "/:projectId/worktrees/:worktreeId/run-setup",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await getWorktree(project.id, req.params.worktreeId);
    if (!worktree) {
      res.status(404).json(
        await worktreeNotFoundPayload(project.id, req.params.worktreeId)
      );
      return;
    }

    // Reserve the run slot before any await so two concurrent requests
    // can't both pass a presence check and then race on the same worktree
    // (and `.coding-agent/setup.log`). The key is released in the `finally`
    // below regardless of which path exits.
    const runKey = `${project.id}:${worktree.id}`;
    if (activeSetupRuns.has(runKey)) {
      res.status(409).json({ error: "setup is already running for this worktree" });
      return;
    }
    activeSetupRuns.add(runKey);

    let clientConnected = true;
    req.on("close", () => {
      clientConnected = false;
    });

    let responseEnded = false;
    function emit(obj: Record<string, unknown>) {
      if (clientConnected) sseSend(res, obj);
    }

    try {
      let scripts;
      try {
        scripts = await resolveProjectScripts(project.path);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        responseEnded = true;
        return;
      }
      if (scripts.setup.length === 0) {
        res.status(404).json({ error: "No setup script configured" });
        responseEnded = true;
        return;
      }

      sseHeaders(res);

      emit({ type: "started", worktreeId: worktree.id });

      const codingAgentDir = path.join(worktree.path, ".coding-agent");
      await fs.mkdir(codingAgentDir, { recursive: true });
      const setupLogPath = path.join(codingAgentDir, "setup.log");

      emit({
        type: "log",
        stream: "stdout",
        text: `Running ${formatScriptLabels(scripts.setup)}\n`,
      });

      let exitCode = 0;
      let timedOut = false;
      try {
        const result = await runScriptCommands(
          scripts.setup,
          worktree.path,
          buildScriptEnv({ project, worktree }),
          setupLogPath,
          (chunk, stream) => emit({ type: "log", stream, text: chunk })
        );
        exitCode = result.exitCode;
        timedOut = result.timedOut;
      } catch (err) {
        emit({
          type: "error",
          text: `setup run failed: ${(err as Error).message}`,
        });
      }

      let finalWorktree;
      try {
        await updateWorktree(worktree.id, {
          setupRanAt: new Date().toISOString(),
          setupExitCode: timedOut ? -1 : exitCode,
          setupLogPath,
        });
        finalWorktree = await getWorktree(project.id, worktree.id);
      } catch (err) {
        emit({
          type: "error",
          text: `failed to persist setup result: ${(err as Error).message}`,
        });
      }

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

      emit({
        type: "done",
        exitCode: timedOut ? -1 : exitCode,
        worktree: finalWorktree,
      });
      // Notify other windows that the worktree's setup state changed so
      // their sidebar can drop the "running setup" indicator without
      // polling. `finalWorktree` is the source of truth — fall back to
      // the pre-call worktree so the event still has the new fields if
      // persistence failed mid-flight.
      emitWorktreeUpdated(project.id, finalWorktree ?? worktree);
    } finally {
      activeSetupRuns.delete(runKey);
      if (!responseEnded && clientConnected) {
        res.end();
      }
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

  // Resolve baseBranch to a concrete ref. Prefer `origin/<branch>` so a new
  // worktree starts from the up-to-date remote tip even when local HEAD is
  // behind. Fall back to the local ref (and ultimately local HEAD) if the
  // fetch fails or the remote tracking ref is unavailable.
  const candidateBase = baseBranch ?? (await resolveDefaultBranch(project.path));
  const resolvedBase = await resolveBaseRef(project, candidateBase, emit);

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
  // Notify other clients (sidebar in another window) that a new worktree
  // exists. The in-stream `worktree_created` above is the per-tab signal
  // for the worktree picker that initiated the create (issue #210).
  emitWorktreeAdded(project.id, worktree);

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

    const updated = await updateWorktree(worktree.id, {
      setupRanAt: new Date().toISOString(),
      setupExitCode: timedOut ? -1 : exitCode,
      setupLogPath,
    });
    // Sidebar in other windows watches for `worktree_updated` to drop the
    // "running setup" indicator without polling (issue #210). Prefer the
    // persisted record; fall back to a synthesized copy so the event
    // still carries the new fields if persistence failed.
    emitWorktreeUpdated(
      project.id,
      updated ?? {
        ...worktree,
        setupRanAt: new Date().toISOString(),
        setupExitCode: timedOut ? -1 : exitCode,
        setupLogPath,
      }
    );

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
      res.status(404).json(
        await worktreeNotFoundPayload(project.id, req.params.worktreeId)
      );
      return;
    }
    if (worktree.isMain) {
      res.status(400).json({ error: "cannot delete main worktree" });
      return;
    }

    // Issue #332: a paused worktree (no active session, no running PTY)
    // can still carry uncommitted changes. The previous version called
    // `git worktree remove --force` and then `fs.rm --recursive`, which
    // would silently destroy any of those changes. Refuse the delete by
    // default; require `?force=1` and (for dirty worktrees) a successful
    // archive script run before destructive removal.
    const forceParam = getQueryString(req.query.force);
    const forceDelete = forceParam === "1" || forceParam === "true";

    // Always compute dirty status so we can show the file list in
    // every error path. Skipping the check when `?force=1` is set
    // would hide the very state we need to gate the destructive
    // removal on.
    const dirtyFiles = await listDirtyFiles(worktree.path);
    if (dirtyFiles.length > 0 && !forceDelete) {
      res.status(409).json({
        error: "worktree has uncommitted changes; pass ?force=1 to delete",
        dirtyFiles,
      });
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

    // Notify listeners (e.g. the sidebar in another window) that the
    // sessions on this worktree are going away, so they can drop the
    // corresponding rows from the tree before the worktree itself is
    // unregistered (issue #210). Best-effort: if a session file is
    // missing or unreadable we still continue with the archive/delete.
    try {
      const sessionsToRemove = await getSessions(worktree.path);
      for (const session of sessionsToRemove) {
        emitSessionRemoved(project.id, worktree.id, session.id);
      }
    } catch (err) {
      console.error("Failed to enumerate sessions before worktree delete:", err);
    }

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
    } else if (dirtyFiles.length > 0) {
      // Force-deleting a dirty worktree without an archive script
      // configured would still destroy uncommitted changes — we already
      // persisted `dirtyFiles` for the caller but we have no recovery
      // path. Refuse rather than proceed.
      res.status(409).json({
        error:
          "worktree has uncommitted changes and no archive script is configured; configure archive.sh or commit/stash the changes before deleting",
        dirtyFiles,
      });
      return;
    }

    // Remove via git first. Only pass `--force` when we knowingly
    // bypassed the dirty-check (i.e. the caller passed `?force=1` and
    // archive.sh already captured the state). For a normal clean
    // delete, let git refuse — that gives us an early signal that
    // something else (a concurrent write, a stale status) dirtied the
    // tree between our check and now.
    const gitArgs = forceDelete
      ? ["worktree", "remove", "--force", worktree.path]
      : ["worktree", "remove", worktree.path];
    const gitExit = await runGitExitCode(project.path, gitArgs);
    if (gitExit !== 0) {
      // Git refused to remove the worktree. The most common cause is
      // that the tree became dirty between our `git status` check
      // and now (e.g. the archive script created a log file inside
      // the worktree, or the user wrote a file mid-request).
      //
      // We only fall back to a recursive `fs.rm` when the caller has
      // already accepted that destructive removal via `?force=1` — and
      // in that case we also pass `--force` to git above, so this
      // branch shouldn't normally fire. The two guards (gate at the
      // top + force flag here) keep the previous footgun from coming
      // back: a non-force delete can never trigger `fs.rm`, which is
      // exactly the silent-destruction the dirty check exists to
      // prevent.
      if (!forceDelete) {
        res.status(409).json({
          error:
            "worktree became dirty between the status check and the delete; refuse rather than recursively rm. Re-issue with ?force=1 after archiving.",
          dirtyFiles: await listDirtyFiles(worktree.path),
        });
        return;
      }
      // Force-delete: git still failed for some other reason (the
      // worktree entry was already gone, git crashed, etc.). Fall
      // back to `fs.rm` only because the caller explicitly opted
      // into destructive removal via `?force=1`.
      if (existsSync(worktree.path)) {
        await fs.rm(worktree.path, { recursive: true, force: true });
      }
    } else if (existsSync(worktree.path)) {
      // Git succeeded but left the directory behind (rare — usually
      // only happens if the directory is on a different filesystem).
      // Same fallback policy as above: only the force path may rm.
      if (forceDelete) {
        await fs.rm(worktree.path, { recursive: true, force: true });
      }
    }

    await removeWorktree(worktree.id);
    await removeTerminalTabsForWorktree(project.id, worktree.id);
    emitWorktreeRemoved(project.id, worktree.id);
    res.json({ ok: true });
  }
);

// --- helpers ---

/**
 * List the dirty files in a worktree (modified, staged, or untracked)
 * relative to its HEAD. Used by the DELETE route (issue #332) to refuse
 * deletes that would destroy uncommitted work.
 *
 * Files under `.coding-agent/` (the orchestrator's own per-worktree
 * scratch directory — `setup.log`, `archive.log`, session focus
 * sidecars, etc.) are excluded from the result. We always write those
 * files there for lack of a better home, and projects that don't
 * gitignore `.coding-agent/` would otherwise see Controller's own
 * bookkeeping as uncommitted user changes. `git status --porcelain`
 * has no clean flag for this, so we filter the parsed output. The
 * matching `git add` exclusion lives in `server/routes/sessions.ts`.
 *
 * Returns an empty array when the worktree is clean, when the directory
 * doesn't exist yet, or when `git status` can't be read for any reason
 * — we deliberately do NOT silently treat those as "dirty" because that
 * would block legitimate deletes. The first two are non-dirty (clean
 * absent directory or a brand-new worktree); only the last case is
 * ambiguous, and we'd rather risk letting the user delete a worktree
 * whose git status we couldn't read than refusing every delete when
 * git is misbehaving.
 */
async function listDirtyFiles(cwd: string): Promise<string[]> {
  if (!existsSync(cwd)) return [];
  const output = await runGitCapture(cwd, [
    "status",
    "--porcelain",
    "--ignore-submodules=dirty",
    "--untracked-files=all",
  ]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.replace(/^\s*\S+\s+/, "").trim())
    .filter((file) => file && !isControllerOwnedPath(file));
}

/**
 * `true` for paths the orchestrator itself writes inside the
 * worktree (currently just `.coding-agent/`). Keep in sync with the
 * `git add` exclusion in `server/routes/sessions.ts:257` and the
 * `git diff` exclusion at `server/routes/sessions.ts:279`.
 */
function isControllerOwnedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\.\//, "");
  if (normalized === ".coding-agent") return true;
  if (normalized.startsWith(".coding-agent/")) return true;
  return false;
}

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
