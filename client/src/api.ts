const BASE = "/api";

import type { ShortcutBindings } from "../../shared/shortcuts.ts";
import { shouldExcludeDirectory } from "./lib/file-excludes.ts";

export interface Project {
  id: string;
  name: string;
  path: string;
  setupCommands?: string;
  runCommands?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  title?: string;
  workingDirectory: string;
  worktreeId?: string;
  model: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  provider?: string;
  mode?: "default" | "plan";
  messages: unknown[];
  createdAt: string;
  lastActiveAt: string;
  status: string;
  focusPinnedAt?: string;
  focusDoneAt?: string;
  // True when the user explicitly unpinned the session from the focus
  // queue. Used by the server to prevent auto-pin from silently
  // re-pinning a session the user removed.
  userUnpinned?: boolean;
}

/**
 * A session without its `messages` history. The session-list endpoint returns
 * these so the sidebar/focus queue avoids downloading every transcript (which
 * can total tens of megabytes). The full `Session` is fetched on demand when a
 * session is opened.
 */
export type SessionSummary = Omit<Session, "messages">;

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch?: string;
  isMain: boolean;
  portOffset?: number;
  createdAt: string;
  setupRanAt?: string;
  setupExitCode?: number;
  setupLogPath?: string;
}

export interface TerminalTab {
  id: string;
  label: string;
}

export interface SourceFile {
  path: string;
  relativePath: string;
  content: string;
}

export interface SourceDirectoryEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "directory" | "file";
}

export type WorktreeCreateEvent =
  | { type: "started"; name: string; branch: string }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "worktree_created"; worktree: Worktree }
  | { type: "error"; text: string }
  | { type: "done"; exitCode: number; worktree?: Worktree };

/**
 * Project-scoped lifecycle event delivered by the
 * `GET /api/projects/:projectId/events` SSE stream (issue #210).
 *
 * Mirrors the server's `ProjectEvent` union. The app shell subscribes
 * to this stream and refetches the relevant slice of state when an
 * event lands (instead of polling).
 */
export type ProjectEvent =
  | { type: "worktree_added"; projectId: string; worktree: Worktree }
  | { type: "worktree_removed"; projectId: string; worktreeId: string }
  | { type: "worktree_updated"; projectId: string; worktree: Worktree }
  | { type: "session_added"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "session_removed"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "session_updated"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "project_added"; project: Project }
  | { type: "project_updated"; project: Project }
  | { type: "project_removed"; projectId: string };

export interface WorktreeSetupLogResponse {
  log: string | null;
  exitCode: number | null;
  ranAt: string | null;
}

export type WorktreeSetupEvent =
  | { type: "started"; worktreeId: string }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; exitCode: number; worktree?: Worktree };

export interface SessionRuntime {
  active: boolean;
}

export interface SessionRuntimeEntry {
  sessionId: string;
  active: boolean;
  provider?: string;
  projectId?: string;
  worktreeId?: string;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface SessionAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  isImage: boolean;
  createdAt?: string;
  url?: string;
}

export interface PendingAttachmentUpload {
  name: string;
  mimeType: string;
  size: number;
  data: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
}

export type AnitaStreamEvent =
  | {
      type: "run.started";
      sessionId: string;
      model: string;
      workingDirectory: string;
      timestamp: string;
    }
  | {
      type: "assistant.text";
      text: string;
    }
  | {
      type: "assistant.reasoning";
      text: string;
    }
  | {
      type: "tool.call";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool.result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "plan.updated";
      explanation: string | null;
      plan: PlanStep[];
    }
  | {
      type: "plan.delta";
      id: string;
      delta: string;
    }
  | {
      type: "user.input_requested";
      id: string;
      questions: UserInputQuestion[];
    }
  | {
      type: "tool.approval_requested";
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions: Record<string, unknown>[];
    }
  | {
      type: "tool.approval_resolved";
      id: string;
      approved: boolean;
      reason: "aborted" | "eof" | "error";
    }
  | {
      type: "thread.status";
      threadId: string;
      status: string;
      activeFlags?: string[];
    }
  | {
      type: "run.completed";
      sessionId: string;
      status: "completed" | "max_iterations";
      stopReason: string;
      timestamp: string;
    }
  | {
      type: "run.failed";
      sessionId: string;
      error: string;
      timestamp: string;
    }
  | {
      type: "run.cancelled";
      sessionId: string;
      reason: string;
      timestamp: string;
    };

export type SessionStreamEvent =
  | { type: "started" }
  | { type: "anita_event"; event: AnitaStreamEvent }
  | { type: "stderr"; text: string }
  | { type: "done"; exitCode: number | null }
  | { type: "error"; text: string; raw?: string }
  | { type: "session_focus"; focusPinnedAt: string | undefined };

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  await throwIfNotOk(res, "Failed to fetch projects");
  const body = await res.json().catch(() => {
    throw new Error("Failed to fetch projects");
  });
  if (!Array.isArray(body)) {
    throw new Error("Failed to fetch projects");
  }
  return body;
}

export async function createProject(
  name: string,
  path: string,
  setupCommands?: string,
  runCommands?: string
): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path, setupCommands, runCommands }),
  });
  return res.json();
}

export async function updateProject(
  id: string,
  patch: { name?: string; setupCommands?: string; runCommands?: string }
): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`${BASE}/projects/${id}`, { method: "DELETE" });
}

