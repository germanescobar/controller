import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getProject, getProjects } from "../lib/projects.js";
import {
  getProjectWorktrees,
  resolveWorktree,
  worktreeNotFoundPayload,
} from "../lib/worktrees.js";

const execAsync = promisify(exec);
import {
  getSessions,
  getSessionSummaries,
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
  sendAnitaApprovalDecision,
  sendClaudeApprovalDecision,
  signalAgentProcess,
  type AgentStreamEvent,
  type ClaudeApprovalDecision,
  type ClaudeApprovalRequest,
  type ClaudePermissionSuggestion,
} from "../lib/agents.js";
import { getAgentSetting } from "../lib/agent-settings.js";
import { codexAppServerManager } from "../lib/codex-app-server.js";
import { canonicalProviderId, DEFAULT_PROVIDER_ID } from "../lib/provider-id.js";
import {
  buildSkillHistoryMessage,
  buildSkillPrefix,
  extractSkillInvocation,
  getSkillProvider,
} from "../lib/skills.js";
import { resolveMentions, parseMentionsQuery } from "../lib/mentions.js";
import {
  consumePendingApproval,
  getSessionRuntime,
  markSessionActive,
  markSessionInactive,
  recordSessionAttentionEvent,
  setSessionAwaitingUserInput,
  stopSessionRuntime,
} from "../lib/session-runtime.js";
import {
  emitSessionAdded,
  emitSessionRemoved,
  emitSessionUpdated,
} from "../lib/events.js";
import {
  enqueue as enqueueMessage,
  listQueue,
  removeFromQueue,
  dequeueFirst,
  resolveQueuedMessage,
  clearQueue,
  withSessionQueueTransaction,
  type QueuedMessage,
  type QueuedMessageInput,
} from "../lib/session-queue.js";
import { acceptCodexSteer } from "../lib/codex-steer.js";
import { locateSessionById } from "../lib/session-locator.js";

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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
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
 * Start a new session headlessly (issue #190).
 *
 * The CLI / automation surface for kicking off a new agent run without
 * owning an SSE connection. Mirrors `GET /sessions/stream` — same body
 * validation, same provider dispatch, same persistence pipeline — but
 * responds with `{ sessionId, url }` once the first `run.started` event
 * lands, so the caller can hand the sessionId back to a human to follow
 * along in the UI.
 *
 * `url` is a `controller://project/<id>/worktree/<id>/session/<id>`
 * reference. The orchestrator's React app doesn't expose a public URL
 * scheme yet, so the URI is informational; the in-app sidebar picks the
 * session up automatically because the persistence layer already wrote
 * the session file by the time we return.
 */
sessionsRouter.post("/:projectId/sessions", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = (req.body ?? {}) as {
    worktreeId?: string;
    message?: string;
    provider?: string;
    model?: string;
    mode?: "default" | "plan";
    skillName?: string;
    attachmentIds?: string[];
    mentions?: { path?: unknown; type?: unknown }[];
    reasoningEffort?: string;
    serviceTier?: "fast" | "flex";
    resumeSessionId?: string;
    // Optional parent session id (issue #353). When the CLI runs
    // `controller sessions start --parent <id>` (or `--parent self`,
    // which the CLI resolves to the calling session via the
    // `CONTROLLER_SESSION_ID` env var the orchestrator injects), the
    // resolved id is sent here. The new session's `SessionState.parentId`
    // is set to it before the run starts; subsequent
    // `controller sessions list --parent <id>` calls filter on it, and
    // the coordinator pattern from #351 reads it. Set once; never
    // mutated afterwards.
    parentId?: string;
  };
  const worktreeId = body.worktreeId;
  const message = body.message;
  if (typeof worktreeId !== "string" || !worktreeId) {
    res.status(400).json({ error: "worktreeId is required" });
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const mode: "default" | "plan" = body.mode === "plan" ? "plan" : "default";
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === "string")
    : [];

  // Reuse the SSE handler's validation + persistence path. The shim
  // response intercepts `writeHead(200, ...)` to hold the real response
  // open, captures the first `run.started` event to learn the agent's
  // sessionId, then flushes a JSON 200 with `{ sessionId, url }`. Any
  // preflight failure (handler returns 4xx before `writeHead`) is
  // forwarded as a JSON error. Subsequent stream events are discarded
  // — the persistence layer already wrote them to disk, and the UI
  // subscribes to the existing `GET /sessions/:sessionId/events`
  // endpoint to render the transcript live.
  const shim = makeSessionStartShim(project.id, worktreeId, res);
  try {
    await handleSessionStream(
      makeHeadlessSessionStartRequest(req, project.id, worktreeId, {
        message,
        provider: body.provider,
        model: body.model,
        mode,
        skillName: body.skillName,
        attachmentIds,
        mentions: Array.isArray(body.mentions)
          ? body.mentions.filter(
              (entry): entry is { path: string; type: "file" | "directory" } =>
                Boolean(entry) &&
                typeof (entry as { path?: unknown }).path === "string" &&
                ((entry as { type?: unknown }).type === "file" ||
                  (entry as { type?: unknown }).type === "directory"),
            )
          : undefined,
        reasoningEffort: body.reasoningEffort,
        serviceTier: body.serviceTier,
        resumeSessionId: body.resumeSessionId,
        parentId: body.parentId,
      }),
      shim.res
    );
  } catch (error) {
    shim.fail(error instanceof Error ? error.message : String(error));
  }
});

/*
 * `POST /api/projects/:projectId/sessions/branch` (issue #364).
 *
 * Forks an existing session into a brand-new session whose transcript is
 * a copy of the source session's transcript up to (and including) the
 * user's first new message. The first turn of the new branch can run on
 * a different provider / model / mode than the source; later turns use
 * whatever the user picks in the composer (the source's defaults).
 *
 * Wire shape (JSON body):
 *   {
 *     "sourceSessionId": "<sid>",
 *     "message":         "<first message text — optional; see below>",
 *     "provider":        "<optional, defaults to source.provider>",
 *     "model":           "<optional, defaults to source.model>",
 *     "mode":            "<optional, defaults to source.mode>",
 *     "title":           "<optional, defaults to 'Branch of <sourceTitle>'>"
 *   }
 *
 * `message` is optional for the UI's empty-prompt branch ("click the
 * branch icon, land on an empty composer"). The route still spawns an
 * agent in that case — the agent runs an empty/branch-marker-only turn
 * to establish a real provider thread, and the agent's reported
 * `sessionId` becomes the new session's id. This is critical: the
 * session file's id is what the provider's `--resume` (or Codex's
 * `thread/resume`) reads on subsequent turns, so a Controller-chosen
 * UUID with no provider backing would cause the user's first real turn
 * on the branched session to fail (PR review P1 from chatgpt-codex-
 * connector on #381). The CLI verb still requires a non-empty
 * `message` upstream (the CLI is the caller that's expected to start
 * the first turn).
 *
 * Returns `{ sessionId, url }` once the agent's first `run.started` event
 * lands — same shape as the headless `POST /sessions` endpoint so the
 * CLI's `printStartResult` helper works unchanged. The new session id
 * is always the agent's own id (the agents pick their session ids; we
 * cannot pre-create a session file keyed by a Controller-chosen UUID
 * because resume would then target a nonexistent provider thread).
 *
 * Implementation notes:
 *   - We resolve the source via `locateSessionById` (issue #339 review's
 *     cross-worktree walk) so a branch request from any project reaches
 *     the source no matter which worktree it lives on.
 *   - The new session inherits the source's worktree — a branch
 *     continues on the same checkout, not a fresh clone. Cross-worktree
 *     branches are out of scope (the issue calls this out explicitly).
 *   - The branch marker is the `[/branch: <sourceProvider>-><targetProvider>/<targetModel>] <text>`
 *     prefix on the user's first message. The same prefix is what the
 *     agent sees as the prompt; the linkifier would render it as a
 *     clickable badge in a future UI pass.
 *   - We use the same `handleSessionStream` pipeline as `start` and
 *     pass `seedFromSessionId` so the persistence layer can prepend
 *     the source's events to the new session's events file once the
 *     agent has reported its sessionId. The seed runs *after*
 *     `persistSessionStart` writes the first user_message event so the
 *     chat-view order is `[...sourceEvents, branchMarker]`.
 *   - The first turn's provider / model / mode (passed via the standard
 *     query params) affect only the agent spawn. The session defaults
 *     (which the model picker falls back to after the first turn) come
 *     from the source — that's the `[/branch: …]` "one-time marker"
 *     semantic the issue describes.
 */
