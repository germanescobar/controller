const BASE = "/api";

export interface Project {
  id: string;
  name: string;
  path: string;
  setupCommands?: string;
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

export type AdaStreamEvent =
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
  | { type: "ada_event"; event: AdaStreamEvent }
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
  setupCommands?: string
): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path, setupCommands }),
  });
  return res.json();
}

export async function updateProject(
  id: string,
  patch: { name?: string; setupCommands?: string }
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
): Promise<Session[]> {
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
  worktreeId?: string
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/steer${withWorktree(worktreeId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to steer session");
  }
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

export type QueuedMessageInput = Omit<QueuedMessage, "id" | "createdAt">;

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

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  hint: string | null;
}

export interface AgentProviderInfo {
  id: string;
  name: string;
}

export async function fetchAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await fetch(`${BASE}/agent-providers`);
  return res.json();
}

export type SkillScope = "user" | "system" | "repo";

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

export interface AgentStatus {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  resolvedPath: string | null;
  version: string | null;
}

export async function fetchAgents(): Promise<AgentStatus[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function updateAgent(
  agentId: string,
  patch: { enabled?: boolean; path?: string | null }
): Promise<AgentStatus> {
  const res = await fetch(`${BASE}/agents/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
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

export async function setProviderKey(
  providerId: string,
  key: string
): Promise<void> {
  await fetch(`${BASE}/api-keys/${providerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await fetch(`${BASE}/api-keys/${providerId}`, { method: "DELETE" });
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
  if (options?.skillName) params.set("skillName", options.skillName);
  return new EventSource(
    `${BASE}/projects/${projectId}/sessions/stream?${params}`
  );
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
  return Array.isArray(body.entries) ? (body.entries as SourceDirectoryEntry[]) : [];
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