function withWorktree(worktreeId?: string, extra?: URLSearchParams): string {
  const params = extra ?? new URLSearchParams();
  if (worktreeId) params.set("worktreeId", worktreeId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function throwIfNotOk(res: Response, fallbackMessage: string): Promise<void> {
  if (res.ok) return;
  const body = await res.clone().json().catch(async () => {
    const text = await res.text().catch(() => "");
    return text.trim() ? { error: text.trim() } : {};
  }) as { error?: unknown; message?: unknown };
  const rawMessage = body.error ?? body.message;
  if (typeof rawMessage === "string" && rawMessage.trim()) {
    throw new Error(rawMessage);
  }
  if (rawMessage && typeof rawMessage === "object") {
    const nested = rawMessage as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) {
      throw new Error(nested.message);
    }
  }
  throw new Error(fallbackMessage);
}

export async function fetchSessions(
  projectId: string,
  worktreeId?: string
): Promise<SessionSummary[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions${withWorktree(worktreeId)}`
  );
  return res.json();
}

export async function fetchSession(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<Session> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}${withWorktree(worktreeId)}`
  );
  await throwIfNotOk(res, "Failed to fetch session");
  return res.json();
}

/*
 * Lightweight lookup of a session's current title, used to label
 * `controller://` conversation links without fetching the full transcript.
 * Returns null when the session has no title, doesn't exist, or the request
 * fails — callers fall back to a neutral label.
 */
export async function fetchSessionTitle(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${BASE}/projects/${projectId}/sessions/${sessionId}/title${withWorktree(worktreeId)}`
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: string | null };
    return body.title ?? null;
  } catch {
    return null;
  }
}

export async function updateSessionTitle(
  projectId: string,
  sessionId: string,
  title: string,
  worktreeId?: string
): Promise<Session> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}${withWorktree(worktreeId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }
  );
  await throwIfNotOk(res, "Failed to update session title");
  return res.json();
}

export async function fetchSessionRuntime(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<SessionRuntime> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/runtime${withWorktree(worktreeId)}`
  );
  await throwIfNotOk(res, "Failed to fetch session runtime");
  return res.json();
}

/**
 * Bulk snapshot of every session runtime the server knows about. Cheaper than
 * calling `fetchSessionRuntime` per session — useful for the sidebar, which
 * needs the active state of every session in the workspace.
 */
export async function fetchActiveRuntimes(): Promise<SessionRuntimeEntry[]> {
  const res = await fetch(`${BASE}/runtimes`);
  await throwIfNotOk(res, "Failed to fetch session runtimes");
  const body = (await res.json()) as { sessions?: unknown };
  if (!body || !Array.isArray(body.sessions)) return [];
  return body.sessions.filter(
    (entry): entry is SessionRuntimeEntry =>
      Boolean(entry) &&
      typeof (entry as SessionRuntimeEntry).sessionId === "string" &&
      typeof (entry as SessionRuntimeEntry).active === "boolean",
  );
}

export async function archiveSession(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<void> {
  await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/archive${withWorktree(worktreeId)}`,
    { method: "POST" }
  );
}

async function updateSessionFocus(
  projectId: string,
  sessionId: string,
  action: "focus-pin" | "focus-unpin" | "focus-done",
  worktreeId?: string
): Promise<Session> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/${action}${withWorktree(worktreeId)}`,
    { method: "POST" }
  );
  await throwIfNotOk(res, "Failed to update focus queue");
  return res.json();
}

export async function pinSessionFocus(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<Session> {
  return updateSessionFocus(projectId, sessionId, "focus-pin", worktreeId);
}

export async function unpinSessionFocus(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<Session> {
  return updateSessionFocus(projectId, sessionId, "focus-unpin", worktreeId);
}

export async function markSessionFocusDone(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<Session> {
  return updateSessionFocus(projectId, sessionId, "focus-done", worktreeId);
}

export async function fetchEvents(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<AgentEvent[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/events${withWorktree(worktreeId)}`
  );
  await throwIfNotOk(res, "Failed to fetch events");
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("Failed to fetch events");
  }
  return body;
}

export async function stopSession(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/stop${withWorktree(worktreeId)}`,
    { method: "POST" }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to stop session");
  }
}

export async function steerSession(
  projectId: string,
  sessionId: string,
  message: string,
  worktreeId?: string,
  queuedMessageId?: string
): Promise<{ disposition: "steered" | "queued"; message?: QueuedMessage }> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/steer${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, queuedMessageId }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to steer session");
  }
  return await res.json() as {
    disposition: "steered" | "queued";
    message?: QueuedMessage;
  };
}

/** A message enqueued to run after the active turn completes (see issue #113). */
export interface QueuedMessage {
  id: string;
  text: string;
  visibleText: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: "fast";
  mode: "default" | "plan";
  attachmentIds: string[];
  skillName?: string;
  createdAt: string;
}

export interface QueuedMessageInput extends Omit<QueuedMessage, "id" | "createdAt"> {
  /**
   * File/directory mentions from the composer's `@` picker (issue #312).
   * The orchestrator snapshots the chip stack at enqueue time and the
   * queue-replay effect re-sends it on the next turn so the resolved
   * mention block in the prompt matches what the user typed. Mirrors
   * the `mentions` query param on `startSession`.
   */
  mentions?: { path: string; type: "file" | "directory" }[];
}

export async function fetchSessionQueue(
  projectId: string,
  sessionId: string
): Promise<QueuedMessage[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/queue`
  );
  await throwIfNotOk(res, "Failed to fetch message queue");
  const body = (await res.json()) as { queue?: QueuedMessage[] };
  return body.queue ?? [];
}

export async function enqueueSessionMessage(
  projectId: string,
  sessionId: string,
  input: QueuedMessageInput
): Promise<QueuedMessage> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  await throwIfNotOk(res, "Failed to enqueue message");
  const body = (await res.json()) as { message: QueuedMessage };
  return body.message;
}

export async function removeSessionQueuedMessage(
  projectId: string,
  sessionId: string,
  messageId: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/queue/${messageId}`,
    { method: "DELETE" }
  );
  await throwIfNotOk(res, "Failed to remove queued message");
}