sessionsRouter.post("/:projectId/sessions/branch", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    sourceSessionId?: string;
    message?: string;
    provider?: string;
    model?: string;
    mode?: "default" | "plan";
    title?: string;
  };
  const sourceSessionId = body.sourceSessionId;
  const message = body.message;
  if (typeof sourceSessionId !== "string" || !sourceSessionId) {
    res.status(400).json({ error: "sourceSessionId is required" });
    return;
  }
  // `message` is optional in the empty-prompt shortcut (see the route
  // doc above) — when absent the route seeds the new session and
  // returns synchronously without spawning an agent. The CLI verb
  // still requires a non-empty `message` because the CLI is the
  // caller that's expected to *start* the first turn, not just
  // fork the transcript.
  if (message !== undefined && typeof message !== "string") {
    res.status(400).json({ error: "message must be a string" });
    return;
  }
  // Cross-project branches aren't supported — the source must live in
  // the same project the route is mounted on. `getProjectWorktrees`
  // returns every worktree of the project, so we just need the source
  // to be discoverable through the registry.
  const located = await locateSessionById(sourceSessionId);
  if (!located) {
    res.status(404).json({ error: "Source session not found" });
    return;
  }
  if (located.projectId !== req.params.projectId) {
    res.status(400).json({
      error: "Source session must live in the same project as the branch",
    });
    return;
  }
  const { session: sourceSession, worktreeId } = located;
  // Default to the source's provider/model/mode. The CLI flags
  // (`--provider`, `--model`, `--mode`) override per the precedence
  // order documented in the issue (#364 design §2): explicit flag >
  // source defaults. The first turn's provider/model/mode are
  // forwarded to `handleSessionStream` as standard query params;
  // the session defaults (which the model picker falls back to
  // after the first turn) come from the source via
  // `seedFromSessionId`.
  //
  // `mode` honors `body.mode ?? sourceSession.mode ?? "default"` —
  // a plain `branch <src>` on a plan-mode source must continue in
  // plan mode (PR review P2 from chatgpt-codex-connector on #365).
  const requestedProvider = body.provider || sourceSession.provider;
  const requestedModel = body.model || sourceSession.model;
  const requestedMode: "default" | "plan" =
    body.mode === "plan"
      ? "plan"
      : body.mode === "default"
        ? "default"
        : (sourceSession.mode ?? "default");
  // Build the branch marker the agent sees as the first message.
  // Same shape as the `[/from: …]` / `[/skill: …]` markers the
  // linkifier already parses, so a future UI pass can render it as a
  // clickable badge without a new link format.
  const sourceLabel =
    sourceSession.provider && sourceSession.model
      ? `${sourceSession.provider}/${sourceSession.model}`
      : (sourceSession.provider ?? sourceSession.model ?? "source");
  const targetLabel =
    requestedProvider && requestedModel
      ? `${requestedProvider}/${requestedModel}`
      : (requestedProvider ?? requestedModel ?? sourceLabel);
  const branchMarkerText = message && message.trim()
    ? `[/branch: ${sourceLabel}->${targetLabel}] ${message.trim()}`
    : `[/branch: ${sourceLabel}->${targetLabel}]`;
  // The empty-message UI branch (no `message` on the wire) still goes
  // through the agent-spawned SSE path below. We could pre-seed the
  // session file and skip the agent entirely, but that would give the
  // branched session a Controller-chosen id with no provider backing —
  // subsequent `POST /sessions` calls would then send that id as
  // `resumeSessionId` and the provider would try to `--resume` (or
  // `thread/resume`) against a nonexistent thread. The first real
  // turn the user types on the branched session would fail (PR
  // review P1 from chatgpt-codex-connector on #381). Spawning an
  // agent at branch time costs ~1s of startup and produces a brief
  // "ready" turn the chat view shows above the empty composer, but
  // it leaves the user on a real provider thread — the first real
  // turn resumes cleanly.
  // Render the source's stored transcript into a plain-text block so
  // the branched agent sees the prior conversation as part of its
  // first-turn context. Without this, "review the proposal above"
  // would start a context-free run; the chat view would show the
  // copied transcript, but the agent itself would have no idea what
  // it was reviewing (PR review P1 from chatgpt-codex-connector on
  // #365). The chat view still reads from the events file
  // independently — this block is purely for the agent's prompt.
  const sourceTranscriptBlock = renderSourceTranscriptForAgent(
    sourceSession.messages
  );
  const agentFirstTurnMessage = sourceTranscriptBlock
    ? `${sourceTranscriptBlock}\n\n${branchMarkerText}`
    : branchMarkerText;
  // Reuse the headless session-start shim (same `{ sessionId, url }`
  // contract as `POST /sessions`). The seed runs inside the SSE
  // handler via `seedFromSessionId`.
  const shim = makeSessionStartShim(project.id, worktreeId, res);
  try {
    await handleSessionStream(
      makeHeadlessSessionStartRequest(req, project.id, worktreeId, {
        // `message` is the agent's first-turn prompt — we pass the
        // transcript + branch marker here so the branched agent
        // sees the prior context as part of its prompt (issue #364
        // + PR review P1 from chatgpt-codex-connector on #365).
        // `historyText` (passed below) is what the persistence layer
        // records as the user_message event — we keep that as the
        // pure `branchMarkerText` so the chat transcript still
        // shows the audit-friendly marker, not the inlined
        // transcript.
        message: agentFirstTurnMessage,
        historyText: branchMarkerText,
        provider: requestedProvider,
        model: requestedModel,
        mode: requestedMode,
        attachmentIds: [],
        // `seedFromSessionId` is the only branch-specific knob — the
        // SSE handler honors it once `run.started` lands.
        seedFromSessionId: sourceSessionId,
        // `seedTitle` plumbs the caller's `--title` flag (or the
        // omitted-default `Branch of <sourceTitle>`) into
        // `seedBranchFromSource`. We don't pre-derive the title
        // here because the persistence layer already ran
        // `deriveAutoTitle` from the branch-marker text — passing an
        // explicit `seedTitle` lets the seed step either honor the
        // caller's override or fall back to a saner auto-name.
        seedTitle:
          body.title && body.title.trim()
            ? body.title.trim()
            : sourceSession.title
              ? `Branch of ${sourceSession.title}`
              : undefined,
        // `parentId` ties the new session to its source so
        // `controller sessions list --parent <sourceId>` (issue #353)
        // groups every branch under the source automatically.
        parentId: sourceSessionId,
        // Mark the branched session as `unstarted` so the
        // composer's provider/model/mode pickers stay unlocked
        // until the user types their first real turn (PR review
        // P2 from chatgpt-codex-connector on #381). Without this,
        // the existing `disabled={!!sessionId}` on the provider
        // picker would lock the user into the source's provider
        // on their first turn, contradicting the spec's "Agent
        // selector is enabled on that first turn" affordance.
        unstarted: true,
      }),
      shim.res
    );
  } catch (error) {
    shim.fail(error instanceof Error ? error.message : String(error));
  }
});

/*
 * Build a minimal Express request shim that `handleSessionStream` accepts.
 * The SSE handler reads everything from `req.query`; we put the JSON body
 * through the same shape so the validation + provider dispatch paths run
 * unchanged. We intentionally drop `req.on("close", ...)` so the real HTTP
 * client closing the response is decoupled from the agent process — the
 * run continues even if the CLI exits immediately after printing the URL.
 */
export function makeHeadlessSessionStartRequest(
  req: Request<{ projectId: string }> | undefined,
  projectId: string,
  worktreeId: string,
  body: {
    message: string;
    /**
     * Override the text the persistence layer records as the
     * user_message event. Defaults to `body.message` when omitted;
     * the branch route sets this to the pure `[/branch: …] <text>`
     * marker so the chat transcript stays audit-friendly even when
     * the agent's prompt is augmented with the inlined source
     * transcript (PR review P1 from chatgpt-codex-connector on
     * #365). On the wire this is forwarded as the `historyText`
     * query param; `handleSessionStream` reads it back via
     * `req.query.historyText`.
     */
    historyText?: string;
    provider?: string;
    model?: string;
    mode: "default" | "plan";
    skillName?: string;
    attachmentIds: string[];
    mentions?: { path: string; type: "file" | "directory" }[];
    reasoningEffort?: string;
    serviceTier?: "fast" | "flex";
    resumeSessionId?: string;
    // Optional parent session id (issue #353). Forwarded as a query
    // string so the SSE handler can stash it on the new session's
    // SessionState before persisting. Only honored on the
    // create-new-session path; queue-replay passes `resumeSessionId`
    // and never sets `parentId`.
    parentId?: string;
    // Optional source session id (issue #364). When set, the SSE
    // handler seeds the new session's transcript + metadata from
    // the source once the agent reports its sessionId. Ignored on
    // resume / queue-replay paths (a resumed session already has
    // its own transcript).
    seedFromSessionId?: string;
    // Optional caller-supplied title override (the branch route's
    // `--title`). Forwarded as `seedTitle` so `seedBranchFromSource`
    // uses it instead of the auto-derived "Branch of <sourceTitle>".
    seedTitle?: string;
    // Optional flag for the branch route (issue #364 + #381 P2).
    // When true, `seedBranchFromSource` writes the new session file
    // with `unstarted: true` so the client's composer pickers stay
    // unlocked until the user types their first turn. Cleared on
    // the subsequent `persistSessionStart` resume.
    unstarted?: boolean;
  }
): Request<{ projectId: string }> {
  const query: Record<string, string> = {
    worktreeId,
    message: body.message,
    provider: body.provider || "",
    mode: body.mode,
  };
  if (body.historyText) query.historyText = body.historyText;
  if (body.model) query.model = body.model;
  if (body.skillName) query.skillName = body.skillName;
  if (body.attachmentIds.length) query.attachmentIds = body.attachmentIds.join(",");
  if (body.mentions?.length) {
    // Same wire format the SSE client uses (issue #312). Keeping the
    // shim's encoding aligned means the headless POST endpoint and the
    // composer's picker converge on a single parser.
    query.mentions = body.mentions
      .map((mention) => `${mention.path}|${mention.type}`)
      .join(",");
  }
  if (body.reasoningEffort) query.reasoningEffort = body.reasoningEffort;
  if (body.serviceTier) query.serviceTier = body.serviceTier;
  // Optional so the headless POST endpoint can drive the resume / queue-
  // replay branch through `handleSessionStream` for tests. Production
  // callers should leave this undefined for the POST endpoint — it is
  // a new-session-only API.
  if (body.resumeSessionId) query.resumeSessionId = body.resumeSessionId;
  if (body.parentId) query.parentId = body.parentId;
  if (body.seedFromSessionId) query.seedFromSessionId = body.seedFromSessionId;
  if (body.seedTitle) query.seedTitle = body.seedTitle;
  if (body.unstarted) query.unstarted = "1";
  return {
    params: { projectId },
    query,
    on: () => undefined,
  } as unknown as Request<{ projectId: string }>;
}

/*
 * Response shim for the headless session-start endpoint. Mirrors
 * `makeHeadlessStreamResponse` (used by `advanceSessionQueue`) but with
 * one critical difference: instead of swallowing every event, it holds
 * the real `res` open until the agent's first `run.started` event
 * lands, then flushes a JSON 200 with `{ sessionId, url }` and
 * discards everything after.
 *
 * The `res` returned to the SSE handler is a mock that
 *   - forwards preflight errors (`status().json()` before `writeHead`)
 *     to the real client so the CLI sees a clean 4xx with a message,
 *   - intercepts `writeHead(200, ...)` to start holding the response,
 *   - intercepts `write(...)` to scan SSE events for `run.started`,
 *   - returns no-ops for everything else.
 */
