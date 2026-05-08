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

export type WorktreeCreateEvent =
  | { type: "started"; name: string; branch: string }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "worktree_created"; worktree: Worktree }
  | { type: "error"; text: string }
  | { type: "done"; exitCode: number; worktree?: Worktree };

export interface SessionRuntime {
  active: boolean;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
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
    };

export type SessionStreamEvent =
  | { type: "started" }
  | { type: "ada_event"; event: AdaStreamEvent }
  | { type: "stderr"; text: string }
  | { type: "done"; exitCode: number | null }
  | { type: "error"; text: string; raw?: string };

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  return res.json();
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
  return res.json();
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

export async function fetchEvents(
  projectId: string,
  sessionId: string,
  worktreeId?: string
): Promise<AgentEvent[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/events${withWorktree(worktreeId)}`
  );
  return res.json();
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

export async function submitSessionUserInput(
  projectId: string,
  sessionId: string,
  answers: Record<string, string | string[]>,
  worktreeId?: string
): Promise<void> {
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
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  size: string;
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
  return new EventSource(
    `${BASE}/projects/${projectId}/sessions/stream?${params}`
  );
}

export async function fetchBranches(
  projectId: string
): Promise<{ branches: string[]; head: string | null }> {
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