export async function submitSessionUserInput(
  projectId: string,
  sessionId: string,
  answers: Record<string, string | string[]>,
  worktreeId?: string
): Promise<{ resumeMessage?: string; resumeMode?: "default" | "plan" }> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/user-input${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    }
  );

  if (!res.ok) {
    let message = "Failed to submit user input";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore JSON parsing errors and use the default message.
    }

    throw new Error(message);
  }

  return (await res.json()) as { resumeMessage?: string; resumeMode?: "default" | "plan" };
}

export type ToolApprovalDecision = "allow_once" | "always_allow" | "deny";

/**
 * Answer a pending Claude tool-approval prompt. The decision is written to the
 * still-running process's control channel; the run continues on the same SSE
 * stream rather than resuming a new turn.
 */
export async function submitToolApproval(
  projectId: string,
  sessionId: string,
  requestId: string,
  decision: ToolApprovalDecision,
  worktreeId?: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/tool-approval${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    }
  );

  if (!res.ok) {
    let message = "Failed to submit approval";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore JSON parsing errors and use the default message.
    }

    throw new Error(message);
  }
}

export async function dismissSessionUserInput(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/user-input/dismiss${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );

  if (!res.ok) {
    let message = "Failed to dismiss user input";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore JSON parsing errors and use the default message.
    }

    throw new Error(message);
  }
}

export interface ModelCapabilities {
  images: boolean;
  files: boolean;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  size: string;
  group?: string;
  contextWindowTokens?: number;
  capabilities?: ModelCapabilities;
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ServiceTier = "fast" | "flex";

export interface ProviderFieldStatus {
  id: string;
  label: string;
  configured: boolean;
  hint: string | null;
  secret: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  /**
   * When true, the provider exposes a single field and the legacy shape
   * (one key per provider) applies. The Cloudflare provider is the
   * canonical multi-field provider; the UI renders one row per field
   * when `singleField` is false.
   */
  singleField: boolean;
  fields: ProviderFieldStatus[];
}

export interface AgentProviderInfo {
  id: string;
  name: string;
}

export async function fetchAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await fetch(`${BASE}/agent-providers`);
  return res.json();
}

export type SkillScope =
  | "unified"
  | "user"
  | "system"
  | "repo"
  | "controller";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
}

export async function fetchAgentSkills(
  providerId: string,
  cwd: string
): Promise<AgentSkill[]> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  const qs = params.toString();
  const res = await fetch(
    `${BASE}/agents/${encodeURIComponent(providerId)}/skills${qs ? `?${qs}` : ""}`
  );
  await throwIfNotOk(res, "Failed to fetch skills");
  const body = (await res.json()) as { skills?: unknown };
  if (!body || !Array.isArray(body.skills)) return [];
  return body.skills.filter(
    (entry): entry is AgentSkill =>
      Boolean(entry) &&
      typeof (entry as AgentSkill).name === "string" &&
      typeof (entry as AgentSkill).description === "string" &&
      typeof (entry as AgentSkill).path === "string" &&
      typeof (entry as AgentSkill).scope === "string"
  );
}

export interface UnifiedSkillInput {
  name: string;
  description: string;
  body: string;
}

export type UnifiedSkill = AgentSkill & { scope: "unified" };

export async function fetchUnifiedSkills(): Promise<UnifiedSkill[]> {
  const res = await fetch(`${BASE}/unified-skills`);
  await throwIfNotOk(res, "Failed to fetch unified skills");
  const body = (await res.json()) as { skills?: unknown };
  if (!body || !Array.isArray(body.skills)) return [];
  return body.skills.filter(
    (entry): entry is UnifiedSkill =>
      Boolean(entry) &&
      typeof (entry as UnifiedSkill).name === "string" &&
      typeof (entry as UnifiedSkill).description === "string" &&
      typeof (entry as UnifiedSkill).path === "string" &&
      (entry as UnifiedSkill).scope === "unified"
  );
}

export async function fetchUnifiedSkill(name: string): Promise<{ metadata: UnifiedSkill; body: string }> {
  const res = await fetch(`${BASE}/unified-skills/${encodeURIComponent(name)}`);
  await throwIfNotOk(res, "Failed to fetch unified skill");
  return res.json();
}

export async function createUnifiedSkill(
  input: UnifiedSkillInput
): Promise<UnifiedSkill> {
  const res = await fetch(`${BASE}/unified-skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res, "Failed to create unified skill");
  return res.json();
}

export async function updateUnifiedSkill(
  name: string,
  input: UnifiedSkillInput
): Promise<UnifiedSkill> {
  const res = await fetch(`${BASE}/unified-skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res, "Failed to update unified skill");
  return res.json();
}