export function makeSessionStartShim(
  projectId: string,
  worktreeId: string,
  realRes: Response
): {
  res: Response;
  fail: (message: string) => void;
} {
  let headersSent = false;
  let finished = false;
  let buffer = "";
  let sessionId: string | null = null;
  // True after the first `run.started` lands. We keep the real `res` open
  // and discard subsequent stream events, but no longer scan the buffer
  // for terminal events — `handleSessionStream` will call `end()` once
  // the run completes, which closes the response with whatever was last
  // written (the JSON 200 with `{ sessionId, url }`).
  let startedEmitted = false;
  let lastError: string | null = null;

  function sessionUrl(id: string): string {
    return `controller://project/${projectId}/worktree/${worktreeId}/session/${id}`;
  }

  function sendPreflightError(status: number, body: { error: string }) {
    if (finished) return;
    finished = true;
    realRes.status(status).json(body);
  }

  function flushSessionStart(id: string) {
    if (finished) return;
    finished = true;
    realRes.status(200).json({ sessionId: id, url: sessionUrl(id) });
  }

  function scanBufferForStarted() {
    if (startedEmitted) return;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        try {
          const event = JSON.parse(dataLine.slice(6));
          if (event && event.type === "anita_event" && event.event) {
            if (event.event.type === "run.started") {
              const id = typeof event.event.sessionId === "string" ? event.event.sessionId : "";
              if (id) {
                startedEmitted = true;
                sessionId = id;
                flushSessionStart(id);
                return;
              }
            } else if (
              event.event.type === "run.failed" ||
              event.event.type === "run.cancelled"
            ) {
              const errText =
                typeof event.event.error === "string"
                  ? event.event.error
                  : `Agent ${event.event.type.replace("run.", "")}`;
              lastError = errText;
              startedEmitted = true;
              return;
            }
          } else if (event && event.type === "error" && typeof event.text === "string") {
            lastError = event.text;
            startedEmitted = true;
            return;
          } else if (event && event.type === "stderr" && typeof event.text === "string" && event.text.trim()) {
            // Capture raw stderr forwarded by the handler so a silent
            // startup crash (e.g. anita rejecting `--model ""`) shows up
            // in the preflight error message instead of the generic
            // "Agent exited before reporting a sessionId" fallback
            // (issue #213). We deliberately do NOT set `startedEmitted`
            // here — stderr is informational, and the agent may still
            // recover and emit a real `run.started`. If it never does,
            // the most recent stderr line is what the user sees in the
            // preflight error.
            lastError = event.text;
          }
        } catch {
          // Ignore unparseable lines — the persistence layer handles them.
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }

  const res = {
    status: (code: number) => {
      if (code >= 400) {
        // Capture preflight error; the handler will call `.json(...)` next.
        return {
          json: (body: unknown) => {
            const message =
              body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
                ? (body as { error: string }).error
                : `Request failed (HTTP ${code})`;
            sendPreflightError(code, { error: message });
            return res;
          },
        };
      }
      // 2xx preflight writes are unusual (handler should call writeHead
      // for the SSE path) but we still no-op them.
      return {
        json: () => res,
        send: () => res,
      };
    },
    json: (body: unknown) => {
      // `res.json(...)` without a prior `res.status(...)` is unusual but
      // defensive: forward as a 500 with the body text if present.
      if (finished) return res;
      const message =
        body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : "Unexpected error";
      sendPreflightError(500, { error: message });
      return res;
    },
    writeHead: (_code: number, _headers?: Record<string, unknown>) => {
      headersSent = true;
      // Hold the real response open — do not write the SSE headers.
      // `flushSessionStart` will send a JSON 200 once `run.started`
      // lands, and `end()` will finalize the response.
      return res;
    },
    write: (chunk: string | Buffer) => {
      if (!headersSent || finished) return true;
      buffer += typeof chunk === "string" ? chunk : chunk.toString();
      scanBufferForStarted();
      return true;
    },
    end: () => {
      // If the SSE stream closed without `run.started` (e.g. the agent
      // crashed before reporting it), surface the last error we saw
      // (or a generic "no sessionId" fallback) so the CLI knows nothing
      // got started.
      if (!finished) {
        const message = lastError ?? "Agent exited before reporting a sessionId";
        sendPreflightError(500, { error: message });
      }
      if (!realRes.writableEnded) {
        realRes.end();
      }
      return res;
    },
    on: () => res,
  } as unknown as Response;

  return {
    res,
    fail: (message: string) => {
      if (finished) return;
      sendPreflightError(500, { error: message });
    },
  };
}

/*
 * Runs one agent turn and streams it to the client over SSE. Also invoked
 * headlessly (with discarding req/res shims) by `advanceSessionQueue` to run
 * the next enqueued message after a turn completes — that path streams to no
 * one but still persists events and advances the queue (see issue #113).
 */
export async function handleSessionStream(
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
    return;
  }

  const message = req.query.message as string;
  // `historyText` overrides the text the persistence layer records
  // as the user_message event. The branch route sets this to the
  // pure `[/branch: …] <text>` marker so the chat transcript stays
  // audit-friendly even when the agent's prompt is augmented with
  // the inlined source transcript (PR review P1 from
  // chatgpt-codex-connector on #365). When absent, the persistence
  // layer records the same text the agent saw as its prompt — the
  // default for `start` / `wake` / resume paths.
  const historyTextOverride =
    (req.query.historyText as string | undefined) || undefined;
  const resumeSessionId = req.query.resumeSessionId as string | undefined;
  const reasoningEffort = req.query.reasoningEffort as
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | undefined;
  const serviceTier = req.query.serviceTier === "fast" ? "fast" : undefined;
  const providerId = canonicalProviderId(
    (req.query.provider as string) || DEFAULT_PROVIDER_ID
  );
  // Resolve the requested model. A client-supplied `--model` always wins.
  // For brand-new sessions only, fall back to the user's saved default for
  // the resolved provider (Settings → Agents → Default model). Without
  // this fallback the provider's `spawn` would receive `undefined` and
  // emit `--model ""`, which the anita CLI rejects with a misleading
  // "Invalid model format" error before any `run.started` event lands
  // (issue #213).
  //
  // Resume / follow-up / queue-replay turns deliberately skip the
  // Settings default: those flows carry their own model intent (the
  // session's stored model is preserved by the persistence layer via
  // `model ?? existing?.model ?? ""`), and silently swapping in a
  // different provider default when the user later changes Settings
  // would change the model under an already-running session without
  // any UI signal. PR review from chatgpt-codex-connector on #218.
  // Per-agent settings drive both the default model (new sessions only) and
  // whether the agent auto-approves its actions this turn. Auto-approve is
  // read fresh on every turn so toggling it in Settings takes effect on the
  // next turn without a restart.
  const agentSetting = await getAgentSetting(providerId);
  const autoApprove = agentSetting.autoApprove;
  const queryModel = typeof req.query.model === "string" ? req.query.model.trim() : "";
  let model: string | undefined = queryModel || undefined;
  if (!model && !resumeSessionId) {
    const fallback = agentSetting.defaultModel;
    if (fallback && fallback.trim()) {
      model = fallback.trim();
    }
  }
  const mode = (req.query.mode as "default" | "plan" | undefined) || "default";
  const attachmentIds = (req.query.attachmentIds as string | undefined)
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean) ?? [];
  // `mentions` is the file/directory picker payload from the client
  // (issue #312). The format is `path|type,path|type,…`; the type
  // defaults to `file` when missing so a hand-crafted URL still parses.
  // `parseMentionsQuery` drops bad rows silently — the orchestrator is
  // the source of truth, and a malformed entry shouldn't fail the
  // whole turn.
  const mentionRequests = parseMentionsQuery(req.query.mentions as string | undefined);
  const skillName = (req.query.skillName as string | undefined)?.trim() || undefined;
  // Optional parent session id (issue #353). Only set on the
  // create-new-session branch — `persistSessionStart` honors it when
  // writing a brand-new session, and ignores it on resumed sessions
  // (the existing session's `parentId` is the source of truth there).
  const parentId = (req.query.parentId as string | undefined)?.trim() || undefined;
  // Optional source session id (issue #364). When set, the new
  // session's events file is prepended with the source's transcript
  // and the session file is patched to carry the source's
  // provider/model/mode + parentId once `run.started` lands. The
  // first turn still runs with the requested provider/model/mode
  // (passed in the query string above); only the session defaults
  // and the chat-view transcript are seeded from the source. Honors
  // the resolved-locator pattern (no per-session walk on this path;
  // the route layer resolves the source via `locateSessionById`).
  const seedFromSessionId = (req.query.seedFromSessionId as string | undefined)?.trim() || undefined;
  // Optional caller-supplied title override (the branch route's
  // `--title`). When set, `seedBranchFromSource` uses it as the
  // new session's title instead of the auto-derived
  // "Branch of <sourceTitle>".
  const seedTitle = (req.query.seedTitle as string | undefined)?.trim() || undefined;
  // Optional flag for the branch route (issue #364 + #381 P2).
  // When set, `seedBranchFromSource` marks the new session file
  // `unstarted: true` so the composer's provider/model/mode
  // pickers stay unlocked until the user types the first real
  // turn. Cleared on the subsequent `persistSessionStart` resume.
  const unstarted = req.query.unstarted === "1";

  const provider = getAgentProvider(providerId);
  if (!provider) {
    res.status(400).json({ error: `Unknown agent provider: ${providerId}` });
    return;
  }

  if (!message) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }
  if (attachmentIds.length > 0 && providerId !== "anita" && providerId !== "codex" && providerId !== "claude") {
    res.status(400).json({ error: `${provider.name} does not support attachments` });
    return;
  }

  const attachments = await getAttachments(worktree.path, attachmentIds);
  if (attachments.length !== attachmentIds.length) {
    res.status(400).json({ error: "One or more attachments could not be found" });
    return;
  }

  // Always tell the agent it's running inside Controller. Browser tooling is
  // covered by the managed `browser` skill installed on startup.
  //
  // Delivery channel depends on the provider:
  //   - Anita: pass the preamble via `--system-prompt` (real system message, never
  //     echoed in the chat transcript). The skill prefix stays in the user
  //     message because it is per-turn and request-scoped.
  //   - Codex / Claude: prepend to the user message — the only reliable channel
  //     today (Codex ignores collaboration-mode developer instructions in default
  //     mode; Claude's plan mode flows through the stream-json control channel).
  //     The skill prefix, if any, stays after the preamble.
  //
  // The preamble threads the active project so the memory block can
  // surface the project-scoped pinned snippet and notes (issue #350).
  const controllerPreamble = await buildControllerPreamble({
    projectId: req.params.projectId,
  });
  const usesSystemPrompt = providerId === "anita";
  // Resolve the `@`-mentions (issue #312) before composing the prompt so
  // the mention block lands in both the agent message and the persisted
  // history — that round-trip is what makes session replays
  // deterministic. The prefix carries the inlined preview; the context
  // block is the deterministic listing the bubble re-renders on reload.
  const mentionResolution = await resolveMentions(
    worktree.path,
    mentionRequests,
  );
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
  const baseAgentMessage = mentionResolution.prefix
    ? `${mentionResolution.prefix}${skillResolution.agentMessage}`
    : skillResolution.agentMessage;
  const agentMessage = usesSystemPrompt
    ? baseAgentMessage
    : framePreambleForPrompt(controllerPreamble) + baseAgentMessage;
  // The persisted history carries the deterministic mention block (no
  // inline preview) so reload is cheap and the transcript is
  // byte-identical across runs of the same prompt. The skill markers
  // already ride on the history text; the mention block is a separate
  // prefix. The branch route overrides this with the pure
  // `[/branch: …] <text>` marker so the chat transcript stays
  // audit-friendly even when the agent's prompt is augmented with
  // the inlined source transcript (PR review P1 from
  // chatgpt-codex-connector on #365).
  const historyText = historyTextOverride
    ? historyTextOverride
    : mentionResolution.contextBlock
      ? `${mentionResolution.contextBlock}\n\n${skillResolution.historyText}`
      : skillResolution.historyText;

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
      autoApprove,
      parentId,
      // Branch-seeding knobs (issue #364). The Codex path doesn't
      // go through the SSE handler's `persistSessionStart`, so the
      // branch route threads `seedFromSessionId` + `seedTitle` in
      // here explicitly. The Codex `persistSessionStart` honors
      // them once the agent reports its session id (PR review P1
      // from chatgpt-codex-connector on #365 — without these the
      // Codex branch path silently drops the source transcript
      // and falls back to the run's provider/model/mode for the
      // session defaults).
      seedFromSessionId,
      seedTitle,
      // Branch-route unstarted flag (issue #364 + #381 P2).
      // Mirrors the SSE path's `unstarted` query parameter — the
      // Codex `persistSessionStart` forwards it to
      // `seedBranchFromSource` so the composer's provider/model/
      // mode pickers stay unlocked on the new session's first
      // turn.
      unstarted,
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
    // Inject `CONTROLLER_SESSION_ID` for resumed sessions so the agent
    // can use `--parent self` when spawning child sessions. Brand-new
    // sessions get their id from the agent's first `run.started` event
    // (issue #353), so the env var is omitted there — the CLI surfaces
    // a clear error if the agent tries `--parent self` before knowing
    // its own id.
    env: {
      ...apiKeyEnv,
      ...controllerAgentEnv(
        resumeSessionId ? { sessionId: resumeSessionId } : undefined
      ),
    },
    command: resolvedCommand,
    attachments,
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
    autoApprove,
    systemPrompt: usesSystemPrompt ? controllerPreamble : undefined,
  });
  const parseProviderEvent =
    provider.createParser?.(autoApprove) ?? provider.parseEvent.bind(provider);

  let stdoutBuffer = "";
  let eventProcessing = Promise.resolve();
  let streamSessionId = resumeSessionId ?? "";
  let userMessageWritten = false;
  let pausedForClaudeUserInput = false;
  let runTerminated = false;
  // True when the most recent terminal event we streamed was
  // `run.cancelled` (i.e. Anita exited cleanly with code 130 after a
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
  // it open has been observed to make Anita hang silently mid-run.
  //
  // Two exceptions keep their pipe open for the whole turn:
  // - Claude routes the prompt and live approval decisions over the
  //   stream-json control channel in plan mode and whenever auto-approve is
  //   off (manual approval for every action).
  // - Anita reads manual-approval decisions over its stdin line protocol
  //   (`approval.response` JSON lines) when auto-approve is off, so the
  //   /tool-approval responder can answer the running process. With
  //   auto-approve on it never reads stdin and resolves every gate itself, so
  //   we still close the pipe. Anita detaches its own stdin reader at
  //   end-of-run, so an open pipe no longer hangs it.
  const claudeUsesControlChannel =
    providerId === "claude" && (mode === "plan" || !autoApprove);
  const anitaUsesApprovalChannel = providerId === "anita" && !autoApprove;
  if (
    (providerId === "anita" && !anitaUsesApprovalChannel) ||
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
    // sessions. Some providers (e.g. Anita) also write their own user_message
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
    const title = existing ? existing.title : deriveAutoTitle(historyText);
    // Focus state lives in a Controller-owned sidecar, not on the
    // session file: any provider that writes the session file
    // (e.g. Anita on legacy resumed sessions) would silently drop
    // our fields on every save, so a brand-new session's
    // auto-pin would vanish within ~1s. See issue #139 / #140 /
    // #165.
    const existingFocus = await readSessionFocus(sessionId);
    const focus = resolveSessionFocusState(existingFocus);
    await writeSessionFocus(buildSessionFocus(sessionId, focus));
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
      // `parentId` is set on brand-new sessions only (issue #353). The
      // resumed-session path deliberately preserves the existing
      // `parentId` so a child can't be re-parented by a later
      // `--parent` flag on a queue-replay. A later `parentId` on the
      // request is **ignored** when `existing` is set — the existing
      // file is the source of truth. The `existing?.parentId`
      // fallback is the bit that prevents `saveSession`'s full-file
      // overwrite from silently dropping the field on resume.
      ...(existing
        ? existing.parentId
          ? { parentId: existing.parentId }
          : {}
        : parentId
        ? { parentId }
        : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    });
    // Notify other clients (sidebar in another window) about the new
    // session so they can add it to the tree without polling. Only
    // emitted for brand-new sessions — resumed sessions don't need a
    // sidebar insert (issue #210).
    if (!existing) {
      emitSessionAdded(req.params.projectId, worktreeId, sessionId);
    }
    // Notify the client if the session was auto-pinned so it can update
    // the focus-queue indicator without a full page reload.
    if (focus.focusPinnedAt && !existingFocus?.focusPinnedAt) {
      sseSend({ type: "session_focus", focusPinnedAt: focus.focusPinnedAt });
    }
    // Issue #364: seed the new session's transcript + metadata from
    // the source session once the agent has reported its sessionId.
    // The seeding runs *after* the user_message append + saveSession
    // above so we don't race the chat transcript: the source events
    // land at the start of the events file (with the user_message as
    // the last entry), and the session file's `messages` array is
    // patched to `[...source.messages, branchMarker]`. The new
    // session's provider/model/mode come from the source so the model
    // picker in the composer falls back to source's defaults after
    // the first turn — the requested provider/model/mode only
    // affected the first turn's agent spawn (above), not the
    // session defaults that subsequent turns read.
    if (seedFromSessionId && seedFromSessionId !== sessionId) {
      try {
        await seedBranchFromSource(
          worktreePath,
          seedFromSessionId,
          sessionId,
          historyText,
          { title: seedTitle, unstarted }
        );
      } catch (error) {
        // Seed failures are non-fatal: the new session still has the
        // first-turn user_message event and the agent's response
        // continues normally. The user just won't see the source
        // transcript in the chat view; the agent runs unaffected.
        console.error(
          `[sessions] branch seed failed (source=${seedFromSessionId}, new=${sessionId}):`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  /**
   * Convert a normalized agent event to a persisted AgentEvent and append it.
   * Always invoked through the `eventProcessing` chain and awaited so the
   * `.coding-agent/events/` JSONL records events in stream order: each append
   * completes before the next is issued. Issuing these as concurrent
   * fire-and-forget writes let the OS reorder them, so a reloaded transcript
   * could render an assistant response ahead of the user turn that prompted it.
   */
  async function persistAgentEvent(event: AgentStreamEvent): Promise<void> {
    if (!streamSessionId) return;
    if (event.type === "thread.status" || event.type === "plan.delta") return;
    const agentEvent: AgentEvent = {
      id: randomUUID(),
      sessionId: streamSessionId,
      timestamp: new Date().toISOString(),
      type: getPersistedEventType(event),
      data: getPersistedEventData(event),
    };
    await appendEvent(worktreePath, streamSessionId, agentEvent);
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
    // SIGINT — Anita may be silent in the gap between the `run.cancelled`
    // event and the final exit. Reap the child silently so the run
    // ends, but do NOT emit a second terminal event on top of the
    // `run.cancelled` we already streamed (issue #94).
    if (runCancelled) {
      if (child.exitCode === null && !child.killed) {
        signalAgentProcess(child, "SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) signalAgentProcess(child, "SIGKILL");
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
    sseSend({ type: "anita_event", event: failureEvent });
    // Persist to disk so the failure is visible after reconnects. Route it
    // through the serialization chain so it lands after any pending writes.
    eventProcessing = eventProcessing
      .then(() => persistAgentEvent(failureEvent))
      .catch(() => {});
    if (child.exitCode === null && !child.killed) {
      signalAgentProcess(child, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) signalAgentProcess(child, "SIGKILL");
      }, 2000);
    }
  }

  heartbeat = setInterval(() => {
    if (clientConnected) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  resetWatchdog();

  if (resumeSessionId) {
    // Serialize the resumed session-start (which appends the controller's
    // user_message) onto the same chain the stream events use, so the user
    // turn is written before any assistant/tool event that follows it.
    eventProcessing = eventProcessing
      .then(() => persistSessionStart(resumeSessionId))
      .catch(() => {});
  }

  // Forward stderr text and keep fallback approval handling for older prompts.
  // We also keep the most recent stderr line in `lastStderrText` so the
  // synthetic `run.failed` event emitted below for an abnormal exit
  // without a terminal stdout event can include the actual cause —
  // without this the event would just say "Anita process exited with code
  // 1" and the user (and on-call engineer) would have to repro by hand to
  // discover the real error (issue #376).
  let lastStderrText = "";
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

    lastStderrText = filtered;
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
                // Persist session metadata on run.started so
                // provider/model are available when loading any session,
                // then persist each transcript event to
                // .coding-agent/events/ so it can be read back on reload.
                if (event.type === "run.started") {
                  await persistSessionStart(event.sessionId);
                } else if (
                  event.type !== "run.completed" &&
                  event.type !== "run.failed" &&
                  event.type !== "run.cancelled"
                ) {
                  await persistAgentEvent(event);
                }
                if (
                  event.type === "run.completed" ||
                  event.type === "run.failed" ||
                  event.type === "run.cancelled"
                ) {
                  runTerminated = true;
                  runCancelled = event.type === "run.cancelled";
                }
                if (streamSessionId) {
                  recordSessionAttentionEvent(streamSessionId, event);
                }
                sseSend({ type: "anita_event", event });
              })
              .catch(() => {});
            if (providerId === "claude" && event.type === "user.input_requested") {
              pausedForClaudeUserInput = true;
              signalAgentProcess(child, "SIGTERM");
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
                event.type !== "run.completed" &&
                event.type !== "run.failed" &&
                event.type !== "run.cancelled"
              ) {
                await persistAgentEvent(event);
              }
              if (
                event.type === "run.completed" ||
                event.type === "run.failed" ||
                event.type === "run.cancelled"
              ) {
                runTerminated = true;
                runCancelled = event.type === "run.cancelled";
              }
              if (streamSessionId) {
                recordSessionAttentionEvent(streamSessionId, event);
              }
              sseSend({ type: "anita_event", event });
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
        // Anita emits `run.cancelled` and then exits with code 130, which
        // is *not* an abnormal termination — surfacing both events would
        // produce the misleading "Anita process exited with code 130" banner
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
            // Include the most recent stderr line(s) captured during the
            // run so the user doesn't have to dig through the terminal
            // log to discover *why* the process crashed. Without this,
            // a Codex startup failure (e.g. malformed argv) just shows
            // "Codex process exited with code 1" and the actual root
            // cause ("Reading prompt from stdin... No prompt provided
            // via stdin.") is silently dropped (issue #376).
            const failureError = lastStderrText
              ? `${errorText} ${lastStderrText}`
              : errorText;
            const failureEvent: AgentStreamEvent = {
              type: "run.failed",
              sessionId: streamSessionId,
              error: failureError,
              timestamp: new Date().toISOString(),
            };
            sseSend({ type: "anita_event", event: failureEvent });
            await persistAgentEvent(failureEvent);
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

        // On a run termination, run the next enqueued message (if any).
        // This happens server-side so the queue drains regardless of
        // whether any client is connected (see issue #113). Draining on
        // `run.failed` as well as `run.completed` is required by the
        // same-session goal loop (issue #339): a follow-up enqueued by
        // the goal evaluator after a failed turn would otherwise be
        // silently ignored. We do *not* drain after a user-initiated
        // cancellation — pausing the queue there matches the existing UX
        // where a cancelled turn waits for the user to act.
        if (
          streamSessionId &&
          !pausedForClaudeUserInput &&
          !runCancelled
        ) {
          void scheduleSessionQueueAdvance(
            req.params.projectId,
            worktreeId,
            streamSessionId
          );
        }
      })
      .catch(() => {});
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

/*
 * Finalization and a late /steer fallback can both discover that a queue is
 * ready. Serialize those triggers and re-check runtime state so they cannot
 * start two follow-up turns concurrently.
 */
const queueAdvanceChains = new Map<string, Promise<void>>();

function scheduleSessionQueueAdvance(
  projectId: string,
  worktreeId: string,
  sessionId: string
): Promise<void> {
  const previous = queueAdvanceChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      if (getSessionRuntime(sessionId).active) return;
      await advanceSessionQueue(projectId, worktreeId, sessionId);
    })
    .catch((error) => {
      console.error(
        `[session] queue advancement failed (session=${sessionId}):`,
        error instanceof Error ? error.message : error
      );
    });
  queueAdvanceChains.set(sessionId, next);
  void next.finally(() => {
    if (queueAdvanceChains.get(sessionId) === next) {
      queueAdvanceChains.delete(sessionId);
    }
  });
  return next;
}

