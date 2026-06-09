import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getProject } from "../lib/projects.js";
import { getProjectWorktrees, resolveWorktree } from "../lib/worktrees.js";

const execAsync = promisify(exec);
import {
  getSessions,
  getSession,
  getEvents,
  archiveSession,
  updateSessionFocus,
  saveSession,
  appendEvent,
  saveAttachment,
  getAttachment,
  getAttachments,
  type AgentEvent,
  type AttachmentMetadata,
} from "../lib/sessions.js";
import { getApiKeyEnvVars } from "../lib/api-keys.js";
import {
  getAgentProvider,
  resolveAgentCommand,
  type AgentStreamEvent,
} from "../lib/agents.js";
import { codexAppServerManager } from "../lib/codex-app-server.js";
import {
  getSessionRuntime,
  markSessionActive,
  markSessionInactive,
  stopSessionRuntime,
} from "../lib/session-runtime.js";

// Strip ANSI escape codes (color, cursor, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function isBenignProviderStderrLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.includes("Reading additional input from stdin")) return true;
  if (trimmed.includes("Reading prompt from stdin")) return true;
  if (/^OpenAI Codex v/i.test(trimmed)) return true;
  if (/^-{4,}$/.test(trimmed)) return true;
  if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(trimmed)) {
    return true;
  }
  if (/^hook: /i.test(trimmed)) return true;
  if (/^tokens used$/i.test(trimmed)) return true;
  if (/^\d{4}-\d{2}-\d{2}T.*\b(WARN|ERROR)\b.*failed to record rollout items/i.test(trimmed)) {
    return true;
  }
  if (/^\d{4}-\d{2}-\d{2}T.*\bWARN\b.*Failed to terminate MCP process group/i.test(trimmed)) {
    return true;
  }
  return false;
}

// Kill a spawned agent that produces no stdout for this long — catches hangs
// where the process is alive but stalled (e.g. an upstream request that never
// streams). Long-running tool calls (builds, tests) still emit start/finish
// events, so a multi-minute window avoids false positives. Override per-deploy.
const AGENT_INACTIVITY_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.AGENT_INACTIVITY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();
// Comment-line ping so idle proxies don't drop a quiet SSE connection.
const SSE_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_SIZE = 35 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
]);

interface AttachmentUpload {
  name?: string;
  mimeType?: string;
  size?: number;
  data?: string;
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.replace(/^-+|-+$/g, "") || "attachment";
}

function attachmentPublicMetadata(
  projectId: string,
  worktreeId: string,
  attachment: AttachmentMetadata
) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    path: attachment.path,
    isImage: attachment.isImage,
    createdAt: attachment.createdAt,
    url: `/api/projects/${projectId}/attachments/${attachment.id}?worktreeId=${encodeURIComponent(worktreeId)}&v=${encodeURIComponent(attachment.createdAt)}`,
  };
}

interface RunDiffSummary {
  diff: string;
  filesChanged: number;
  added: number;
  deleted: number;
}