export async function deleteUnifiedSkill(name: string): Promise<void> {
  const res = await fetch(`${BASE}/unified-skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  await throwIfNotOk(res, "Failed to delete unified skill");
}

export type ImportableSkillScope = "user" | "system" | "repo";

export interface ImportableSkill {
  name: string;
  description: string;
  providerId: string;
  scope: ImportableSkillScope;
  sourcePath: string;
  projectPath: string | null;
}

export async function fetchImportableSkills(): Promise<ImportableSkill[]> {
  const res = await fetch(`${BASE}/unified-skills/import/discover`);
  await throwIfNotOk(res, "Failed to discover importable skills");
  const body = (await res.json()) as { skills?: unknown };
  if (!body || !Array.isArray(body.skills)) return [];
  return body.skills.filter(
    (entry): entry is ImportableSkill =>
      Boolean(entry) &&
      typeof (entry as ImportableSkill).name === "string" &&
      typeof (entry as ImportableSkill).providerId === "string" &&
      typeof (entry as ImportableSkill).sourcePath === "string" &&
      (entry as ImportableSkill).scope !== undefined
  );
}

export type SkillImportStatus = "imported" | "skipped" | "error";

export interface SkillImportResult {
  providerId: string;
  scope: ImportableSkillScope;
  name: string;
  status: SkillImportStatus;
  reason?: string;
  metadata?: UnifiedSkill;
}

export interface SkillImportRequest {
  selections: Array<{
    providerId: string;
    sourcePath: string;
    scope: ImportableSkillScope;
    overwrite?: boolean;
  }>;
}

export async function importUnifiedSkills(
  request: SkillImportRequest
): Promise<{ results: SkillImportResult[] }> {
  const res = await fetch(`${BASE}/unified-skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  await throwIfNotOk(res, "Failed to import skills");
  return res.json();
}

export interface AgentStatus {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  enabled: boolean;
  resolvedPath: string | null;
  version: string | null;
  defaultModel: string | null;
  autoApprove: boolean;
}

export async function fetchAgents(): Promise<AgentStatus[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function updateAgent(
  agentId: string,
  patch: {
    enabled?: boolean;
    path?: string | null;
    defaultModel?: string | null;
    autoApprove?: boolean;
  }
): Promise<AgentStatus> {
  const res = await fetch(`${BASE}/agents/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await throwIfNotOk(res, "Failed to update agent");
  return res.json();
}

export async function fetchModels(agent?: string): Promise<Model[]> {
  const params = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const res = await fetch(`${BASE}/models${params}`);
  return res.json();
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  const res = await fetch(`${BASE}/api-keys`);
  return res.json();
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await deleteProviderField(providerId, "apiToken");
}

/**
 * Set a single field on a provider. Multi-field providers (e.g. Cloudflare)
 * expose one field per editable value: `accountId`, `apiToken`,
 * `aiGatewayId`. Single-field providers expose the implicit `apiToken` field.
 */
export async function setProviderField(
  providerId: string,
  fieldId: string,
  value: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/api-keys/${encodeURIComponent(providerId)}/${encodeURIComponent(fieldId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }
  );
  await throwIfNotOk(res, "Failed to save field");
}

/** Remove a single field on a provider. */
export async function deleteProviderField(
  providerId: string,
  fieldId: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/api-keys/${encodeURIComponent(providerId)}/${encodeURIComponent(fieldId)}`,
    { method: "DELETE" }
  );
  await throwIfNotOk(res, "Failed to delete field");
}

// --- Integrations (issue #130) ---

// A connection is two orthogonal axes: a transport (how we reach the backend)
// and an auth mode (how a credential is acquired and attached). They compose,
// so any transport works with any auth mode.
export type ConnectionMode = "mcp" | "openapi" | "rest" | "graphql" | "cli";

// Auth is an AND-set of scheme instances. Each scheme is two orthogonal pieces:
// an acquisition (how the credential value is produced) and an attachment
// (where the value is placed). An API token, a Trello query key, and an OAuth
// access token differ only in acquisition; most attach the same way.
export type Acquisition =
  | "static"
  | "basic"
  | "oauth"
  | "oauth_client_credentials"
  | "oauth_dynamic"
  | "cloud"
  | "hmac"
  | "mtls";

export interface Attachment {
  kind: "header" | "query";
  name: string;
  prefix?: string;
}

export interface TransportConfig {
  mode: ConnectionMode;
  config: Record<string, string>;
  // Constant non-secret headers applied to every request (e.g. Notion-Version).
  headers: Record<string, string>;
  // Constant non-secret query params applied to every request (e.g. api-version).
  query: Record<string, string>;
}

// State of a credential Controller acquires on the user's behalf (OAuth, STS).
// Acquisition is not implemented yet, so schemes start "none".
export interface AcquiredState {
  status: "none" | "connected" | "expired";
  expiresAt?: string;
}

export interface AuthScheme {
  id: string;
  acquisition: Acquisition;
  attachment?: Attachment;
  config: Record<string, string>;
  // Whether a secret value is stored; the value itself never leaves the server.
  hasSecret: boolean;
  acquired?: AcquiredState;
}

export interface AuthConfig {
  schemes: AuthScheme[];
}

export interface IntegrationConnection {
  id: string;
  name: string;
  enabled: boolean;
  transport: TransportConfig;
  auth: AuthConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSchemeInput {
  id?: string;
  acquisition: Acquisition;
  attachment?: Attachment;
  config?: Record<string, string>;
  // undefined = keep stored secret; "" = clear it; non-empty = set it.
  secret?: string;
}

export interface ConnectionInput {
  name: string;
  enabled?: boolean;
  transport: {
    mode: ConnectionMode;
    config?: Record<string, string>;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
  auth: { schemes: AuthSchemeInput[] };
}

// Auth scheme set derived from an OpenAPI spec's securitySchemes/security.
export interface DerivedScheme {
  acquisition: Acquisition;
  attachment?: Attachment;
  config: Record<string, string>;
  label: string;
}

export interface SchemeAlternative {
  schemes: DerivedScheme[];
}

export interface OpenApiAuthInfo {
  title?: string;
  baseUrl?: string;
  alternatives: SchemeAlternative[];
  unsupported: string[];
}

export async function fetchConnections(): Promise<IntegrationConnection[]> {
  const res = await fetch(`${BASE}/integrations`);
  await throwIfNotOk(res, "Failed to fetch integrations");
  return res.json();
}

export async function createConnection(
  input: ConnectionInput
): Promise<IntegrationConnection> {
  const res = await fetch(`${BASE}/integrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res, "Failed to create integration");
  return res.json();
}

export async function updateConnection(
  id: string,
  patch: Partial<ConnectionInput>
): Promise<IntegrationConnection> {
  const res = await fetch(`${BASE}/integrations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await throwIfNotOk(res, "Failed to update integration");
  return res.json();
}

export async function deleteConnection(id: string): Promise<void> {
  const res = await fetch(`${BASE}/integrations/${id}`, { method: "DELETE" });
  await throwIfNotOk(res, "Failed to delete integration");
}

export async function inspectOpenApiSpec(specUrl: string): Promise<OpenApiAuthInfo> {
  const res = await fetch(`${BASE}/integrations/openapi/inspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specUrl }),
  });
  await throwIfNotOk(res, "Failed to inspect spec");
  return res.json();
}

export interface OAuthDynamicStatus {
  status: "none" | "connected" | "expired";
  expiresAt?: string;
}

/**
 * Kick off the OAuth (dynamic / MCP) acquisition for a scheme (issue #280).
 * The server discovers the AS, registers a client, opens the user's browser
 * to the auth URL, captures the redirect, and stores the resulting tokens.
 * The call blocks until the user finishes the browser flow (or it times
 * out) so the form can show a single spinner.
 */
export async function acquireOAuthDynamic(
  connectionId: string,
  schemeId: string
): Promise<OAuthDynamicStatus> {
  const res = await fetch(
    `${BASE}/integrations/${encodeURIComponent(connectionId)}/schemes/${encodeURIComponent(schemeId)}/acquire`,
    { method: "POST" }
  );
  await throwIfNotOk(res, "Failed to start OAuth acquisition");
  const json = (await res.json()) as { ok: true; status: OAuthDynamicStatus };
  return json.status;
}

export async function fetchOAuthDynamicStatus(
  connectionId: string,
  schemeId: string
): Promise<OAuthDynamicStatus> {
  const res = await fetch(
    `${BASE}/integrations/${encodeURIComponent(connectionId)}/schemes/${encodeURIComponent(schemeId)}/status`
  );
  await throwIfNotOk(res, "Failed to fetch scheme status");
  return res.json();
}

export async function disconnectOAuthDynamic(
  connectionId: string,
  schemeId: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/integrations/${encodeURIComponent(connectionId)}/schemes/${encodeURIComponent(schemeId)}/acquire`,
    { method: "DELETE" }
  );
  await throwIfNotOk(res, "Failed to disconnect scheme");
}

export function startSession(
  projectId: string,
  message: string,
  options?: {
    resumeSessionId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    serviceTier?: ServiceTier;
    provider?: string;
    mode?: "default" | "plan";
    worktreeId?: string;
    attachmentIds?: string[];
    /**
     * Repo-relative paths the user referenced with `@` in the composer
     * (issue #312). The backend resolves each path against the active
     * worktree, reads a preview, and prepends a deterministic
     * `<mentions>...</mentions>` block to the agent prompt so two runs
     * that mention the same files produce identical prompts.
     */
    mentions?: { path: string; type: "file" | "directory" }[];
    skillName?: string;
  }
): EventSource {
  const params = new URLSearchParams({ message });
  if (options?.resumeSessionId) params.set("resumeSessionId", options.resumeSessionId);
  if (options?.model != null) params.set("model", options.model);
  if (options?.reasoningEffort) params.set("reasoningEffort", options.reasoningEffort);
  if (options?.serviceTier) params.set("serviceTier", options.serviceTier);
  if (options?.provider) params.set("provider", options.provider);
  if (options?.mode) params.set("mode", options.mode);
  if (options?.worktreeId) params.set("worktreeId", options.worktreeId);
  if (options?.attachmentIds?.length) {
    params.set("attachmentIds", options.attachmentIds.join(","));
  }
  if (options?.mentions?.length) {
    // The backend re-checks every path against the worktree root before
    // reading it, so this list is a hint, not an authorization. The
    // serialised form is `path|type,path|type,…` so a single comma-
    // separated query param carries both fields without a second round
    // trip. Reorder-preserving: the backend sorts by request order so
    // the mention block in the prompt matches the chip order in the
    // composer.
    const encoded = options.mentions
      .map((mention) => `${mention.path}|${mention.type}`)
      .join(",");
    params.set("mentions", encoded);
  }
  if (options?.skillName) params.set("skillName", options.skillName);
  return new EventSource(
    `${BASE}/projects/${projectId}/sessions/stream?${params}`
  );
}

/**
 * Subscribe to project-scoped lifecycle events (issue #210).
 *
 * Returns the raw `EventSource` so callers can `.close()` it. The
 * server emits heartbeats as `: ping` comment lines; the browser's
 * `EventSource` ignores those, but a stalled connection will trigger
 * the standard `error` event, which the app shell uses to retry with
 * backoff.
 */
export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: ProjectEvent) => void
): EventSource {
  const source = new EventSource(
    `${BASE}/projects/${projectId}/events`
  );
  source.addEventListener("message", (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(ev.data) as ProjectEvent;
      onEvent(parsed);
    } catch {
      // Ignore malformed payloads — the server is the source of truth
      // and a refetch will reconcile.
    }
  });
  return source;
}

export async function uploadSessionAttachments(
  projectId: string,
  attachments: PendingAttachmentUpload[],
  worktreeId?: string
): Promise<SessionAttachment[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/attachments${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachments }),
    }
  );
  await throwIfNotOk(res, "Failed to upload attachments");
  const body = (await res.json()) as { attachments?: SessionAttachment[] };
  return body.attachments ?? [];
}