/**
 * Drain a session's queue from outside the route pipeline (issue #339).
 * Used by the wakes consumer (`server/lib/wakes.ts`) to fire deferred
 * wakeups: each tick sees the head's `runAt` is now due and delegates to
 * the same chain that the run-completion handler uses, so the replay goes
 * through the identical preflight + headless-stream machinery.
 */
export function advanceSessionQueueFromConsumer(
  projectId: string,
  worktreeId: string,
  sessionId: string
): Promise<void> {
  return scheduleSessionQueueAdvance(projectId, worktreeId, sessionId);
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
  // The queue snapshot stores the user's `@` mention chip stack; replaying
  // it on the next turn keeps the resolved mention block in the prompt
  // aligned with what the user originally typed (issue #312).
  if (message.mentions?.length) {
    query.mentions = message.mentions
      .map((mention) => `${mention.path}|${mention.type}`)
      .join(",");
  }
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
    autoApprove: boolean;
    // Optional parent session id (issue #353). Forwarded through
    // the same query → `persistSessionStart` path the SSE handler
    // uses; only honored on brand-new sessions.
    parentId?: string;
    // Branch-seeding knobs (issue #364). The Codex path doesn't
    // go through the SSE handler's `persistSessionStart`, so the
    // branch route threads these in here explicitly. Honored by
    // this function's `persistSessionStart` once the Codex agent
    // reports its session id (PR review P1 from
    // chatgpt-codex-connector on #365 — without these the Codex
    // branch path silently drops the source transcript and falls
    // back to the run's provider/model/mode for the session
    // defaults).
    seedFromSessionId?: string;
    seedTitle?: string;
    // Branch-route unstarted flag (issue #364 + #381 P2). When
    // true, the Codex `persistSessionStart` writes the new
    // session file with `unstarted: true` so the composer's
    // provider/model/mode pickers stay unlocked until the user
    // types their first turn.
    unstarted?: boolean;
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
    autoApprove,
    parentId,
    seedFromSessionId,
    seedTitle,
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

    // Drain the next enqueued message on a run termination (server-side,
    // independent of any client; see issue #113). Draining on non-zero
    // exits as well is required by the same-session goal loop (issue
    // #339): a follow-up enqueued by the goal evaluator after a failed
    // turn would otherwise be silently ignored. Cancelled runs already
    // exit through their own drain handler in the run-completion branch,
    // not here.
    if (streamSessionId && exitCode === 0) {
      void scheduleSessionQueueAdvance(projectId, worktreeId, streamSessionId);
    } else if (streamSessionId && exitCode !== 0) {
      // Failed run: only drain if there is something in the queue. An
      // empty queue means the agent (or the user) didn't ask for a
      // follow-up, so we leave the session idle rather than auto-firing
      // a confusing turn.
      const queue = await listQueue(streamSessionId).catch(() => []);
      if (queue.length > 0) {
        void scheduleSessionQueueAdvance(projectId, worktreeId, streamSessionId);
      }
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
    const title = existing ? existing.title : deriveAutoTitle(historyText);
    // Focus state lives in a Controller-owned sidecar; see the
    // SSE-stream persistSessionStart for the rationale (issue #139).
    const existingFocus = await readSessionFocus(sessionId);
    const focus = resolveSessionFocusState(existingFocus);
    await writeSessionFocus(buildSessionFocus(sessionId, focus));
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
      // `parentId` is set on brand-new sessions only (issue #353);
      // see the SSE-stream variant for the rationale. A later
      // `parentId` on the request is **ignored** when `existing` is
      // set, and the existing file's `parentId` is preserved.
      ...(existing
        ? existing.parentId
          ? { parentId: existing.parentId }
          : {}
        : parentId
        ? { parentId }
        : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    });
    if (!existing) {
      emitSessionAdded(projectId, worktreeId, sessionId);
    }
    if (focus.focusPinnedAt && !existingFocus?.focusPinnedAt) {
      sseSend({ type: "session_focus", focusPinnedAt: focus.focusPinnedAt });
    }
    // Branch-seeding mirror of the SSE handler (issue #364): the
    // Codex path doesn't go through the SSE `persistSessionStart`,
    // so it has to honor `seedFromSessionId` here. The helper
    // prepends source events to the new session's events file and
    // patches provider/model/mode/parentId/messages so the chat
    // view and the model picker both reflect the source. Non-fatal
    // — failures here leave the new session in the state the rest
    // of `persistSessionStart` left it in (PR review P1 from
    // chatgpt-codex-connector on #365).
    if (seedFromSessionId && seedFromSessionId !== sessionId) {
      try {
        await seedBranchFromSource(
          worktreePath,
          seedFromSessionId,
          sessionId,
          historyText,
          { title: seedTitle }
        );
      } catch (error) {
        console.error(
          `[sessions] branch seed failed in codex path (source=${seedFromSessionId}, new=${sessionId}):`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  /* Append a persisted event; awaited via the chain to keep file order. */
  async function persistAgentEvent(event: AgentStreamEvent): Promise<void> {
    if (!streamSessionId) return;
    const agentEvent: AgentEvent = {
      id: randomUUID(),
      sessionId: streamSessionId,
      timestamp: new Date().toISOString(),
      type: getPersistedEventType(event),
      data: getPersistedEventData(event),
    };
    await appendEvent(worktreePath, streamSessionId, agentEvent);
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
          await persistAgentEvent(event);
        }

        if (streamSessionId) {
          recordSessionAttentionEvent(streamSessionId, event);
        }

        sseSend({ type: "anita_event", event });

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
        // Same env-injection contract as the SSE-stream path: stamp
        // `CONTROLLER_SESSION_ID` for resumed sessions, omit it for
        // brand-new ones (issue #353).
        env: {
          ...(await getApiKeyEnvVars()),
          ...controllerAgentEnv(
            resumeSessionId ? { sessionId: resumeSessionId } : undefined
          ),
        },
        resumeSessionId,
        model,
        reasoningEffort,
        serviceTier,
        mode,
        attachments,
        autoApprove,
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

export function getPersistedEventType(event: AgentStreamEvent): string {
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
    case "tool.approval_resolved":
      // Settles the approval card the same way a user decision does; the
      // `reason` in the data distinguishes it from a manual deny.
      return "tool_approval_response";
    case "thread.status":
      return "thread_status";
    case "run.cancelled":
      return "run_cancelled";
    default:
      return event.type;
  }
}

export function getPersistedEventData(event: AgentStreamEvent): Record<string, unknown> {
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
    case "tool.approval_resolved":
      return {
        requestId: event.id,
        decision: event.approved ? "allow_once" : "deny",
        reason: event.reason,
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }

    const message = req.body.message as string | undefined;
    const queuedMessageId = req.body.queuedMessageId as string | undefined;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      const result = await acceptCodexSteer({
        queuedMessageId,
        steer: () => codexAppServerManager.steerSession(req.params.sessionId, message),
        steerQueuedMessage: async (id) => {
          const resolution = await resolveQueuedMessage(
            req.params.sessionId,
            id,
            async () => {
              const outcome = await codexAppServerManager.steerSession(
                req.params.sessionId,
                message
              );
              return { result: outcome, remove: outcome === "steered" };
            }
          );
          return {
            message: resolution.message,
            outcome: resolution.result,
          };
        },
        buildFollowUp: async () => {
          const session = await getSession(worktree.path, req.params.sessionId);
          if (!session?.provider || !session.model) {
            throw new Error("Session metadata is unavailable for the follow-up");
          }
          return {
            text: message,
            visibleText: message,
            provider: session.provider,
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            serviceTier: session.serviceTier === "fast" ? "fast" : undefined,
            mode: session.mode === "plan" ? "plan" : "default",
            attachmentIds: [],
          };
        },
        enqueueFollowUp: (input) => enqueueMessage(req.params.sessionId, input),
      });
      if (result.disposition === "queued") {
        res.json({ ok: true, ...result });
        if (!getSessionRuntime(req.params.sessionId).active) {
          void scheduleSessionQueueAdvance(
            req.params.projectId,
            worktree.id,
            req.params.sessionId
          );
        }
        return;
      }
      await appendEvent(worktree.path, req.params.sessionId, {
        id: randomUUID(),
        sessionId: req.params.sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: { text: message },
      });
      res.json({ ok: true, ...result });
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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
      setSessionAwaitingUserInput(req.params.sessionId, false);

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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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
        setSessionAwaitingUserInput(req.params.sessionId, false);

        if (session) {
          session.lastActiveAt = new Date().toISOString();
          await saveSession(worktree.path, session);
        }

        res.json({ ok: true, ...resume });
        return;
      }

      await codexAppServerManager.submitUserInput(req.params.sessionId, answers);
      setSessionAwaitingUserInput(req.params.sessionId, false);
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

// --- Wake (issue #339) ---
//
// `controller sessions wake <sessionId> --message <text> [--delay 30s |
// --run-at <iso>]`. Adds a follow-up to the session's queue and optionally
// defers it via `runAt`. The wakes consumer fires the deferred item on the
// next scheduler tick by calling the existing `advanceSessionQueue` chain
// — no new execution model. The route resolves the (project, worktree) from
// the session file on disk so the CLI doesn't need to know the project id
// (the agent's natural usage is `wake <self>`). The route reuses the
// session's own provider/model when the caller doesn't override them,
// matching the steer-follow-up pattern in `/user-input`.
sessionsRouter.post(
  "/:projectId/sessions/:sessionId/wake",
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof raw.message === "string" ? raw.message : "";
    if (!text.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    let runAt: string | undefined;
    if (typeof raw.runAtIso === "string" && raw.runAtIso.trim()) {
      const parsed = new Date(raw.runAtIso);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: `Invalid --run-at timestamp "${raw.runAtIso}"` });
        return;
      }
      runAt = parsed.toISOString();
    } else if (typeof raw.delay === "string" && raw.delay.trim()) {
      const { resolveRunAt } = await import("../lib/wakes.js");
      const resolved = resolveRunAt(raw.delay);
      if (resolved == null) {
        res.status(400).json({
          error: `Invalid --delay "${raw.delay}"; expected forms: 30s, 5m, 1h, 2d`,
        });
        return;
      }
      runAt = resolved;
    }
    const message: QueuedMessage = await enqueueMessage(req.params.sessionId, {
      text,
      visibleText: text,
      provider:
        typeof raw.provider === "string" && raw.provider
          ? raw.provider
          : session.provider ?? "claude",
      model:
        typeof raw.model === "string" && raw.model
          ? raw.model
          : session.model,
      reasoningEffort: session.reasoningEffort,
      serviceTier: session.serviceTier === "fast" ? "fast" : undefined,
      mode: session.mode === "plan" ? "plan" : "default",
      attachmentIds: [],
      ...(typeof raw.skillName === "string" && raw.skillName
        ? { skillName: raw.skillName }
        : {}),
      ...(runAt ? { runAt } : {}),
    });
    res.status(201).json({ message });
  }
);

