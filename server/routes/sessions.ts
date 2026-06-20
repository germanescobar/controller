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
  updateSessionTitle,
  saveSession,
  appendEvent,
  saveAttachment,
  getAttachment,
  getAttachments,
  type AgentEvent,
  type AttachmentMetadata,
} from "../lib/sessions.js";
import {
  buildSessionFocus,
  readSessionFocus,
  resolveSessionFocusState,
  writeSessionFocus,
} from "../lib/focus-state.js";
import { getApiKeyEnvVars } from "../lib/api-keys.js";
import { childProcessEnv } from "../lib/shell-env.js";
import { controllerAgentEnv } from "../lib/controller-cli.js";
import {
  buildControllerPreamble,
  framePreambleForPrompt,
} from "../lib/agent-preamble.js";
import {
  getAgentProvider,
  resolveAgentCommand,
  sendClaudeApprovalDecision,
  type AgentStreamEvent,
  type ClaudeApprovalDecision,
  type ClaudeApprovalRequest,
  type ClaudePermissionSuggestion,
} from "../lib/agents.js";
import { codexAppServerManager } from "../lib/codex-app-server.js";
import {
  buildSkillHistoryMessage,
  buildSkillPrefix,
  extractSkillInvocation,
  getSkillProvider,
} from "../lib/skills.js";
import {
  consumePendingApproval,
  getSessionRuntime,
  markSessionActive,
  markSessionInactive,
  recordPendingApproval,
  stopSessionRuntime,
} from "../lib/session-runtime.js";
import {
  enqueue as enqueueMessage,
  listQueue,
  removeFromQueue,
  dequeueFirst,
  clearQueue,
  type QueuedMessage,
  type QueuedMessageInput,
} from "../lib/session-queue.js";

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

interface SkillResolution {
  /** What we hand to the provider (`<skill block>` + `<user text>`). */
  agentMessage: string;
  /** What we persist to history so the user sees `[/skill: name] <text>` on reload. */
  historyText: string;
}

/**
 * Resolve an optional skill activation for the current turn. Returns the
 * augmented message + history text, or an error string the caller turns
 * into a 400. `skillName === undefined` means "no skill active" and the
 * caller passes the original `message` through unchanged.
 *
 * The orchestrator is the only source of truth for `/<skill-name>`
 * invocations across providers (see issue #98): the agent sees the skill
 * body prepended to the user text, and the session history records the
 * activation with a `[/skill: name] …` marker so the conversation reads
 * naturally on reload.
 */