export async function fetchBranches(
  projectId: string
): Promise<{ branches: string[]; head: string | null; defaultBranch: string | null }> {
  const res = await fetch(`${BASE}/projects/${projectId}/branches`);
  return res.json();
}

export async function fetchGitDiff(
  projectId: string,
  worktreeId?: string
): Promise<{ diff: string }> {
  const params = worktreeId ? `?worktreeId=${encodeURIComponent(worktreeId)}` : "";
  const res = await fetch(`${BASE}/projects/${projectId}/git/diff${params}`);
  return res.json();
}

export async function fetchBranchDiff(
  projectId: string,
  worktreeId?: string
): Promise<{ diff: string }> {
  const params = worktreeId ? `?worktreeId=${encodeURIComponent(worktreeId)}` : "";
  const res = await fetch(`${BASE}/projects/${projectId}/git/branch-diff${params}`);
  return res.json();
}

export async function fetchWorktrees(projectId: string): Promise<Worktree[]> {
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees`);
  return res.json();
}

export async function fetchTerminalTabs(
  projectId: string,
  worktreeId?: string
): Promise<TerminalTab[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/terminal-tabs${withWorktree(worktreeId)}`
  );
  await throwIfNotOk(res, "Failed to fetch terminal tabs");
  const body = (await res.json()) as { tabs?: unknown };
  return Array.isArray(body.tabs) ? (body.tabs as TerminalTab[]) : [];
}