// Same handler mounted under `/api/sessions/:sessionId/wake` so the CLI can
// drive a wake with just a session id and skip the project id resolution
// (issue #339). The handler walks every project's session store to find the
// session; in a single-project controller this is one directory read.
// Note: mounted under `/api/sessions` from `index.ts`, not the
// `/api/projects` prefix the rest of this router uses.
//
// Issue #339 review: the original lookup only walked `project.path` (the
// main worktree). Sessions created in a non-main worktree live under
// `projectStoreDir(worktree.path)`, so the ID-only endpoint returned 404
// for those. The shared `locateSessionById` helper below enumerates every
// project × worktree pair.
export const wakeBySessionIdRouter = Router();
wakeBySessionIdRouter.post("/:sessionId/wake", async (req, res) => {
  const located = await locateSessionById(req.params.sessionId);
  if (!located) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { session, projectId: owningProjectId } = located;
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof raw.message === "string" ? raw.message : "";
  if (!text.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  let runAt: string | undefined;
  if (typeof raw.runAtIso === "string" && raw.runAtIso.trim()) {
    const parsed = new Date(raw.runAtIso);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: `Invalid --run-at timestamp "${raw.runAtIso}"` });
      return;
    }
    runAt = parsed.toISOString();
  } else if (typeof raw.delay === "string" && raw.delay.trim()) {
    const { resolveRunAt } = await import("../lib/wakes.js");
    const resolved = resolveRunAt(raw.delay);
    if (resolved == null) {
      res.status(400).json({
        error: `Invalid --delay "${raw.delay}"; expected forms: 30s, 5m, 1h, 2d`,
      });
      return;
    }
    runAt = resolved;
  }
  const message: QueuedMessage = await enqueueMessage(req.params.sessionId, {
    text,
    visibleText: text,
    provider:
      typeof raw.provider === "string" && raw.provider
        ? raw.provider
        : session.provider ?? "claude",
    model:
      typeof raw.model === "string" && raw.model
        ? raw.model
        : session.model,
    reasoningEffort: session.reasoningEffort,
    serviceTier: session.serviceTier === "fast" ? "fast" : undefined,
    mode: session.mode === "plan" ? "plan" : "default",
    attachmentIds: [],
    ...(typeof raw.skillName === "string" && raw.skillName
      ? { skillName: raw.skillName }
      : {}),
    ...(runAt ? { runAt } : {}),
  });
  res.status(201).json({ message, projectId: owningProjectId });
});