async function resolveSkillActivation(
  skillName: string | undefined,
  providerId: string,
  cwd: string,
  userText: string
): Promise<SkillResolution | { error: string }> {
  if (!skillName) {
    return { agentMessage: userText, historyText: userText };
  }
  const provider = getSkillProvider(providerId);
  if (!provider) {
    return { error: `Unknown agent provider for skill: ${providerId}` };
  }
  const body = await provider.readBody(skillName, cwd);
  if (!body) {
    return {
      error: `Skill "${skillName}" was not found for ${provider.name}. ` +
        `The agent's slash-command paths are disabled; the orchestrator is the only source of truth.`,
    };
  }
  // Strip a defensive leading `/<name>` from the user text. The orchestrator
  // is the only path, so the message we hand to the agent is the bare user
  // text; the skill block is prepended as system-style context.
  const invocation = extractSkillInvocation(userText);
  const trimmedText =
    invocation && invocation.skillName === body.metadata.name.toLowerCase()
      ? invocation.rest
      : userText;
  return {
    agentMessage: buildSkillPrefix(body.metadata.name, body.body) + trimmedText,
    historyText: buildSkillHistoryMessage(body.metadata.name, trimmedText),
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
    env: childProcessEnv({
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: indexPath,
    }),
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
        env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
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
    env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
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
    env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
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
sessionsRouter.get("/:projectId/sessions/stream", handleSessionStream);

/*
 * Runs one agent turn and streams it to the client over SSE. Also invoked
 * headlessly (with discarding req/res shims) by `advanceSessionQueue` to run
 * the next enqueued message after a turn completes — that path streams to no
 * one but still persists events and advances the queue (see issue #113).
 */
async function handleSessionStream(
  req: Request<{ projectId: string }>,
  res: Response
) {
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
  const skillName = (req.query.skillName as string | undefined)?.trim() || undefined;

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

  // Resolve the requested skill (if any). The orchestrator is the only
  // source of truth for `/<skill-name>` invocations across providers;
  // we read the body server-side at send time so the wire payload gets
  // the freshest `SKILL.md` and the message we hand to the provider
  // already has the skill block prepended (see issue #98).
  const skillResolution = await resolveSkillActivation(
    skillName,
    providerId,
    worktree.path,
    message
  );
  if ("error" in skillResolution) {
    res.status(400).json({ error: skillResolution.error });
    return;
  }
// Always tell the agent it's running inside Controller. Browser tooling is
  // covered by the managed `browser` skill installed on startup.
  //
  // Delivery channel depends on the provider:
  //   - Ada: pass the preamble via `--system-prompt` (real system message, never
  //     echoed in the chat transcript). The skill prefix stays in the user
  //     message because it is per-turn and request-scoped.
  //   - Codex / Claude: prepend to the user message — the only reliable channel
  //     today (Codex ignores collaboration-mode developer instructions in default
  //     mode; Claude's plan mode flows through the stream-json control channel).
  //     The skill prefix, if any, stays after the preamble.
  const controllerPreamble = buildControllerPreamble();
  const usesSystemPrompt = providerId === "ada";
  const agentMessage = usesSystemPrompt
    ? skillResolution.agentMessage
    : framePreambleForPrompt(controllerPreamble) + skillResolution.agentMessage;
  const historyText = skillResolution.historyText;

  const runStartTree = await createWorktreeSnapshot(worktree.path);

  if (providerId === "codex" && attachments.length === 0) {
    await streamCodexPlanSession(req, res, {
      worktreePath: worktree.path,
      worktreeId: worktree.id,
      projectId: req.params.projectId,
      runStartTree,
      message: agentMessage,
      historyText,
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
    message: agentMessage,
    cwd: worktree.path,
    env: { ...apiKeyEnv, ...controllerAgentEnv() },
    command: resolvedCommand,
    attachments,
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
    systemPrompt: usesSystemPrompt ? controllerPreamble : undefined,
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
  // True when the most recent terminal event we streamed was
  // `run.cancelled` (i.e. Ada exited cleanly with code 130 after a
  // cooperative abort). When the child then closes with a non-zero
  // status, we must NOT synthesize a `run.failed` on top of it — the
  // synthetic banner is the exact bug this flag exists to prevent
  // (see issue #94).
  let runCancelled = false;
  // True while a plan-mode Claude approval prompt is awaiting the user's
  // decision. The process is intentionally idle then, so the inactivity
  // watchdog must stand down until the user answers and Claude resumes.
  let awaitingApproval = false;

  // Close stdin for CLIs that otherwise wait on an open pipe. We pass the
  // prompt as an argv argument, so these providers don't need stdin; leaving
  // it open has been observed to make Ada hang silently mid-run. Plan-mode
  // Claude is the exception: it streams the prompt and live approval decisions
  // over stdin, so its pipe must stay open for the whole turn.
  const claudeUsesControlChannel = providerId === "claude" && mode === "plan";
  if (
    providerId === "ada" ||
    providerId === "codex" ||
    (providerId === "claude" && !claudeUsesControlChannel)
  ) {
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
      const skillMarker = parseSkillMarker(historyText);
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: {
          text: historyText,
          ...(skillMarker ? { skillName: skillMarker.skillName } : {}),
          attachments: attachments.map((attachment) =>
            attachmentPublicMetadata(req.params.projectId, worktreeId, attachment)
          ),
        },
      });
    }
    // Merge with existing session file (preserve title/createdAt from earlier messages).
    // Only auto-generate a title for brand-new sessions; for existing ones we keep
    // whatever the title is — including an intentional absence the user cleared.
    const existing = await getSession(worktreePath, sessionId);
    const title = existing
      ? existing.title
      : historyText.length > 60
        ? historyText.slice(0, 60) + "..."
        : historyText;
    // Focus state lives in a Controller-owned sidecar, not on the
    // agent session file: Ada's `SessionStore.save()` (and similar
    // writers) would silently drop our fields on every save, so a
    // brand-new session's auto-pin would vanish within ~1s. See
    // issue #139 / #140.
    const existingFocus = await readSessionFocus(worktreePath, sessionId);
    const focus = resolveSessionFocusState(existingFocus);
    await writeSessionFocus(
      worktreePath,
      buildSessionFocus(sessionId, focus)
    );
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
    });
    // Notify the client if the session was auto-pinned so it can update
    // the focus-queue indicator without a full page reload.
    if (focus.focusPinnedAt && !existingFocus?.focusPinnedAt) {
      sseSend({ type: "session_focus", focusPinnedAt: focus.focusPinnedAt });
    }
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
    // A pending approval is a deliberate wait on the user, not a stalled run.
    if (awaitingApproval) {
      watchdog = undefined;
      return;
    }
    watchdog = setTimeout(onInactivityTimeout, AGENT_INACTIVITY_TIMEOUT_MS);
  }

  function onInactivityTimeout() {
    watchdogFired = true;
    runTerminated = true;
    // If the run was already cancelled cooperatively, the inactivity
    // timeout is firing *because* the process is winding down on
    // SIGINT — Ada may be silent in the gap between the `run.cancelled`
    // event and the final exit. Reap the child silently so the run
    // ends, but do NOT emit a second terminal event on top of the
    // `run.cancelled` we already streamed (issue #94).
    if (runCancelled) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 2000);
      }
      return;
    }
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
                  event.type !== "run.failed" &&
                  event.type !== "run.cancelled"
                ) {
                  persistAgentEvent(event);
                }
                if (
                  event.type === "run.completed" ||
                  event.type === "run.failed" ||
                  event.type === "run.cancelled"
                ) {
                  runTerminated = true;
                  runCancelled = event.type === "run.cancelled";
                }
                // Stash the pending approval in memory before the client sees
                // it, so a decision can be answered without racing disk I/O.
                if (event.type === "tool.approval_requested" && streamSessionId) {
                  recordPendingApproval(streamSessionId, {
                    requestId: event.id,
                    toolName: event.toolName,
                    input: event.input,
                    suggestions: event.suggestions,
                  });
                }
                sseSend({ type: "ada_event", event });
              })
              .catch(() => {});
            if (providerId === "claude" && event.type === "user.input_requested") {
              pausedForClaudeUserInput = true;
              child.kill("SIGTERM");
            }
            // Stand the watchdog down while an approval is pending, and re-arm
            // it the moment Claude resumes with any other event. Done
            // synchronously so the timer reacts without waiting on the async
            // persistence chain.
            if (event.type === "tool.approval_requested") {
              awaitingApproval = true;
              if (watchdog) {
                clearTimeout(watchdog);
                watchdog = undefined;
              }
            } else if (awaitingApproval) {
              awaitingApproval = false;
              resetWatchdog();
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
              if (
                shouldPersist &&
                event.type !== "run.completed" &&
                event.type !== "run.failed" &&
                event.type !== "run.cancelled"
              ) {
                persistAgentEvent(event);
              }
              if (
                event.type === "run.completed" ||
                event.type === "run.failed" ||
                event.type === "run.cancelled"
              ) {
                runTerminated = true;
                runCancelled = event.type === "run.cancelled";
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
        // Skip this entirely when the run was cancelled cooperatively:
        // Ada emits `run.cancelled` and then exits with code 130, which
        // is *not* an abnormal termination — surfacing both events would
        // produce the misleading "Ada process exited with code 130" banner
        // (see issue #94).
        if (
          !runTerminated &&
          !runCancelled &&
          !pausedForClaudeUserInput &&
          streamSessionId
        ) {
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

        // On a clean completion, run the next enqueued message (if any).
        // This happens server-side so the queue drains regardless of
        // whether any client is connected (see issue #113).
        if (streamSessionId && !pausedForClaudeUserInput && code === 0) {
          void advanceSessionQueue(req.params.projectId, worktreeId, streamSessionId);
        }
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
}

/*
 * After a turn completes cleanly, run the next enqueued message for the
 * session. Queued runs always resume an existing session, so we have every
 * parameter we need and replay them through `handleSessionStream` with
 * discarding req/res shims. Each headless run advances the queue again on
 * completion, so the whole queue drains one-at-a-time without a client.
 */
async function advanceSessionQueue(
  projectId: string,
  worktreeId: string,
  sessionId: string
): Promise<void> {
  let next: QueuedMessage | null;
  try {
    next = await dequeueFirst(sessionId);
  } catch {
    return;
  }
  if (!next) return;

  const sink = makeHeadlessStreamResponse();
  let threw = false;
  try {
    await handleSessionStream(
      makeHeadlessStreamRequest(projectId, worktreeId, sessionId, next),
      sink.res
    );
  } catch (error) {
    threw = true;
    console.error(
      `[session] headless queue run errored (session=${sessionId}):`,
      error instanceof Error ? error.message : error
    );
  }

  // If the replay actually started a run, that run's own completion handler
  // advances the queue again — nothing more to do here.
  if (sink.didStart() && !threw) return;

  // The replay never started (failed preflight — e.g. a deleted skill, a
  // missing attachment, or an unavailable provider — or threw). A single
  // un-startable item must not stall the rest of the queue, so surface the
  // failure and drain the next message. We do not re-enqueue the bad item:
  // a permanently-broken item would otherwise retry forever.
  markSessionInactive(sessionId);
  await recordQueueAdvanceFailure(projectId, worktreeId, sessionId, next);
  await advanceSessionQueue(projectId, worktreeId, sessionId);
}

/** Persist a visible error for a queued message that could not be started. */
async function recordQueueAdvanceFailure(
  projectId: string,
  worktreeId: string,
  sessionId: string,
  message: QueuedMessage
): Promise<void> {
  try {
    const worktree = await resolveWorktree(projectId, worktreeId);
    if (!worktree) return;
    const preview =
      message.visibleText.length > 80
        ? `${message.visibleText.slice(0, 80)}…`
        : message.visibleText;
    await appendEvent(worktree.path, sessionId, {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        text: `Skipped a queued message that could not be started: "${preview}"`,
      },
    });
  } catch {
    // Best-effort: the console error above already records the failure.
  }
}

/* Minimal Express request carrying a queued message's run params as query. */
function makeHeadlessStreamRequest(
  projectId: string,
  worktreeId: string,
  sessionId: string,
  message: QueuedMessage
): Request<{ projectId: string }> {
  const query: Record<string, string> = {
    worktreeId,
    message: message.text,
    resumeSessionId: sessionId,
    provider: message.provider,
    mode: message.mode,
  };
  if (message.model) query.model = message.model;
  if (message.reasoningEffort) query.reasoningEffort = message.reasoningEffort;
  if (message.serviceTier) query.serviceTier = message.serviceTier;
  if (message.attachmentIds.length) {
    query.attachmentIds = message.attachmentIds.join(",");
  }
  if (message.skillName) query.skillName = message.skillName;
  return {
    params: { projectId },
    query,
    on: () => undefined,
  } as unknown as Request<{ projectId: string }>;
}

/*
 * Minimal Express response that discards all stream output. `didStart`
 * reports whether the handler reached `writeHead` (i.e. a run actually
 * started streaming) versus bailing out via an error status — which lets
 * `advanceSessionQueue` tell a started run from a failed preflight.
 */
function makeHeadlessStreamResponse(): {
  res: Response;
  didStart: () => boolean;
} {
  let started = false;
  const res = {
    writeHead: () => {
      started = true;
      return res;
    },
    write: () => true,
    end: () => res,
    status: () => res,
    json: () => res,
  } as unknown as Response;
  return { res, didStart: () => started };
}

async function streamCodexPlanSession(
  req: Request,
  res: Response,
  options: {
    worktreePath: string;
    worktreeId: string;
    projectId: string;
    runStartTree: string | null;
    message: string;
    /** What to persist to history (e.g. `[/skill: name] <text>`). */
    historyText: string;
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
    historyText,
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

    // Drain the next enqueued message on a clean completion (server-side,
    // independent of any client; see issue #113).
    if (streamSessionId && exitCode === 0) {
      void advanceSessionQueue(projectId, worktreeId, streamSessionId);
    }
  }

  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    markSessionActive(sessionId, {
      provider: providerId,
      metadata: { projectId, worktreeId },
    });
    if (!userMessageWritten) {
      userMessageWritten = true;
      const skillMarker = parseSkillMarker(historyText);
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: {
          text: historyText,
          ...(skillMarker ? { skillName: skillMarker.skillName } : {}),
          attachments: attachments.map((attachment) =>
            attachmentPublicMetadata(projectId, worktreeId, attachment)
          ),
        },
      });
    }

    // Only auto-generate a title for brand-new sessions; for existing ones we keep
    // whatever the title is — including an intentional absence the user cleared.
    const existing = await getSession(worktreePath, sessionId);
    const title = existing
      ? existing.title
      : historyText.length > 60
        ? `${historyText.slice(0, 60)}...`
        : historyText;
    // Focus state lives in a Controller-owned sidecar; see the
    // SSE-stream persistSessionStart for the rationale (issue #139).
    const existingFocus = await readSessionFocus(worktreePath, sessionId);
    const focus = resolveSessionFocusState(existingFocus);
    await writeSessionFocus(
      worktreePath,
      buildSessionFocus(sessionId, focus)
    );
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
    });
    if (focus.focusPinnedAt && !existingFocus?.focusPinnedAt) {
      sseSend({ type: "session_focus", focusPinnedAt: focus.focusPinnedAt });
    }
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
        env: { ...(await getApiKeyEnvVars()), ...controllerAgentEnv() },
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
    case "tool.approval_requested":
      return "tool_approval_requested";
    case "thread.status":
      return "thread_status";
    case "run.cancelled":
      return "run_cancelled";
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
    case "tool.approval_requested":
      return {
        requestId: event.id,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions,
      };
    case "thread.status":
      return {
        threadId: event.threadId,
        status: event.status,
        activeFlags: event.activeFlags ?? [],
      };
    case "run.cancelled":
      return { reason: event.reason };
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