export async function updateTerminalTabs(
  projectId: string,
  tabs: TerminalTab[],
  worktreeId?: string,
  options?: { removeTerminalId?: string }
): Promise<TerminalTab[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/terminal-tabs${withWorktree(worktreeId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs, removeTerminalId: options?.removeTerminalId }),
    }
  );
  await throwIfNotOk(res, "Failed to update terminal tabs");
  const body = (await res.json()) as { tabs?: unknown };
  return Array.isArray(body.tabs) ? (body.tabs as TerminalTab[]) : tabs;
}

export async function runProjectScript(
  projectId: string,
  worktreeId?: string
): Promise<{ terminalId: string; tabs: TerminalTab[] }> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/run-script${withWorktree(worktreeId)}`,
    { method: "POST" }
  );
  await throwIfNotOk(res, "Failed to run project script");
  const body = (await res.json()) as { terminalId?: unknown; tabs?: unknown };
  if (typeof body.terminalId !== "string" || !Array.isArray(body.tabs)) {
    throw new Error("Failed to run project script");
  }
  return { terminalId: body.terminalId, tabs: body.tabs as TerminalTab[] };
}

export async function fetchSourceFile(
  projectId: string,
  filePath: string,
  worktreeId?: string
): Promise<SourceFile> {
  const params = new URLSearchParams({ path: filePath });
  const query = withWorktree(worktreeId, params);
  const res = await fetch(`${BASE}/projects/${projectId}/source${query}`);
  await throwIfNotOk(res, "Failed to open source file");
  return res.json();
}

export async function fetchSourceDirectory(
  projectId: string,
  dirPath?: string,
  worktreeId?: string
): Promise<SourceDirectoryEntry[]> {
  const params = new URLSearchParams();
  if (dirPath) params.set("path", dirPath);
  const query = withWorktree(worktreeId, params);
  const res = await fetch(`${BASE}/projects/${projectId}/files${query}`);
  await throwIfNotOk(res, "Failed to list files");
  const body = (await res.json()) as { entries?: unknown };
  const raw = Array.isArray(body.entries) ? (body.entries as SourceDirectoryEntry[]) : [];
  // Apply the client-side skip list (issue #313). See
  // `client/src/lib/file-excludes.ts` for the rationale. The server
  // still returns every entry — filtering here keeps the
  // `SourceDirectoryEntry` shape unchanged and makes it trivial to
  // swap in a server-side filter later without touching consumers.
  return raw.filter((entry) => {
    if (entry.type !== "directory") return true;
    return !shouldExcludeDirectory(entry.name);
  });
}

/**
 * Recursive file/directory walk for the `@`-mention picker (issue #312).
 * Returns a flat list of every path under the active worktree (subject
 * to the server's depth/limit caps and its denylist of directories
 * that should never be mentioned — `node_modules`, `.git`, build
 * artifacts, …). The list is then fuzzy-matched client-side so the
 * picker can rank candidates as the user types.
 *
 * The walk is bounded: the server caps depth (default 8, max 32) and
 * node count (default 2000, max 20000), and returns a `truncated`
 * flag when the cap is hit. Callers should surface the truncation as
 * a hint in the picker rather than a hard error.
 */
export async function fetchSourceIndex(
  projectId: string,
  worktreeId?: string,
  options?: { depth?: number; limit?: number }
): Promise<{ entries: SourceDirectoryEntry[]; truncated: boolean }> {
  const params = new URLSearchParams();
  if (options?.depth) params.set("depth", String(options.depth));
  if (options?.limit) params.set("limit", String(options.limit));
  const query = withWorktree(worktreeId, params);
  const res = await fetch(`${BASE}/projects/${projectId}/file-index${query}`);
  await throwIfNotOk(res, "Failed to index files");
  const body = (await res.json()) as { entries?: unknown; truncated?: unknown };
  return {
    entries: Array.isArray(body.entries)
      ? (body.entries as SourceDirectoryEntry[])
      : [],
    truncated: body.truncated === true,
  };
}

export async function deleteWorktree(
  projectId: string,
  worktreeId: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    let message = "Failed to delete worktree";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
}

export async function fetchWorktreeSetupLog(
  projectId: string,
  worktreeId: string
): Promise<WorktreeSetupLogResponse> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/setup-log`
  );
  await throwIfNotOk(res, "Failed to fetch setup log");
  const body = (await res.json()) as {
    log?: unknown;
    exitCode?: unknown;
    ranAt?: unknown;
  };
  return {
    log: typeof body.log === "string" ? body.log : null,
    exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
    ranAt: typeof body.ranAt === "string" ? body.ranAt : null,
  };
}