// --- Cross-session send (issue #351) ---
//
// `controller sessions send <target> <message> --from <parentId|self>`.
// Enqueues a durable follow-up on the target session whose text is the
// canonical `[/from: <parentTitle>] <controller-uri> <message>` marker. The
// marker distinguishes it from a typed user message, while the literal URI is
// linkified by the client and navigates back to the parent conversation.
//
// The route is mounted under `/api/sessions/:sessionId/...` so the CLI
// doesn't need to thread a project id — the same cross-worktree
// `locateSessionById` walk the wake + goal + monitor surfaces use
// (issue #339 review).
//
// This shares the regular queue/replay pipeline: idle targets start a
// headless continuation immediately, while active targets drain the
// message after their current turn completes.

export const sendBySessionIdRouter = Router();

type FollowUpTarget = {
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  projectId: string;
  worktreeId: string;
};

/**
 * Enqueue an externally-generated user turn using the target session's
 * continuation settings. If the target is idle, start the existing
 * serialized queue-advance path immediately; an active target will drain
 * the message from its normal run-finalization handler.
 */
async function enqueueExternalFollowUp(
  target: FollowUpTarget,
  text: string
): Promise<QueuedMessage> {
  const { session, projectId, worktreeId } = target;
  const message = await withSessionQueueTransaction(session.id, async (queue) => {
    // The target may have been archived since the caller located it. Re-read
    // under the queue/lifecycle lock so archive and enqueue cannot cross.
    const current = await locateSessionById(session.id);
    if (!current || current.session.status === "archived") {
      throw new Error(`Session ${session.id} is archived`);
    }
    return queue.enqueue({
      text,
      visibleText: text,
      provider: current.session.provider ?? "claude",
      model: current.session.model,
      reasoningEffort: current.session.reasoningEffort,
      serviceTier: current.session.serviceTier === "fast" ? "fast" : undefined,
      mode: current.session.mode === "plan" ? "plan" : "default",
      attachmentIds: [],
    });
  });
  if (!getSessionRuntime(session.id).active) {
    void scheduleSessionQueueAdvance(projectId, worktreeId, session.id);
  }
  return message;
}