async function createWorktreeSnapshot(worktreePath: string): Promise<string | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-index-"));
  const indexPath = path.join(tempDir, "index");
  const execOpts = {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: indexPath,
    },
  };

  try {
    try {
      await execAsync("git rev-parse --is-inside-work-tree", execOpts);
    } catch {
      return null;
    }

    try {
      await execAsync("git read-tree HEAD", execOpts);
    } catch {
      await execAsync("git read-tree --empty", execOpts);
    }

    await execAsync(
      "git ls-files -z --cached --others --modified --deleted --exclude-standard ':!.coding-agent' ':!.coding-agent/**' | git update-index --add --remove -z --stdin",
      execOpts
    );
    const { stdout } = await execAsync("git write-tree", execOpts);
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function getRunDiff(
  worktreePath: string,
  beforeTree: string | null
): Promise<RunDiffSummary | null> {
  if (!beforeTree) return null;
  const afterTree = await createWorktreeSnapshot(worktreePath);
  if (!afterTree || afterTree === beforeTree) return null;

  try {
    const { stdout: diff } = await execAsync(
      `git diff --find-renames ${beforeTree} ${afterTree} -- . ":(exclude).coding-agent"`,
      {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
    if (!diff.trim()) return null;
    return summarizeRunDiff(diff);
  } catch {
    return null;
  }
}

function summarizeRunDiff(diff: string): RunDiffSummary {
  const files = diff
    .split(/(?=^diff --git )/m)
    .filter((section) => section.trim().startsWith("diff --git "));
  let added = 0;
  let deleted = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }

  return {
    diff,
    filesChanged: files.length,
    added,
    deleted,
  };
}

async function persistRunDiffEvent(
  worktreePath: string,
  sessionId: string,
  beforeTree: string | null
): Promise<void> {
  try {
    const summary = await getRunDiff(worktreePath, beforeTree);
    if (!summary || summary.filesChanged === 0) return;

    await appendEvent(worktreePath, sessionId, {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: "run_diff",
      data: { ...summary },
    });
  } catch {
    // Diff cards are a convenience; never fail run completion because of them.
  }
}

export const sessionsRouter = Router();

sessionsRouter.post("/:projectId/attachments", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const uploads = req.body.attachments as AttachmentUpload[] | undefined;
  if (!Array.isArray(uploads) || uploads.length === 0) {
    res.status(400).json({ error: "At least one attachment is required" });
    return;
  }
  if (uploads.length > MAX_ATTACHMENT_COUNT) {
    res.status(400).json({ error: `Attach up to ${MAX_ATTACHMENT_COUNT} files` });
    return;
  }

  let totalSize = 0;
  const saved: AttachmentMetadata[] = [];
  try {
    for (const upload of uploads) {
      const name = sanitizeFileName(upload.name ?? "");
      const mimeType = upload.mimeType || "application/octet-stream";
      if (!SUPPORTED_ATTACHMENT_TYPES.has(mimeType)) {
        res.status(400).json({ error: `${name} is not a supported file type` });
        return;
      }
      if (!upload.data || typeof upload.data !== "string") {
        res.status(400).json({ error: `${name} could not be read` });
        return;
      }
      const data = Buffer.from(upload.data, "base64");
      const size = data.byteLength;
      if (size <= 0) {
        res.status(400).json({ error: `${name} is empty` });
        return;
      }
      if (size > MAX_ATTACHMENT_SIZE) {
        res.status(400).json({ error: `${name} is larger than 15 MB` });
        return;
      }
      totalSize += size;
      if (totalSize > MAX_ATTACHMENT_TOTAL_SIZE) {
        res.status(400).json({ error: "Attachments are larger than 35 MB total" });
        return;
      }
      if (typeof upload.size === "number" && upload.size !== size) {
        res.status(400).json({ error: `${name} changed while uploading` });
        return;
      }

      const attachment = await saveAttachment(
        worktree.path,
        {
          id: randomUUID(),
          name,
          mimeType,
          size,
          path: "",
          isImage: mimeType.startsWith("image/"),
          createdAt: new Date().toISOString(),
        },
        data
      );
      saved.push(attachment);
    }

    res.json({
      attachments: saved.map((attachment) =>
        attachmentPublicMetadata(req.params.projectId, worktree.id, attachment)
      ),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

sessionsRouter.get("/:projectId/attachments/:attachmentId", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  let attachment = worktree
    ? await getAttachment(worktree.path, req.params.attachmentId)
    : null;
  if (!attachment) {
    const worktrees = await getProjectWorktrees(req.params.projectId);
    for (const candidate of worktrees) {
      attachment = await getAttachment(candidate.path, req.params.attachmentId);
      if (attachment) break;
    }
  }
  if (!attachment || !attachment.isImage) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  try {
    const data = await fs.readFile(attachment.path);
    res.set("Cache-Control", "no-store");
    res.type(attachment.mimeType);
    res.send(data);
  } catch {
    res.status(404).json({ error: "Attachment file not found" });
  }
});

// Git diff for a worktree
sessionsRouter.get("/:projectId/git/diff", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const execOpts = {
    cwd: worktree.path,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };

  let diff = "";

  // Tracked file changes (staged + unstaged vs HEAD)
  try {
    const { stdout } = await execAsync("git diff HEAD", execOpts);
    diff += stdout;
  } catch {
    // HEAD may not exist (empty repo) — fall back to staged only
    try {
      const { stdout } = await execAsync("git diff --cached", execOpts);
      diff += stdout;
    } catch { /* ignore */ }
  }

  // Untracked new files — produce a pseudo "new file" diff for each
  try {
    const { stdout: listOut } = await execAsync(
      "git ls-files --others --exclude-standard",
      execOpts
    );
    const untracked = listOut.split("\n").filter(Boolean).sort().slice(0, 50);
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const chunks = await Promise.all(
      untracked.map(async (file) => {
        try {
          const content = await readFile(join(worktree.path, file), "utf-8");
          const lines = content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          return (
            `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((l) => `+${l}`).join("\n") +
            "\n"
          );
        } catch {
          // skip binary / unreadable
          return "";
        }
      })
    );
    diff += chunks.join("");
  } catch { /* ignore */ }

  res.json({ diff });
});

// Branch diff — committed changes on the current branch vs its merge-base with main/master
sessionsRouter.get("/:projectId/git/branch-diff", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const execOpts = {
    cwd: worktree.path,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };

  let diff = "";
  const baseCandidates = ["origin/main", "origin/master", "main", "master"];
  for (const base of baseCandidates) {
    try {
      const { stdout: mergeBase } = await execAsync(`git merge-base HEAD ${base}`, execOpts);
      const sha = mergeBase.trim();
      if (sha) {
        const { stdout } = await execAsync(`git diff ${sha}..HEAD`, execOpts);
        diff = stdout;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  res.json({ diff });
});

// Stream a new session via SSE — must be before /:sessionId routes
sessionsRouter.get("/:projectId/sessions/stream", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }

  const message = req.query.message as string;
  const resumeSessionId = req.query.resumeSessionId as string | undefined;
  const model = req.query.model as string | undefined;
  const reasoningEffort = req.query.reasoningEffort as
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | undefined;
  const serviceTier = req.query.serviceTier === "fast" ? "fast" : undefined;
  const providerId = (req.query.provider as string) || "ada";
  const mode = (req.query.mode as "default" | "plan" | undefined) || "default";
  const attachmentIds = (req.query.attachmentIds as string | undefined)
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean) ?? [];

  const provider = getAgentProvider(providerId);
  if (!provider) {
    res.status(400).json({ error: `Unknown agent provider: ${providerId}` });
    return;
  }

  if (!message) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }
  if (attachmentIds.length > 0 && providerId !== "ada" && providerId !== "codex" && providerId !== "claude") {
    res.status(400).json({ error: `${provider.name} does not support attachments` });
    return;
  }

  const attachments = await getAttachments(worktree.path, attachmentIds);
  if (attachments.length !== attachmentIds.length) {
    res.status(400).json({ error: "One or more attachments could not be found" });
    return;
  }

  const runStartTree = await createWorktreeSnapshot(worktree.path);

  if (providerId === "codex" && attachments.length === 0) {
    await streamCodexPlanSession(req, res, {
      worktreePath: worktree.path,
      worktreeId: worktree.id,
      projectId: req.params.projectId,
      runStartTree,
      message,
      resumeSessionId,
      model,
      reasoningEffort,
      serviceTier,
      mode,
      providerId,
      attachments,
    });
    return;
  }

  // Resolve the CLI to an absolute path before streaming so a missing agent
  // fails with a clean 400 instead of a mid-stream ENOENT.
  let resolvedCommand: string;
  try {
    resolvedCommand = await resolveAgentCommand(providerId);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const apiKeyEnv = await getApiKeyEnvVars();

  const child = provider.spawn({
    message,
    cwd: worktree.path,
    env: apiKeyEnv,
    command: resolvedCommand,
    attachments,
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
  });
  const parseProviderEvent = provider.createParser?.() ?? provider.parseEvent.bind(provider);

  let stdoutBuffer = "";
  let eventProcessing = Promise.resolve();
  // For non-Ada providers, we persist events ourselves since they don't
  // write to .coding-agent/events/ like Ada does.
  const shouldPersist = providerId !== "ada";
  let streamSessionId = resumeSessionId ?? "";
  let userMessageWritten = false;
  let pausedForClaudeUserInput = false;
  let runTerminated = false;

  // Close stdin for CLIs that otherwise wait on an open pipe. We pass the
  // prompt as an argv argument, so none of these providers need stdin; leaving
  // it open has been observed to make Ada hang silently mid-run.
  if (providerId === "ada" || providerId === "codex" || providerId === "claude") {
    child.stdin?.end();
  }

  const worktreePath = worktree.path;
  const worktreeId = worktree.id;

  /** Write the user message + create/update session file once we know the sessionId. */
  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    markSessionActive(sessionId, {
      provider: providerId,
      child,
      metadata: { projectId: req.params.projectId, worktreeId },
    });
    // Always write a user_message event so attachments persist for reloaded
    // sessions. Some providers (e.g. Ada) also write their own user_message
    // event with empty attachments; the GET /events endpoint collapses
    // consecutive duplicates with the same text.
    if (!userMessageWritten) {
      userMessageWritten = true;
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: {
          text: message,
          attachments: attachments.map((attachment) =>
            attachmentPublicMetadata(req.params.projectId, worktreeId, attachment)
          ),
        },
      });
    }
    // Merge with existing session file (preserve title/createdAt from earlier messages)
    const existing = await getSession(worktreePath, sessionId);
    const title = existing?.title || (message.length > 60 ? message.slice(0, 60) + "..." : message);
    await saveSession(worktreePath, {
      id: sessionId,
      title,
      workingDirectory: worktreePath,
      worktreeId,
      model: model ?? existing?.model ?? "",
      reasoningEffort: reasoningEffort ?? existing?.reasoningEffort,
      serviceTier: serviceTier ?? existing?.serviceTier,
      provider: providerId,
      mode,
      messages: existing?.messages ?? [],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
      focusPinnedAt: existing?.focusPinnedAt,
      focusDoneAt: existing?.focusDoneAt,
    });
  }

  /** Convert a normalized agent event to a persisted AgentEvent and append it. */
  function persistAgentEvent(event: AgentStreamEvent) {
    if (!streamSessionId) return;
    if (event.type === "thread.status" || event.type === "plan.delta") return;
    const agentEvent: AgentEvent = {
      id: randomUUID(),
      sessionId: streamSessionId,
      timestamp: new Date().toISOString(),
      type: getPersistedEventType(event),
      data: getPersistedEventData(event),
    };
    appendEvent(worktreePath, streamSessionId, agentEvent).catch(() => {});
  }

  // Track whether the SSE client is still connected so we avoid writing
  // to a closed response while letting the child process finish its work.
  let clientConnected = true;

  function sseSend(obj: Record<string, unknown>) {
    if (clientConnected) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  }

  sseSend({ type: "started" });

  // Heartbeat keeps the SSE connection alive through idle proxies; the watchdog
  // reaps a child that has gone silent (alive but stalled) so the run fails
  // visibly instead of hanging forever.
  const providerName = provider.name;
  let heartbeat: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let watchdogFired = false;

  function clearStreamTimers() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }

  function resetWatchdog() {
    if (watchdogFired) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(onInactivityTimeout, AGENT_INACTIVITY_TIMEOUT_MS);
  }

  function onInactivityTimeout() {
    watchdogFired = true;
    runTerminated = true;
    const failureEvent: AgentStreamEvent = {
      type: "run.failed",
      sessionId: streamSessionId,
      error: `No output from ${providerName} for ${Math.round(
        AGENT_INACTIVITY_TIMEOUT_MS / 1000
      )}s; stopping the stalled run.`,
      timestamp: new Date().toISOString(),
    };
    sseSend({ type: "ada_event", event: failureEvent });
    // Persist to disk so the failure is visible after reconnects.
    persistAgentEvent(failureEvent);
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000);
    }
  }

  heartbeat = setInterval(() => {
    if (clientConnected) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  resetWatchdog();

  if (resumeSessionId && shouldPersist) {
    persistSessionStart(resumeSessionId).catch(() => {});
  }

  // Forward stderr text and keep fallback approval handling for older prompts.
  child.stderr?.on("data", (data: Buffer) => {
    resetWatchdog();
    const raw = data.toString();
    const text = stripAnsi(raw).trim();

    const filtered = text
      .split("\n")
      .filter((line) => !isBenignProviderStderrLine(line))
      .join("\n")
      .trim();
    if (!filtered) return;

    sseSend({ type: "stderr", text: filtered });

    if (raw.includes("[y/n]")) {
      child.stdin?.write("y\n");
    }
  });

  child.stdout?.on("data", (data: Buffer) => {
    resetWatchdog();
    const raw = data.toString();
    stdoutBuffer += raw;
    if (raw.includes("[y/n]")) {
      child.stdin?.write("y\n");
    }

    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const parsed = parseProviderEvent(line);
          const events = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
          for (const event of events) {
            if (pausedForClaudeUserInput) break;
            eventProcessing = eventProcessing
              .then(async () => {
                // Always persist session metadata on run.started so
                // provider/model are available when loading any session.
                // Only persist individual events for non-Ada providers.
                if (event.type === "run.started") {
                  await persistSessionStart(event.sessionId);
                } else if (
                  shouldPersist &&
                  event.type !== "run.completed" &&
                  event.type !== "run.failed"
                ) {
                  persistAgentEvent(event);
                }
                if (event.type === "run.completed" || event.type === "run.failed") {
                  runTerminated = true;
                }
                sseSend({ type: "ada_event", event });
              })
              .catch(() => {});
            if (providerId === "claude" && event.type === "user.input_requested") {
              pausedForClaudeUserInput = true;
              child.kill("SIGTERM");
            }
          }
        } catch {
          sseSend({
            type: "error",
            text: `Failed to parse ${provider.name} stream JSON line.`,
            raw: line,
          });
        }
      }

      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.on("close", (code, signal) => {
    clearStreamTimers();
    eventProcessing
      .catch(() => {})
      .then(async () => {
        const lastLine = pausedForClaudeUserInput ? "" : stdoutBuffer.trim();
        if (lastLine.length > 0) {
          try {
            const parsed = parseProviderEvent(lastLine);
            const events = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
            for (const event of events) {
              if (pausedForClaudeUserInput) break;
              if (shouldPersist && event.type !== "run.completed" && event.type !== "run.failed") {
                persistAgentEvent(event);
              }
              if (event.type === "run.completed" || event.type === "run.failed") {
                runTerminated = true;
              }
              sseSend({ type: "ada_event", event });
              if (providerId === "claude" && event.type === "user.input_requested") {
                pausedForClaudeUserInput = true;
              }
            }
          } catch {
            sseSend({
              type: "error",
              text: `Failed to parse final ${provider.name} stream JSON line.`,
              raw: lastLine,
            });
          }
        }

        const effectiveExitCode = pausedForClaudeUserInput ? 0 : code;
        const errorPrefix = signal
          ? `${providerName} exited on signal ${signal}`
          : `${providerName} exited with code ${effectiveExitCode}`;
        console.log(`[session] ${errorPrefix} (session=${streamSessionId || "unknown"})`);

        // Emit a synthetic run.failed when the process ended abnormally
        // without already reporting completion or failure via stdout events.
        if (!runTerminated && !pausedForClaudeUserInput && streamSessionId) {
          const errorText =
            signal
              ? `${providerName} process was terminated by signal ${signal}.`
              : effectiveExitCode !== 0
                ? `${providerName} process exited with code ${effectiveExitCode}.`
                : null;
          if (errorText) {
            const failureEvent: AgentStreamEvent = {
              type: "run.failed",
              sessionId: streamSessionId,
              error: errorText,
              timestamp: new Date().toISOString(),
            };
            sseSend({ type: "ada_event", event: failureEvent });
            persistAgentEvent(failureEvent);
          }
        }

        // Update runtime state and lastActiveAt once the stream closes.
        if (streamSessionId) {
          if (!pausedForClaudeUserInput && code === 0) {
            await persistRunDiffEvent(worktreePath, streamSessionId, runStartTree);
          }
          markSessionInactive(streamSessionId);
          getSession(worktreePath, streamSessionId).then((existing) => {
            if (existing) {
              existing.lastActiveAt = new Date().toISOString();
              saveSession(worktreePath, existing);
            }
          }).catch(() => {});
        }

        sseSend({ type: "done", exitCode: effectiveExitCode });
        if (clientConnected) res.end();
      });
  });

  child.on("error", (err) => {
    clearStreamTimers();
    if (streamSessionId) {
      markSessionInactive(streamSessionId);
    }
    sseSend({ type: "error", text: err.message });
    if (clientConnected) res.end();
  });

  // When the client disconnects (e.g. session switch drops the SSE
  // connection), do NOT kill the child — let the agent finish its work.
  // Events are persisted to disk and will be visible when the user
  // navigates back to the session.
  req.on("close", () => {
    clientConnected = false;
    // Stop pinging a gone client, but keep the watchdog so a hung child is
    // still reaped even after the SSE connection drops.
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  });
});

async function streamCodexPlanSession(
  req: Request,
  res: Response,
  options: {
    worktreePath: string;
    worktreeId: string;
    projectId: string;
    runStartTree: string | null;
    message: string;
    resumeSessionId?: string;
    model?: string;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    serviceTier?: "fast" | "flex";
    mode: "default" | "plan";
    providerId: string;
    attachments: AttachmentMetadata[];
  }
) {
  const {
    worktreePath,
    worktreeId,
    projectId,
    runStartTree,
    message,
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
    providerId,
    attachments,
  } = options;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let clientConnected = true;
  let streamSessionId = resumeSessionId ?? "";
  let userMessageWritten = false;
  let finished = false;
  let eventProcessing = Promise.resolve();

  function sseSend(obj: Record<string, unknown>) {
    if (clientConnected) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  }

  async function finishStream(exitCode: number) {
    if (finished) return;
    finished = true;
    if (streamSessionId) {
      if (exitCode === 0) {
        await persistRunDiffEvent(worktreePath, streamSessionId, runStartTree);
      }
      markSessionInactive(streamSessionId);
    }
    await touchSession();
    sseSend({ type: "done", exitCode });
    if (clientConnected) res.end();
  }

  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    markSessionActive(sessionId, {
      provider: providerId,
      metadata: { projectId, worktreeId },
    });
    if (!userMessageWritten) {
      userMessageWritten = true;
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: {
          text: message,
          attachments: attachments.map((attachment) =>
            attachmentPublicMetadata(projectId, worktreeId, attachment)
          ),
        },
      });
    }

    const existing = await getSession(worktreePath, sessionId);
    const title = existing?.title || (message.length > 60 ? `${message.slice(0, 60)}...` : message);
    await saveSession(worktreePath, {
      id: sessionId,
      title,
      workingDirectory: worktreePath,
      worktreeId,
      model: model ?? existing?.model ?? "",
      reasoningEffort: reasoningEffort ?? existing?.reasoningEffort,
      serviceTier: serviceTier ?? existing?.serviceTier,
      provider: providerId,
      mode,
      messages: existing?.messages ?? [],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
      focusPinnedAt: existing?.focusPinnedAt,
      focusDoneAt: existing?.focusDoneAt,
    });
  }

  function persistAgentEvent(event: AgentStreamEvent) {
    if (!streamSessionId) return;
    const agentEvent: AgentEvent = {
      id: randomUUID(),
      sessionId: streamSessionId,
      timestamp: new Date().toISOString(),
      type: getPersistedEventType(event),
      data: getPersistedEventData(event),
    };
    appendEvent(worktreePath, streamSessionId, agentEvent).catch(() => {});
  }

  async function touchSession() {
    if (!streamSessionId) return;
    const existing = await getSession(worktreePath, streamSessionId);
    if (!existing) return;
    existing.lastActiveAt = new Date().toISOString();
    await saveSession(worktreePath, existing);
  }

  const handleEvent = (event: AgentStreamEvent) => {
    eventProcessing = eventProcessing
      .then(async () => {
        if (event.type === "run.started") {
          await persistSessionStart(event.sessionId);
        } else if (
          event.type !== "run.completed" &&
          event.type !== "run.failed" &&
          event.type !== "thread.status" &&
          event.type !== "plan.delta"
        ) {
          persistAgentEvent(event);
        }

        sseSend({ type: "ada_event", event });

        if (event.type === "run.completed" || event.type === "run.failed") {
          if (!streamSessionId) {
            streamSessionId = event.sessionId;
          }
        }
      })
      .catch(() => {});
  };

  sseSend({ type: "started" });

  req.on("close", () => {
    clientConnected = false;
  });

  try {
    const turn = await codexAppServerManager.startPlanTurn(
      {
        message,
        cwd: worktreePath,
        env: await getApiKeyEnvVars(),
        resumeSessionId,
        model,
        reasoningEffort,
        serviceTier,
        mode,
        attachments,
      },
      handleEvent
    );
    await turn.done;
    await eventProcessing;
    await finishStream(0);
  } catch (error) {
    await eventProcessing;
    if (!finished) {
      sseSend({
        type: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      await finishStream(1);
    }
  }
}

function getPersistedEventType(event: AgentStreamEvent): string {
  switch (event.type) {
    case "assistant.text":
      return "assistant_response";
    case "assistant.reasoning":
      return "assistant_reasoning";
    case "tool.call":
      return "tool_call";
    case "tool.result":
      return "tool_result";
    case "plan.updated":
      return "plan_updated";
    case "plan.delta":
      return "plan_delta";
    case "user.input_requested":
      return "user_input_requested";
    case "thread.status":
      return "thread_status";
    default:
      return event.type;
  }
}

function getPersistedEventData(event: AgentStreamEvent): Record<string, unknown> {
  switch (event.type) {
    case "assistant.text":
      return { content: [{ type: "text", text: event.text }] };
    case "assistant.reasoning":
      return { content: [{ type: "reasoning", text: event.text }] };
    case "tool.call":
      return { tool: event.name, input: event.input };
    case "tool.result":
      return { tool: event.name, content: event.content, isError: event.isError };
    case "plan.updated":
      return { explanation: event.explanation, plan: event.plan };
    case "plan.delta":
      return { itemId: event.id, delta: event.delta };
    case "user.input_requested":
      return { itemId: event.id, questions: event.questions };
    case "thread.status":
      return {
        threadId: event.threadId,
        status: event.status,
        activeFlags: event.activeFlags ?? [],
      };
    default:
      return event as Record<string, unknown>;
  }
}

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/stop",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const session = await getSession(worktree.path, req.params.sessionId);
    const runtime = getSessionRuntime(req.params.sessionId);
    const providerId = runtime.provider || session?.provider;

    try {
      if (runtime.child) {
        await stopSessionRuntime(req.params.sessionId);
      } else if (providerId === "codex") {
        await codexAppServerManager.stopSession(req.params.sessionId);
      } else {
        await stopSessionRuntime(req.params.sessionId);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/steer",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const message = req.body.message as string | undefined;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      await codexAppServerManager.steerSession(req.params.sessionId, message);
      await appendEvent(worktree.path, req.params.sessionId, {
        id: randomUUID(),
        sessionId: req.params.sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: { text: message },
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/user-input/dismiss",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    try {
      await appendEvent(worktree.path, req.params.sessionId, {
        id: randomUUID(),
        sessionId: req.params.sessionId,
        timestamp: new Date().toISOString(),
        type: "user_input_response",
        data: { dismissed: true },
      });

      const existing = await getSession(worktree.path, req.params.sessionId);
      if (existing) {
        existing.lastActiveAt = new Date().toISOString();
        await saveSession(worktree.path, existing);
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/user-input",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const answers = req.body.answers as Record<string, string | string[]> | undefined;
    if (!answers || typeof answers !== "object") {
      res.status(400).json({ error: "answers is required" });
      return;
    }

    try {
      const session = await getSession(worktree.path, req.params.sessionId);
      const providerId = session?.provider;
      if (providerId === "claude") {
        const events = await getEvents(worktree.path, req.params.sessionId);
        const resume = buildClaudeUserInputResume(events, answers);
        await appendEvent(worktree.path, req.params.sessionId, {
          id: randomUUID(),
          sessionId: req.params.sessionId,
          timestamp: new Date().toISOString(),
          type: "user_input_response",
          data: { answers },
        });

        if (session) {
          session.lastActiveAt = new Date().toISOString();
          await saveSession(worktree.path, session);
        }

        res.json({ ok: true, ...resume });
        return;
      }

      await codexAppServerManager.submitUserInput(req.params.sessionId, answers);
      await appendEvent(worktree.path, req.params.sessionId, {
        id: randomUUID(),
        sessionId: req.params.sessionId,
        timestamp: new Date().toISOString(),
        type: "user_input_response",
        data: { answers },
      });

      const existing = await getSession(worktree.path, req.params.sessionId);
      if (existing) {
        existing.lastActiveAt = new Date().toISOString();
        await saveSession(worktree.path, existing);
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

function buildClaudeUserInputResume(
  events: AgentEvent[],
  answers: Record<string, string | string[]>
): { resumeMessage: string; resumeMode?: "default" | "plan" } {
  const latestRequest = [...events]
    .reverse()
    .find((event) => event.type === "user_input_requested");
  const questions =
    ((latestRequest?.data.questions as AgentUserInputQuestionForRoute[] | undefined) ?? []).filter(
      Boolean
    );

  if (
    answers.claude_exit_plan_mode === "Approve plan" ||
    answers.claude_exit_plan_mode === "Implement this plan"
  ) {
    return {
      resumeMessage:
        "I approve this plan. You are no longer in plan mode. Proceed with the implementation now.",
      resumeMode: "default",
    };
  }

  if (answers.claude_exit_plan_mode === "Revise plan") {
    return {
      resumeMessage:
        "Please stay in plan mode and revise the plan before implementation. Ask any follow-up questions you need.",
      resumeMode: "plan",
    };
  }

  const lines = ["The user answered your AskUserQuestion tool request:"];
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer == null) continue;
    const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`- ${question.header}: ${question.question}`);
    lines.push(`  Answer: ${answerText}`);
  }
  lines.push("Please continue using these answers.");
  return { resumeMessage: lines.join("\n") };
}

interface AgentUserInputQuestionForRoute {
  id: string;
  header: string;
  question: string;
}

function registerFocusActionRoute(
  route: string,
  action: "pin" | "unpin" | "done"
) {
  sessionsRouter.post(route, async (req, res) => {
    const projectId = req.params.projectId as string;
    const sessionId = req.params.sessionId as string;
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const session = await updateSessionFocus(worktree.path, sessionId, action);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json(session);
  });
}

registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-pin", "pin");
registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-unpin", "unpin");
registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-done", "done");

// Archive a session
sessionsRouter.post(
  "/:projectId/sessions/:sessionId/archive",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }
    const archived = await archiveSession(worktree.path, req.params.sessionId);
    if (!archived) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true });
  }
);

// List sessions for a project
sessionsRouter.get("/:projectId/sessions", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }
  const sessions = await getSessions(worktree.path);
  res.json(sessions);
});

// Get a single session
sessionsRouter.get("/:projectId/sessions/:sessionId", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const worktree = await resolveWorktree(
    req.params.projectId,
    req.query.worktreeId as string | undefined
  );
  if (!worktree) {
    res.status(404).json({ error: "Worktree not found" });
    return;
  }
  const session = await getSession(worktree.path, req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

sessionsRouter.get(
  "/:projectId/sessions/:sessionId/runtime",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json(getSessionRuntime(req.params.sessionId));
  }
);

// Get events for a session
sessionsRouter.get(
  "/:projectId/sessions/:sessionId/events",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }
    const events = await getEvents(worktree.path, req.params.sessionId);
    res.json(dedupeUserMessageEvents(events));
  }
);

/**
 * Collapse consecutive `user_message` events with identical text into a single
 * event, preferring the entry that carries attachments. Some providers (e.g.
 * Ada) write their own `user_message` to the events file, while we also write
 * one to persist attachments. This keeps the UI from showing the same user
 * turn twice when the session is reloaded.
 */
function dedupeUserMessageEvents(events: AgentEvent[]): AgentEvent[] {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === "user_message" &&
      event.type === "user_message" &&
      getUserMessageText(previous) !== "" &&
      getUserMessageText(previous) === getUserMessageText(event)
    ) {
      const previousAttachments = pickUserMessageAttachments(previous);
      const currentAttachments = pickUserMessageAttachments(event);
      result[result.length - 1] = {
        ...previous,
        data: {
          ...previous.data,
          ...event.data,
          attachments: previousAttachments ?? currentAttachments,
        },
      };
      continue;
    }
    result.push(event);
  }
  return result;
}

function getUserMessageText(event: AgentEvent): string {
  const text = (event.data as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function pickUserMessageAttachments(event: AgentEvent): unknown[] | undefined {
  const attachments = (event.data as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments;
}