/**
 * Stream worktree creation via SSE. The returned object exposes the
 * underlying EventSource (so callers can `.close()`) plus a `subscribe`
 * helper for typed events.
 */
export function createWorktree(
  projectId: string,
  body: { name: string; branch?: string; baseBranch?: string }
): {
  events: AsyncIterable<WorktreeCreateEvent>;
  cancel: () => void;
  result: Promise<Worktree>;
} {
  const controller = new AbortController();

  const queue: WorktreeCreateEvent[] = [];
  let resolveNext: ((v: IteratorResult<WorktreeCreateEvent>) => void) | null = null;
  let done = false;
  let error: Error | null = null;

  function push(event: WorktreeCreateEvent) {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: event, done: false });
    } else {
      queue.push(event);
    }
  }

  function finish(err?: Error) {
    done = true;
    if (err) error = err;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      if (err) r({ value: undefined as unknown as WorktreeCreateEvent, done: true });
      else r({ value: undefined as unknown as WorktreeCreateEvent, done: true });
    }
  }

  let resolveResult: (w: Worktree) => void = () => {};
  let rejectResult: (e: Error) => void = () => {};
  const result = new Promise<Worktree>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  (async () => {
    try {
      const res = await fetch(`${BASE}/projects/${projectId}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let message = `Failed to create worktree (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) message = j.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let createdWorktree: Worktree | null = null;
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6);
            try {
              const event = JSON.parse(json) as WorktreeCreateEvent;
              push(event);
              if (event.type === "worktree_created") {
                createdWorktree = event.worktree;
              } else if (event.type === "done") {
                if (event.worktree) createdWorktree = event.worktree;
                if (createdWorktree) resolveResult(createdWorktree);
                else rejectResult(new Error("worktree creation finished without record"));
              } else if (event.type === "error" && !createdWorktree) {
                rejectResult(new Error(event.text));
              }
            } catch {
              // ignore parse errors
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
      finish();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      rejectResult(e);
      finish(e);
    }
  })();

  const events: AsyncIterable<WorktreeCreateEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<WorktreeCreateEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            if (error) return Promise.reject(error);
            return Promise.resolve({ value: undefined as unknown as WorktreeCreateEvent, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  return {
    events,
    cancel: () => controller.abort(),
    result,
  };
}

/**
 * Stream a setup re-run for an existing worktree. Mirrors `createWorktree`'s
 * SSE shape so callers can render live output in the same dialog. The result
 * promise resolves with the updated Worktree record once the server emits
 * `done`.
 */
export function runWorktreeSetup(
  projectId: string,
  worktreeId: string
): {
  events: AsyncIterable<WorktreeSetupEvent>;
  cancel: () => void;
  result: Promise<Worktree>;
} {
  const controller = new AbortController();

  const queue: WorktreeSetupEvent[] = [];
  let resolveNext: ((v: IteratorResult<WorktreeSetupEvent>) => void) | null = null;
  let done = false;
  let error: Error | null = null;

  function push(event: WorktreeSetupEvent) {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: event, done: false });
    } else {
      queue.push(event);
    }
  }

  function finish(err?: Error) {
    done = true;
    if (err) error = err;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined as unknown as WorktreeSetupEvent, done: true });
    }
  }

  let resolveResult: (w: Worktree) => void = () => {};
  let rejectResult: (e: Error) => void = () => {};
  const result = new Promise<Worktree>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  (async () => {
    try {
      const res = await fetch(
        `${BASE}/projects/${projectId}/worktrees/${worktreeId}/run-setup`,
        {
          method: "POST",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        }
      );
      if (!res.ok || !res.body) {
        let message = `Failed to run setup (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) message = j.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastWorktree: Worktree | null = null;
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6);
            try {
              const event = JSON.parse(json) as WorktreeSetupEvent;
              push(event);
              if (event.type === "done") {
                if (event.worktree) {
                  lastWorktree = event.worktree;
                  resolveResult(event.worktree);
                } else {
                  rejectResult(new Error("setup finished without a worktree record"));
                }
              }
            } catch {
              // ignore parse errors
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
      if (!lastWorktree) {
        rejectResult(new Error("setup stream ended before completion"));
      }
      finish();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      rejectResult(e);
      finish(e);
    }
  })();

  const events: AsyncIterable<WorktreeSetupEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<WorktreeSetupEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            if (error) return Promise.reject(error);
            return Promise.resolve({ value: undefined as unknown as WorktreeSetupEvent, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  return {
    events,
    cancel: () => controller.abort(),
    result,
  };
}

// --- Keyboard shortcut bindings (issue #235) ---

export async function fetchShortcutBindings(): Promise<ShortcutBindings> {
  const res = await fetch(`${BASE}/shortcuts`);
  return res.json();
}

export async function saveShortcutBindings(
  overrides: Partial<ShortcutBindings>
): Promise<ShortcutBindings> {
  const res = await fetch(`${BASE}/shortcuts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides),
  });
  return res.json();
}