sendBySessionIdRouter.post(
  "/:sessionId/send-from",
  async (req, res) => {
    const located = await locateSessionById(req.params.sessionId);
    if (!located) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { session, projectId } = located;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof raw.message === "string" ? raw.message : "";
    if (!text.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const fromSessionId =
      typeof raw.fromSessionId === "string" && raw.fromSessionId.trim()
        ? raw.fromSessionId.trim()
        : "";
    if (!fromSessionId) {
      res.status(400).json({ error: "fromSessionId is required" });
      return;
    }
    // Resolve the parent session. The CLI's `send` already does the
    // self-resolution (so the caller's id is the literal env value);
    // here we only echo it after confirming the parent exists, so the
    // persisted `[/from: title]` marker is accurate and the
    // linkifier can deep-link to a real session.
    const parent = await locateSessionById(fromSessionId);
    if (!parent) {
      res.status(404).json({
        error: `From session ${fromSessionId} not found`,
      });
      return;
    }
    const parentTitle =
      typeof parent.session.title === "string" && parent.session.title.trim()
        ? parent.session.title.trim()
        : "(untitled)";
    const parentUrl = `controller://project/${parent.projectId}/worktree/${parent.worktreeId}/session/${parent.session.id}`;
    const markerText = `[/from: ${parentTitle}] ${parentUrl} ${text}`;
    let message: QueuedMessage;
    try {
      message = await enqueueExternalFollowUp(located, markerText);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith(" is archived")) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
    res.status(201).json({
      // Preserve the original response field for CLI compatibility. The
      // identifier now belongs to the durable queued message rather than a
      // transcript-only event.
      eventId: message.id,
      message,
      projectId,
      worktreeId: session.worktreeId,
      sessionId: session.id,
      parentSessionId: parent.session.id,
      parentTitle,
    });
  }
);

// --- Children enumeration (issue #351) ---
//
// `controller sessions children <parentId>` and the sidebar's
// coordinator tree both call this route. The walk is the same
// `listChildSessions` helper `sessions list --parent` uses on the
// server; we expose it under `/api/sessions/:sessionId/children` so
// neither the CLI nor the sidebar has to thread a project id.

export const childrenBySessionIdRouter = Router();

childrenBySessionIdRouter.get(
  "/:sessionId/children",
  async (_req, res) => {
    const parentId = _req.params.sessionId;
    const located = await locateSessionById(parentId);
    if (!located) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { listChildSessions } = await import("../lib/sessions.js");
    const children = await listChildSessions(parentId);
    res.json({ parent: parentId, children });
  }
);

// --- Goals (issue #339) ---
//
// `controller sessions goal set|clear|show <project> <sessionId> ...`.
// Goals are session-scoped completion conditions: the goal evaluator
// (registered on the shared wakeup loop from #243) reads the goal after
// every turn and either clears it (met) or enqueues a follow-up (not
// met + empty queue). The route lives at
// `/api/projects/:projectId/sessions/:sessionId/goal`.

sessionsRouter.get(
  "/:projectId/sessions/:sessionId/goal",
  async (req, res) => {
    const { readSessionGoal } = await import("../lib/goal-state.js");
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const goal = await readSessionGoal(req.params.sessionId);
    res.json({ goal });
  }
);

sessionsRouter.put(
  "/:projectId/sessions/:sessionId/goal",
  async (req, res) => {
    const {
      buildSessionGoal,
      clearSessionGoal,
      readSessionGoal,
      writeSessionGoal,
    } = await import("../lib/goal-state.js");
    const worktree = await resolveWorktree(
      req.params.projectId,
      req.query.worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const action = raw.action === "clear" ? "clear" : "set";
    if (action === "clear") {
      await clearSessionGoal(req.params.sessionId);
      res.json({ goal: null });
      return;
    }
    try {
      const goal = buildSessionGoal(req.params.sessionId, {
        condition: typeof raw.condition === "string" ? raw.condition : "",
        maxTurns:
          typeof raw.maxTurns === "number" && Number.isInteger(raw.maxTurns)
            ? raw.maxTurns
            : undefined,
        expiresAt:
          typeof raw.expiresAt === "string" && raw.expiresAt.trim()
            ? raw.expiresAt
            : undefined,
      });
      // Merge over an existing goal so re-setting preserves
      // `turnsEvaluated` (the cap continues counting). Pass
      // `updatedAt` through unchanged so consumers can compare.
      const existing = await readSessionGoal(req.params.sessionId);
      const merged: typeof goal = existing
        ? { ...goal, turnsEvaluated: existing.turnsEvaluated }
        : goal;
      await writeSessionGoal(merged);
      res.status(201).json({ goal: merged });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

// Same goal surface mounted under `/api/sessions/:sessionId/goal` so the
// CLI can drive it without resolving a project id (issue #339). The
// handler walks the project list to find the owning project, so the
// single-session endpoint has the same shape as `/api/sessions/:sessionId/wake`.
//
// Issue #339 review: `set` now verifies the session exists before
// writing the sidecar, so a typo in `controller sessions goal set`
// doesn't quietly create a durable goal for a nonexistent session.
// `show` and `clear` stay unguarded — they're idempotent and safe to
// run against a missing session id (the goal file just doesn't exist).
export const goalBySessionIdRouter = Router();
goalBySessionIdRouter.get("/:sessionId/goal", async (req, res) => {
  const { readSessionGoal } = await import("../lib/goal-state.js");
  const goal = await readSessionGoal(req.params.sessionId);
  res.json({ goal });
});

goalBySessionIdRouter.put("/:sessionId/goal", async (req, res) => {
  const {
    buildSessionGoal,
    clearSessionGoal,
    readSessionGoal,
    writeSessionGoal,
  } = await import("../lib/goal-state.js");
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const action = raw.action === "clear" ? "clear" : "set";
  if (action === "clear") {
    await clearSessionGoal(req.params.sessionId);
    res.json({ goal: null });
    return;
  }
  // `set` requires a real session (issue #339 review): an unknown
  // session id would otherwise silently create a goal sidecar that
  // nothing can ever enqueue against (the evaluator's locateSession
  // would return null and clear the goal immediately, but the goal
  // would still cycle as a no-op). Fail loudly so a typo'd id is
  // surfaced at the call site.
  const located = await locateSessionById(req.params.sessionId);
  if (!located) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  try {
    const goal = buildSessionGoal(req.params.sessionId, {
      condition: typeof raw.condition === "string" ? raw.condition : "",
      maxTurns:
        typeof raw.maxTurns === "number" && Number.isInteger(raw.maxTurns)
          ? raw.maxTurns
          : undefined,
      expiresAt:
        typeof raw.expiresAt === "string" && raw.expiresAt.trim()
          ? raw.expiresAt
          : undefined,
    });
    const existing = await readSessionGoal(req.params.sessionId);
    const merged = existing
      ? { ...goal, turnsEvaluated: existing.turnsEvaluated }
      : goal;
    await writeSessionGoal(merged);
    res.status(201).json({ goal: merged });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// --- Monitors (issue #339) ---
//
// `controller sessions monitor start|list|stop <sessionId> ...` runs a
// long-lived child process whose stdout is captured line-by-line and
// appended to the session event log as a `monitor_event`. Monitors are
// session-scoped (they live in memory for the lifetime of the server
// process), bounded by a default 5-minute timeout, and capped at 8 per
// session. The route layer mirrors the `goal` / `wake` shape: the
// project-scoped route resolves the session, the per-session mount
// skips project resolution and the agent invokes by session id only.
//
// The actual store + lifecycle lives in `server/lib/monitors.ts` so
// this file stays focused on HTTP wiring.

sessionsRouter.post(
  "/:projectId/sessions/:sessionId/monitors",
  async (req, res) => {
    const { startMonitor, MAX_MONITORS_PER_SESSION, MAX_LINE_BUFFER } =
      await import("../lib/monitors.js");
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const command = typeof raw.command === "string" ? raw.command : "";
    if (!description.trim()) {
      res.status(400).json({ error: "description is required" });
      return;
    }
    if (!command.trim()) {
      res.status(400).json({ error: "command is required" });
      return;
    }
    const persistent = raw.persistent === true;
    const timeoutMs =
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
        ? raw.timeoutMs
        : undefined;
    // Issue #351: optional `--on-line` filter. Compiled server-side
    // so a bad pattern returns 400 before the monitor is started.
    const onLinePattern =
      typeof raw.onLine === "string" && raw.onLine.trim()
        ? raw.onLine.trim()
        : null;
    let onLine: RegExp | null = null;
    if (onLinePattern) {
      try {
        onLine = new RegExp(onLinePattern);
      } catch (error) {
        res.status(400).json({
          error: `Invalid --on-line pattern: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
    }
    try {
      const monitor = startMonitor({
        sessionId: req.params.sessionId,
        worktreePath: worktree.path,
        description,
        command,
        persistent,
        timeoutMs,
        limits: { maxPerSession: MAX_MONITORS_PER_SESSION, maxLines: MAX_LINE_BUFFER },
        onLine,
        onLinePattern,
        onLineMatch: ({ text }) =>
          enqueueExternalFollowUp(
            {
              session,
              projectId: req.params.projectId,
              worktreeId: worktree.id,
            },
            text
          ).then(() => undefined),
      });
      res.status(201).json({ monitor });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

sessionsRouter.get(
  "/:projectId/sessions/:sessionId/monitors",
  async (req, res) => {
    const { listMonitors } = await import("../lib/monitors.js");
    res.json({
      monitors: listMonitors(req.params.sessionId),
    });
  }
);

sessionsRouter.delete(
  "/:projectId/monitors/:monitorId",
  async (req, res) => {
    const { stopMonitor } = await import("../lib/monitors.js");
    const stopped = stopMonitor(req.params.monitorId);
    if (!stopped) {
      res.status(404).json({ error: "Monitor not found" });
      return;
    }
    res.json({ ok: true, monitor: stopped });
  }
);

// Per-session monitor surface (issue #339). Mounted at
// `/api/sessions/:sessionId/monitors` so the CLI can drop the project
// resolution step — the project + worktree is walked the same way the
// wake + goal surfaces walk it (issue #339 review: enumerates every
// worktree, not just the main one).
export const monitorBySessionIdRouter = Router();
monitorBySessionIdRouter.post(
  "/:sessionId/monitors",
  async (req, res) => {
    const { startMonitor, MAX_MONITORS_PER_SESSION, MAX_LINE_BUFFER } =
      await import("../lib/monitors.js");
    const located = await locateSessionById(req.params.sessionId);
    if (!located) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const worktreePath = located.worktreePath;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const command = typeof raw.command === "string" ? raw.command : "";
    if (!description.trim()) {
      res.status(400).json({ error: "description is required" });
      return;
    }
    if (!command.trim()) {
      res.status(400).json({ error: "command is required" });
      return;
    }
    const persistent = raw.persistent === true;
    const timeoutMs =
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
        ? raw.timeoutMs
        : undefined;
    // Issue #351: optional `--on-line` filter. When set, every
    // stdout line that matches is enqueued as a follow-up whose text is
    // `[/monitor: <description>] <line>`. We
    // compile the regex server-side so a bad pattern returns 400
    // before the monitor is started — agents that pass a typo
    // get a clear error rather than a silent "monitor started
    // but never fires" misconfiguration.
    const onLinePattern =
      typeof raw.onLine === "string" && raw.onLine.trim()
        ? raw.onLine.trim()
        : null;
    let onLine: RegExp | null = null;
    if (onLinePattern) {
      try {
        onLine = new RegExp(onLinePattern);
      } catch (error) {
        res.status(400).json({
          error: `Invalid --on-line pattern: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
    }
    try {
      const monitor = startMonitor({
        sessionId: req.params.sessionId,
        worktreePath,
        description,
        command,
        persistent,
        timeoutMs,
        limits: { maxPerSession: MAX_MONITORS_PER_SESSION, maxLines: MAX_LINE_BUFFER },
        onLine,
        onLinePattern,
        onLineMatch: ({ text }) =>
          enqueueExternalFollowUp(located, text).then(() => undefined),
      });
      res.status(201).json({ monitor });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);
monitorBySessionIdRouter.get(
  "/:sessionId/monitors",
  async (req, res) => {
    const { listMonitors } = await import("../lib/monitors.js");
    res.json({ monitors: listMonitors(req.params.sessionId) });
  }
);
// Stop by monitor id (no session qualifier needed — monitor ids are
// globally unique).
monitorBySessionIdRouter.delete("/monitors/:monitorId", async (req, res) => {
  const { stopMonitor } = await import("../lib/monitors.js");
  const stopped = stopMonitor(req.params.monitorId);
  if (!stopped) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }
  res.json({ ok: true, monitor: stopped });
});

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
  // Validate `mentions` (issue #312). The client sends the chip stack
  // at enqueue time so the queue-replay path (`advanceSessionQueue`)
  // can re-send it on the next turn. Bad rows are dropped silently —
  // the orchestrator is the source of truth, and a malformed entry
  // shouldn't fail the whole enqueue. Empty / missing is also valid
  // (a message with no mentions).
  const mentions = Array.isArray(raw.mentions)
    ? raw.mentions.filter(
        (entry): entry is { path: string; type: "file" | "directory" } =>
          Boolean(entry) &&
          typeof (entry as { path?: unknown }).path === "string" &&
          ((entry as { type?: unknown }).type === "file" ||
            (entry as { type?: unknown }).type === "directory"),
      )
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
    mentions: mentions && mentions.length > 0 ? mentions : undefined,
    // Deferred-wakeup (issue #339): an optional ISO timestamp that
    // tells the wakes consumer to hold the message until the wall clock
    // passes it. Empty / malformed input is dropped silently — a queued
    // message without a delay behaves exactly like before, and a typo
    // should not fail the whole enqueue.
    runAt: parseRunAt(raw.runAt),
  };
}

/**
 * Normalize a `runAt` field from the enqueue payload into an ISO string.
 * Empty / malformed values collapse to `undefined`. Anything not a string
 * is treated as missing; an invalid ISO is also dropped silently.
 */
function parseRunAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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
    if (!runtime.active) {
      res
        .status(409)
        .json({ error: "This session has no running process to approve against." });
      return;
    }

    // Codex approvals are answered on the shared app-server (no per-session
    // child process); the manager owns the pending request/JSON-RPC mapping.
    if (canonicalProviderId(runtime.provider ?? "") === "codex") {
      try {
        await codexAppServerManager.submitApproval(
          req.params.sessionId,
          requestId,
          decision
        );
        consumePendingApproval(req.params.sessionId, requestId);
      } catch (error) {
        res.status(404).json({
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    } else if (canonicalProviderId(runtime.provider ?? "") === "anita") {
      // Anita answers over its own stdin line protocol. The decision is just
      // the request id + an allow/deny boolean, so there is no server-tracked
      // tool input or permission-suggestion set to look up — write the
      // response line directly to the live child.
      if (!runtime.child) {
        res
          .status(409)
          .json({ error: "This session has no running process to approve against." });
        return;
      }
      const sent = sendAnitaApprovalDecision(runtime.child, requestId, decision);
      if (!sent) {
        res
          .status(409)
          .json({ error: "The session process is no longer accepting input." });
        return;
      }
      consumePendingApproval(req.params.sessionId, requestId);
    } else {
      if (!runtime.child) {
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }

    const session = await updateSessionFocus(worktree.path, sessionId, action);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Sidebar in other windows watches for `session_updated` to keep its
    // focus-queue metadata in sync (issue #210).
    emitSessionUpdated(projectId, worktree.id, sessionId);

    res.json(session);
  });
}

registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-pin", "pin");
registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-unpin", "unpin");
registerFocusActionRoute("/:projectId/sessions/:sessionId/focus-done", "done");

// Archive a session
sessionsRouter.get(
  "/:projectId/sessions/:sessionId/archive-blockers",
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { archiveBlockersFor } = await import("../lib/archive-blockers.js");
    const blockers = await archiveBlockersFor(req.params.sessionId);
    res.json({ blockers });
  }
);

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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    // Issue #351: strict-archive rule. A session cannot be
    // archived while it has a live agent, queued messages,
    // active monitors, or live children — archiving while any
    // of these is true leaves the agent or the operator in an
    // inconsistent state (a queued message firing into an
    // archived session, a monitor's events landing on a session
    // the agent no longer sees, a child recording into a parent
    // that's already been archived). The UI surfaces the
    // blockers as a tooltip on a disabled Archive button; this
    // route returns 409 with a structured `blockers` array so
    // the UI can render the specific reasons rather than a
    // generic "failed to archive" string.
    const { archiveBlockersFor } = await import("../lib/archive-blockers.js");
    const outcome = await withSessionQueueTransaction(
      req.params.sessionId,
      async (queue) => {
        const blockers = await archiveBlockersFor(req.params.sessionId);
        if (blockers.length > 0) return { kind: "blocked" as const, blockers };
        const archived = await archiveSession(worktree.path, req.params.sessionId);
        if (!archived) return { kind: "missing" as const };
        await queue.clear();
        return { kind: "archived" as const };
      }
    );
    if (outcome.kind === "blocked") {
      const blockers = outcome.blockers;
      const summary = blockers
        .map((b) => {
          switch (b.kind) {
            case "live-agent":
              return "live agent";
            case "awaiting-input":
              return "pending user input";
            case "queued-messages":
              return `${b.count} queued message${b.count === 1 ? "" : "s"}`;
            case "active-monitors":
              return `${b.count} active monitor${b.count === 1 ? "" : "s"}`;
            case "live-children":
              return `${b.count} live child${b.count === 1 ? "" : "ren"}`;
          }
        })
        .join(", ");
      res.status(409).json({
        ok: false,
        error: `Cannot archive session while it has ${summary}.`,
        blockers,
      });
      return;
    }
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    // Stop every monitor for the archived session (issue #339 review).
    // Persistent monitors otherwise keep executing their shell command
    // and appending events to the now-archived session's event log
    // until the user manually stops them or the server exits.
    // Best-effort — a stuck SIGTERM can outlive the route handler, so
    // the archive response doesn't block on the count.
    try {
      const { stopMonitorsForSession } = await import("../lib/monitors.js");
      await stopMonitorsForSession(req.params.sessionId);
    } catch (error) {
      console.error(
        `[archiveSession] monitor cleanup failed for ${req.params.sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
    // Notify the sidebar in other windows so the row disappears without
    // polling (issue #210).
    emitSessionRemoved(req.params.projectId, worktree.id, req.params.sessionId);
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
    return;
  }
  // The sidebar only needs session metadata to render its tree and focus
  // queue, so return summaries without the (potentially multi-megabyte)
  // message history. The full session is fetched on demand when opened.
  //
  // `Cache-Control: no-store` is required so the sidebar re-fetches after
  // a new session starts in this worktree. Without it, `res.json()`'s
  // auto-ETag makes the browser (or Electron) reply `304 Not Modified` on
  // soft refreshes and the sidebar keeps rendering the pre-spawn list,
  // which is exactly the bug that hid this session under `issue-353`
  // while the focus queue saw the fresh data.
  res.set("Cache-Control", "no-store");
  const sessions = await getSessionSummaries(worktree.path);
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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
    return;
  }
  const session = await getSession(worktree.path, req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

/*
 * Lightweight title lookup for a session. Powers the `controller://` link
 * label: the renderer resolves the referenced session's current title without
 * pulling the full transcript. Returns `{ title }` (null when the session has
 * no title yet), or 404 when the session/worktree doesn't exist.
 */
sessionsRouter.get(
  "/:projectId/sessions/:sessionId/title",
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
      return;
    }
    const session = await getSession(worktree.path, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ title: session.title ?? null });
  }
);

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
    res.status(404).json(
      await worktreeNotFoundPayload(
        req.params.projectId,
        req.query.worktreeId as string | undefined
      )
    );
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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
      res.status(404).json(
        await worktreeNotFoundPayload(
          req.params.projectId,
          req.query.worktreeId as string | undefined
        )
      );
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

/**
 * Derive a session's auto-title from the persisted history text. A leading
 * `[/skill: name]` marker is an implementation detail of how skill
 * invocations are stored, so it is stripped before the title is truncated.
 */
export function deriveAutoTitle(historyText: string): string {
  const source = parseSkillMarker(historyText)?.rest ?? historyText;
  return source.length > 60 ? `${source.slice(0, 60)}...` : source;
}

/**
 * Render a source session's stored transcript into a plain-text
 * block the branched agent sees as part of its first-turn prompt
 * (issue #364 + PR review P1 from chatgpt-codex-connector on #365).
 *
 * Why this lives on the route side instead of inside
 * `seedBranchFromSource`: the persistence layer copies events into
 * the new session's events file *after* the agent has already
 * started running (the seed happens inside `persistSessionStart`'s
 * post-`run.started` hook). Without this block the branched agent
 * gets only the `[/branch: …]` marker as its first message —
 * "review the proposal above" would land in a context-free run
 * even though the chat view would later render the copied
 * transcript. We need the source history baked into the prompt
 * the agent sees at spawn time.
 *
 * `session.messages` is a heterogeneous array (different agents
 * persist slightly different shapes — see issue #139 for the
 * rationale), so the helper tries the common shapes in order and
 * falls back to a JSON dump for anything it doesn't recognize.
 * The render is intentionally simple: a fenced transcript per
 * turn, prefixed with the role. Long turns are truncated to a
 * generous bound (8 KiB) so a 200-turn source doesn't blow past
 * the agent's context window.
 */
export function renderSourceTranscriptForAgent(
  messages: unknown,
  options: {
    /** Hard cap on the rendered block size in characters. */
    maxChars?: number;
  } = {}
): string {
  const maxChars = options.maxChars ?? 8 * 1024;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "The following is a transcript of the source conversation you are continuing. Treat it as read-only context; respond to the user's NEW request below it."
  );
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    const role = readRole(m);
    const text = readText(m);
    if (!text) continue;
    const safeText =
      text.length > 1024 ? `${text.slice(0, 1024)}…(truncated)` : text;
    lines.push("");
    lines.push(`[${role}]`);
    lines.push(safeText);
  }
  lines.push("");
  lines.push("--- end of source transcript ---");
  const block = lines.join("\n");
  if (block.length <= maxChars) return block;
  return `${block.slice(0, maxChars)}\n…(transcript truncated to ${maxChars} chars)`;
}

function readRole(m: Record<string, unknown>): string {
  if (typeof m.role === "string" && m.role) return m.role;
  const type = typeof m.type === "string" ? m.type : "";
  if (type === "user_message" || type === "user") return "user";
  if (type === "assistant_message" || type === "assistant") return "assistant";
  if (type === "tool") return "tool";
  if (type === "message") return "message";
  return type || "message";
}

function readText(m: Record<string, unknown>): string {
  // Prefer canonical fields first, then dig through legacy shapes.
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  const data = m.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.text === "string") return d.text;
  }
  // Last resort: JSON dump so the agent at least sees *something*.
  try {
    return JSON.stringify(m);
  } catch {
    return "";
  }
}

/**
 * Seed a brand-new session's transcript + metadata from a source
 * session (issue #364). Called from `persistSessionStart` after the
 * new session's first user_message event has been written.
 *
 * Side effects:
 *   1. Reads `<projectStoreDir>/events/<sourceSid>.jsonl` and writes
 *      `<projectStoreDir>/events/<newSid>.jsonl` with the source
 *      events followed by the user_message line the persistence
 *      layer already appended (so the chat view reads source events
 *      + branch marker as the conversation history).
 *   2. Reads the source session's `SessionState` and patches the new
 *      session file to carry the source's `provider` / `model` /
 *      `mode` (so the model picker in the composer falls back to
 *      the source's defaults for subsequent turns — the requested
 *      provider/model/mode only affected the first turn's agent
 *      spawn) and the source's `messages` array appended with the
 *      branch-marker user message (so `GET /sessions/:id` echoes
 *      the full transcript).
 *
 * Failures are non-fatal: a missing source, an unreadable events
 * file, or a write failure leaves the new session in the state the
 * rest of `persistSessionStart` left it in (empty transcript, run's
 * provider/model/mode). The agent runs unaffected — only the chat
 * view loses continuity.
 */

/**
 * Pre-create a branch session **without spawning an agent** (the
 * empty-message shortcut of `POST /sessions/branch`, see the route
 * doc above). Writes the session file with the source-derived
 * defaults (provider / model / mode / `parentId` / title), appends
 * the branch-marker `user_message` event, then delegates to
 * `seedBranchFromSource` to prepend the source's events to the new
 * events file (same shape as the agent-spawned branch).
 *
 * Returns once the new session's files are durable on disk. The
 * user types the first real turn in the composer, which routes
 * through the regular `POST /sessions` flow with `resumeSessionId`
 * set to the returned `newSessionId`; that turn picks up the
 * already-seeded transcript and starts a normal run.
 *
 * (Removed in #381 review: the empty-message shortcut was
 *  superseded by spawning an agent at branch time so the new
 *  session's id has real provider backing. Without a provider
 *  thread, the user's first real turn would `--resume` a
 *  nonexistent thread and fail — PR review P1 from
 *  chatgpt-codex-connector on #381.)
 */

export async function seedBranchFromSource(
  worktreePath: string,
  sourceSessionId: string,
  newSessionId: string,
  historyText: string,
  options: {
    /** Caller-supplied title override (the branch route's `--title`). */
    title?: string;
    /** When true, mark the new session as `unstarted: true` so the
     *  composer's provider/model/mode pickers stay unlocked on the
     *  branched session's first turn. The flag is cleared by
     *  `persistSessionStart` once the user types their first turn
     *  and the session is resumed (issue #364 + #381 P2). */
    unstarted?: boolean;
  } = {}
): Promise<void> {
  const { getSession, saveSession, getEvents } = await import(
    "../lib/sessions.js"
  );
  const { projectStoreDir } = await import("../lib/paths.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await getSession(worktreePath, sourceSessionId);
  // No source: nothing to seed. The new session keeps its empty
  // transcript (the `persistSessionStart` user_message event is the
  // only entry in the events file).
  if (!source) return;
  // 1. Prepend source events to the new session's events file.
  const sourceEvents = await getEvents(worktreePath, sourceSessionId);
  if (sourceEvents.length > 0) {
    const eventsDir = path.join(projectStoreDir(worktreePath), "events");
    await fs.mkdir(eventsDir, { recursive: true });
    const newEventsPath = path.join(eventsDir, `${newSessionId}.jsonl`);
    // `persistSessionStart` already appended the branch-marker
    // user_message event to this file via `appendEvent`. Read the
    // existing contents (just the one line) and prepend the source
    // events.
    let trailing = "";
    try {
      trailing = await fs.readFile(newEventsPath, "utf-8");
    } catch {
      // No file yet — extremely unlikely (persistSessionStart
      // should have just created it), but be defensive.
    }
    const sourceLines = sourceEvents
      .map((event) => JSON.stringify(event))
      .join("\n");
    const next = sourceLines + (trailing ? `\n${trailing.replace(/\n+$/, "")}\n` : "");
    await fs.writeFile(newEventsPath, next);
  }
  // 2. Patch the new session's file: provider/model/mode from
  // source, messages seeded, parentId set to source. We read the
  // session file the persistence layer just wrote and rewrite it
  // with the source-derived defaults. We do NOT change the agent's
  // spawn-time provider/model/mode (those already ran the first
  // turn) — only the *defaults* the model picker falls back to.
  const newSession = await getSession(worktreePath, newSessionId);
  if (!newSession) return;
  // Build the branch-marker user message for the in-file messages
  // array. Match the same prefix the route layer prepends to the
  // user-visible text so the two stay in lock-step.
  const branchMarker: Record<string, unknown> = {
    type: "user_message",
    role: "user",
    text: historyText,
    timestamp: new Date().toISOString(),
  };
  const seededMessages: unknown[] = [
    ...((Array.isArray(source.messages) ? source.messages : []) as unknown[]),
    branchMarker,
  ];
  const seededTitle =
    options.title && options.title.trim()
      ? options.title.trim()
      : newSession.title && newSession.title.length > 0
        ? newSession.title
        : source.title
          ? `Branch of ${source.title}`
          : newSession.title;
  await saveSession(worktreePath, {
    ...newSession,
    provider: source.provider ?? newSession.provider,
    model: source.model ?? newSession.model,
    mode: source.mode ?? newSession.mode,
    parentId: source.id,
    title: seededTitle,
    messages: seededMessages,
    // Mark the new session as unstarted so the composer's
    // provider/model/mode pickers stay unlocked until the user
    // types their first real turn. `persistSessionStart` clears
    // this on the subsequent resume (see its `existing?.unstarted`
    // handling).
    unstarted: options.unstarted ?? newSession.unstarted,
  });
}
