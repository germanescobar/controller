import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getProject } from "../lib/projects.js";
import { resolveWorktree } from "../lib/worktrees.js";

const execAsync = promisify(exec);
import { getSessions, getSession, getEvents, archiveSession, saveSession, appendEvent, type AgentEvent } from "../lib/sessions.js";
import { getApiKeyEnvVars } from "../lib/api-keys.js";
import { getAgentProvider, type AgentStreamEvent } from "../lib/agents.js";
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

export const sessionsRouter = Router();

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
    const untracked = listOut.split("\n").filter(Boolean).slice(0, 50);
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await Promise.all(
      untracked.map(async (file) => {
        try {
          const content = await readFile(join(worktree.path, file), "utf-8");
          const lines = content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          diff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
          diff += lines.map((l) => `+${l}`).join("\n") + "\n";
        } catch { /* skip binary / unreadable */ }
      })
    );
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
  const serviceTier = req.query.serviceTier as "fast" | "flex" | undefined;
  const providerId = (req.query.provider as string) || "ada";
  const mode = (req.query.mode as "default" | "plan" | undefined) || "default";

  const provider = getAgentProvider(providerId);
  if (!provider) {
    res.status(400).json({ error: `Unknown agent provider: ${providerId}` });
    return;
  }

  if (!message) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }

  if (providerId === "codex") {
    await streamCodexPlanSession(req, res, {
      worktreePath: worktree.path,
      worktreeId: worktree.id,
      message,
      resumeSessionId,
      model,
      reasoningEffort,
      serviceTier,
      mode,
      providerId,
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
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
  });

  let stdoutBuffer = "";
  let eventProcessing = Promise.resolve();
  // For non-Ada providers, we persist events ourselves since they don't
  // write to .coding-agent/events/ like Ada does.
  const shouldPersist = providerId !== "ada";
  let streamSessionId = resumeSessionId ?? "";
  let userMessageWritten = false;

  // Close stdin so Codex doesn't wait for additional input
  if (providerId === "codex") {
    child.stdin?.end();
  }

  const worktreePath = worktree.path;
  const worktreeId = worktree.id;

  /** Write the user message + create/update session file once we know the sessionId. */
  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    markSessionActive(sessionId, { provider: providerId, child });
    // Write user message (only for non-Ada providers that don't persist their own events)
    if (shouldPersist && !userMessageWritten) {
      userMessageWritten = true;
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: { text: message },
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

  if (resumeSessionId && shouldPersist) {
    persistSessionStart(resumeSessionId).catch(() => {});
  }

  // Forward stderr text and keep fallback approval handling for older prompts.
  child.stderr?.on("data", (data: Buffer) => {
    const raw = data.toString();
    const text = stripAnsi(raw).trim();

    // Filter out Codex's informational stdin message (but keep other content in the same chunk)
    const filtered = text
      .split("\n")
      .filter((line) => !line.includes("Reading additional input from stdin"))
      .join("\n")
      .trim();
    if (!filtered) return;

    sseSend({ type: "stderr", text: filtered });

    if (raw.includes("[y/n]")) {
      child.stdin?.write("y\n");
    }
  });

  child.stdout?.on("data", (data: Buffer) => {
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
          const event = provider.parseEvent(line);
          if (event) {
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
                sseSend({ type: "ada_event", event });
              })
              .catch(() => {});
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

  child.on("close", (code) => {
    eventProcessing
      .catch(() => {})
      .then(() => {
    const lastLine = stdoutBuffer.trim();
    if (lastLine.length > 0) {
      try {
        const event = provider.parseEvent(lastLine);
        if (event) {
          if (shouldPersist && event.type !== "run.completed" && event.type !== "run.failed") {
            persistAgentEvent(event);
          }
          sseSend({ type: "ada_event", event });
        }
      } catch {
        sseSend({
          type: "error",
          text: `Failed to parse final ${provider.name} stream JSON line.`,
          raw: lastLine,
        });
      }
    }

    // Update runtime state and lastActiveAt once the stream closes.
    if (streamSessionId) {
      markSessionInactive(streamSessionId);
      getSession(worktreePath, streamSessionId).then((existing) => {
        if (existing) {
          existing.lastActiveAt = new Date().toISOString();
          saveSession(worktreePath, existing);
        }
      }).catch(() => {});
    }

    sseSend({ type: "done", exitCode: code });
    if (clientConnected) res.end();
      });
  });

  child.on("error", (err) => {
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
  });
});

async function streamCodexPlanSession(
  req: Request,
  res: Response,
  options: {
    worktreePath: string;
    worktreeId: string;
    message: string;
    resumeSessionId?: string;
    model?: string;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    serviceTier?: "fast" | "flex";
    mode: "default" | "plan";
    providerId: string;
  }
) {
  const {
    worktreePath,
    worktreeId,
    message,
    resumeSessionId,
    model,
    reasoningEffort,
    serviceTier,
    mode,
    providerId,
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
      markSessionInactive(streamSessionId);
    }
    await touchSession();
    sseSend({ type: "done", exitCode });
    if (clientConnected) res.end();
  }

  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    markSessionActive(sessionId, { provider: providerId });
    if (!userMessageWritten) {
      userMessageWritten = true;
      await appendEvent(worktreePath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: { text: message },
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
          await finishStream(event.type === "run.completed" ? 0 : 1);
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
      },
      handleEvent
    );
    await turn.done;
    await eventProcessing;
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
      if (providerId === "ada") {
        await stopSessionRuntime(req.params.sessionId);
      } else {
        await codexAppServerManager.stopSession(req.params.sessionId);
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
    res.json(events);
  }
);