// --- Message queue ---
//
// Messages typed while an agent is streaming are enqueued and replayed
// one-at-a-time once the active run completes cleanly. The queue is keyed by
// session id and persisted under the orchestrator home (see session-queue.ts
// and issue #113). Advancement is server-driven (see advanceSessionQueue);
// these endpoints are plain CRUD over the persisted queue.

sessionsRouter.get(
  "/:projectId/sessions/:sessionId/queue",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const queue = await listQueue(req.params.sessionId);
      res.json({ queue });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/queue",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const input = parseQueuedMessageInput(req.body);
    if (!input) {
      res.status(400).json({ error: "Invalid queued message payload" });
      return;
    }
    try {
      const message = await enqueueMessage(req.params.sessionId, input);
      res.json({ message });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.delete(
  "/:projectId/sessions/:sessionId/queue/:messageId",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const removed = await removeFromQueue(
        req.params.sessionId,
        req.params.messageId
      );
      if (!removed) {
        res.status(404).json({ error: "Queued message not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/** Validate and normalize an enqueue request body into a QueuedMessageInput. */
function parseQueuedMessageInput(body: unknown): QueuedMessageInput | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!text.trim()) return null;
  if (typeof raw.provider !== "string" || !raw.provider) return null;
  if (typeof raw.model !== "string" || !raw.model) return null;

  const mode = raw.mode === "plan" ? "plan" : "default";
  const attachmentIds = Array.isArray(raw.attachmentIds)
    ? raw.attachmentIds.filter((id): id is string => typeof id === "string")
    : [];
  const reasoningEffort =
    typeof raw.reasoningEffort === "string"
      ? (raw.reasoningEffort as QueuedMessageInput["reasoningEffort"])
      : undefined;

  return {
    text,
    visibleText: typeof raw.visibleText === "string" ? raw.visibleText : text,
    provider: raw.provider,
    model: raw.model,
    reasoningEffort,
    serviceTier: raw.serviceTier === "fast" ? "fast" : undefined,
    mode,
    attachmentIds,
    skillName: typeof raw.skillName === "string" ? raw.skillName : undefined,
  };
}

/**
 * Answer a pending Claude tool-approval prompt on the live process. Unlike
 * `/user-input`, this writes the decision to the still-running child's control
 * channel rather than resuming a new turn.
 */
sessionsRouter.post(
  "/:projectId/sessions/:sessionId/tool-approval",
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

    const requestId = req.body.requestId as string | undefined;
    const decision = req.body.decision as unknown;
    if (!requestId || !isApprovalDecision(decision)) {
      res
        .status(400)
        .json({ error: "requestId and a valid decision are required" });
      return;
    }

    const runtime = getSessionRuntime(req.params.sessionId);
    if (!runtime.active || !runtime.child) {
      res
        .status(409)
        .json({ error: "This session has no running process to approve against." });
      return;
    }

    // The decision is built from server-tracked state (tool input + permission
    // suggestions), never from the client. Prefer the in-memory record; fall
    // back to the persisted event so an approval survives a page reload.
    const pending =
      consumePendingApproval(req.params.sessionId, requestId) ??
      findPendingApproval(
        await getEvents(worktree.path, req.params.sessionId),
        requestId
      );
    if (!pending) {
      res.status(404).json({ error: "No pending approval matches this request." });
      return;
    }

    const sent = sendClaudeApprovalDecision(runtime.child, pending, decision);
    if (!sent) {
      res
        .status(409)
        .json({ error: "The session process is no longer accepting input." });
      return;
    }

    await appendEvent(worktree.path, req.params.sessionId, {
      id: randomUUID(),
      sessionId: req.params.sessionId,
      timestamp: new Date().toISOString(),
      type: "tool_approval_response",
      data: { requestId, decision },
    });

    res.json({ ok: true });
  }
);

function isApprovalDecision(value: unknown): value is ClaudeApprovalDecision {
  return value === "allow_once" || value === "always_allow" || value === "deny";
}

function findPendingApproval(
  events: AgentEvent[],
  requestId: string
): ClaudeApprovalRequest | null {
  const request = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "tool_approval_requested" &&
        event.data.requestId === requestId
    );
  if (!request) return null;
  return {
    requestId,
    toolName: (request.data.toolName as string | undefined) ?? "tool",
    input: (request.data.input as Record<string, unknown> | undefined) ?? {},
    suggestions: Array.isArray(request.data.suggestions)
      ? (request.data.suggestions as ClaudePermissionSuggestion[])
      : [],
  };
}

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
    // Drop any pending enqueued messages so an archived session leaves no
    // orphaned queue file behind.
    await clearQueue(req.params.sessionId);
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

// Update a session's editable fields (currently just the title).
sessionsRouter.patch("/:projectId/sessions/:sessionId", async (req, res) => {
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
  const { title } = req.body as { title?: unknown };
  if (typeof title !== "string") {
    res.status(400).json({ error: "title must be a string" });
    return;
  }
  const session = await updateSessionTitle(
    worktree.path,
    req.params.sessionId,
    title
  );
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
 * Collapse consecutive `user_message` events that represent the same turn.
 *
 * Two cases trigger a collapse:
 *
 * 1. **Identical text.** The orchestrator and the agent sometimes each write
 *    a `user_message` for the same turn (the orchestrator to persist
 *    attachments, the agent to log what it received). Identical text means
 *    the same turn.
 *
 * 2. **Skill marker vs. agent echo.** When a skill is active the orchestrator
 *    writes a `user_message` whose text is `[/skill: name] <user text>`, and
 *    the agent writes its own `user_message` with the full prompt (skill
 *    body + user text). The two texts differ, but the orchestrator's text is
 *    the canonical user turn; the agent's is just an echo of the wire
 *    payload. Collapse them, keeping the orchestrator's marker so the UI
 *    can render a `Skill: <name>` badge.
 */
export function dedupeUserMessageEvents(events: AgentEvent[]): AgentEvent[] {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === "user_message" &&
      event.type === "user_message"
    ) {
      const previousText = getUserMessageText(previous);
      const currentText = getUserMessageText(event);

      if (previousText !== "" && previousText === currentText) {
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

      const previousMarker = parseSkillMarker(previousText);
      if (
        previousMarker &&
        !parseSkillMarker(currentText) &&
        currentText.endsWith(previousMarker.rest) &&
        currentText.includes(previousMarker.rest)
      ) {
        // The previous event is the orchestrator's `[/skill: name] <rest>`
        // marker, and the current one is the agent's echo of the same turn
        // (the full prompt it received, which contains the same `<rest>` as
        // a suffix). Keep the marker as the canonical text — it carries
        // the skill tag for the UI. Inherit the echo's attachments only
        // when the marker has none.
        const previousAttachments = pickUserMessageAttachments(previous);
        const currentAttachments = pickUserMessageAttachments(event);
        result[result.length - 1] = {
          ...previous,
          data: {
            ...previous.data,
            attachments: previousAttachments ?? currentAttachments,
          },
        };
        continue;
      }

      // The reverse ordering: the agent wrote the echo first, the
      // orchestrator's marker second. Keep the marker (drop the previous
      // echo) and inherit any attachments the echo may have carried.
      const currentMarker = parseSkillMarker(currentText);
      if (
        currentMarker &&
        !previousMarker &&
        previousText.endsWith(currentMarker.rest) &&
        previousText.includes(currentMarker.rest)
      ) {
        const previousAttachments = pickUserMessageAttachments(previous);
        const currentAttachments = pickUserMessageAttachments(event);
        result[result.length - 1] = {
          ...event,
          data: {
            ...event.data,
            attachments: currentAttachments ?? previousAttachments,
          },
        };
        continue;
      }
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

export function parseSkillMarker(
  text: string
): { skillName: string; rest: string } | null {
  const match = /^\[\/skill:\s*([A-Za-z0-9._-]+)\]\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { skillName: match[1], rest: match[2] };
}