export async function resetShortcutBindings(): Promise<ShortcutBindings> {
  const res = await fetch(`${BASE}/shortcuts`, { method: "DELETE" });
  return res.json();
}

// --- Schedules (issue #303) ---
//
// Mirrors the server's `Schedule` / `ScheduleInput` shapes (server/lib/schedules.ts).
// The UI is a thin client over the existing REST surface: list, create, toggle
// enabled, delete, and inspect runs. Editing a trigger is intentionally out of
// scope — the server has no PUT route for it (issue #303 non-goals).

export type ScheduleSource = "user" | "agent";

export interface Schedule {
  id: string;
  projectId: string;
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";
  cron: string | null;
  timezone: string;
  runAt: string | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunSessionId: string | null;
  lastError: string | null;
  source: ScheduleSource;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
}

export interface ScheduleInput {
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";
  cron?: string | null;
  timezone?: string;
  runAt?: string | null;
  enabled?: boolean;
  source?: ScheduleSource;
  createdBy?: string | null;
}

export interface ScheduleRun {
  firedAt: string;
  sessionId: string | null;
  error: string | null;
}

/**
 * A schedule paired with its owning project's id and a label, so the
 * cross-project Schedules section can render a single list without the
 * caller having to track which project each row came from. The
 * `projectName` is denormalised at fetch time and is purely a display
 * hint; the `projectId` is the source of truth.
 */
export interface ScheduleWithProject extends Schedule {
  projectName: string;
}

/**
 * Result of a cross-project schedule fetch. `schedules` is what the
 * UI renders; `failedProjectIds` lists projects whose storage we
 * couldn't read this round, so the section can surface a non-fatal
 * "some projects failed to load" banner instead of silently
 * dropping them. Issue #303 P2 review: swallowing per-project
 * failures made the UI show "No schedules yet" while active
 * schedules were still around.
 */
export interface AllSchedulesResult {
  schedules: ScheduleWithProject[];
  failedProjectIds: string[];
}

function schedulePath(projectId: string, scheduleId?: string): string {
  const base = `${BASE}/projects/${projectId}/schedules`;
  return scheduleId ? `${base}/${scheduleId}` : base;
}

export async function fetchSchedules(
  projectId: string,
  includeDisabled = true
): Promise<Schedule[]> {
  const params = new URLSearchParams({ includeDisabled: String(includeDisabled) });
  const res = await fetch(`${schedulePath(projectId)}?${params}`);
  await throwIfNotOk(res, "Failed to fetch schedules");
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as Schedule[]) : [];
}

/**
 * Fetch every project's schedules in parallel and merge them into a
 * single list annotated with the owning project's display name.
 *
 * The server doesn't expose a `/api/schedules` cross-project endpoint
 * by design (issue #303 — the CLI is the source of truth for the data
 * model), so this is a client-side fan-out. It's the same shape every
 * per-project page already uses, just collected in one place.
 *
 * Per-project failures are reported back via `failedProjectIds`
 * rather than swallowed: in a corrupt-store or transient 500 case,
 * the user should see "X projects failed to load" rather than an
 * incomplete list that looks healthy. Issue #303 P2 review.
 */
export async function fetchAllSchedules(
  includeDisabled = true
): Promise<AllSchedulesResult> {
  const projects = await fetchProjects();
  const settled = await Promise.all(
    projects.map(async (project) => {
      try {
        const schedules = await fetchSchedules(project.id, includeDisabled);
        return {
          ok: true as const,
          project,
          schedules: schedules.map((schedule) => ({
            ...schedule,
            projectName: project.name,
          })),
        };
      } catch (error) {
        return {
          ok: false as const,
          project,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const schedules: ScheduleWithProject[] = [];
  const failedProjectIds: string[] = [];
  for (const entry of settled) {
    if (entry.ok) {
      schedules.push(...entry.schedules);
    } else {
      failedProjectIds.push(entry.project.id);
    }
  }
  return { schedules, failedProjectIds };
}

export async function createSchedule(
  projectId: string,
  input: ScheduleInput
): Promise<Schedule> {
  const res = await fetch(schedulePath(projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res, "Failed to create schedule");
  return res.json();
}

export async function setScheduleEnabled(
  projectId: string,
  scheduleId: string,
  enabled: boolean
): Promise<Schedule> {
  const action = enabled ? "enable" : "disable";
  const res = await fetch(`${schedulePath(projectId, scheduleId)}/${action}`, {
    method: "POST",
  });
  await throwIfNotOk(res, `Failed to ${action} schedule`);
  return res.json();
}

export async function deleteSchedule(
  projectId: string,
  scheduleId: string
): Promise<void> {
  const res = await fetch(schedulePath(projectId, scheduleId), {
    method: "DELETE",
  });
  await throwIfNotOk(res, "Failed to delete schedule");
}

export async function fetchScheduleRuns(
  projectId: string,
  scheduleId: string
): Promise<ScheduleRun[]> {
  const res = await fetch(`${schedulePath(projectId, scheduleId)}/runs`);
  await throwIfNotOk(res, "Failed to fetch schedule runs");
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as ScheduleRun[]) : [];
}
