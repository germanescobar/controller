import { spawn, type ChildProcess } from "node:child_process";

export interface AgentPlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentUserInputOption {
  label: string;
  description: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: AgentUserInputOption[];
}

/**
 * Normalized stream event format used across all agent providers.
 * The UI only deals with these types.
 */
export type AgentStreamEvent =
  | {
      type: "run.started";
      sessionId: string;
      model: string;
      workingDirectory: string;
      timestamp: string;
    }
  | { type: "assistant.text"; text: string }
  | { type: "assistant.reasoning"; text: string }
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
      plan: AgentPlanStep[];
    }
  | {
      type: "plan.delta";
      id: string;
      delta: string;
    }
  | {
      type: "user.input_requested";
      id: string;
      questions: AgentUserInputQuestion[];
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

export interface SpawnOptions {
  message: string;
  cwd: string;
  env: Record<string, string>;
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  mode?: "default" | "plan";
}

export interface AgentProvider {
  id: string;
  name: string;
  spawn(opts: SpawnOptions): ChildProcess;
  parseEvent(line: string): AgentStreamEvent | null;
  createParser?(): (line: string) => AgentStreamEvent | null;
}

function normalizeToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Ada provider
// ---------------------------------------------------------------------------

const adaProvider: AgentProvider = {
  id: "ada",
  name: "Ada",

  spawn({ message, cwd, env, resumeSessionId, model, reasoningEffort, serviceTier }) {
    const cmdArgs = ["--stream-json", "--auto-approve", "--model", model || ""];
    if (reasoningEffort) {
      cmdArgs.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (serviceTier) {
      cmdArgs.push("-c", `service_tier="${serviceTier}"`);
    }

    const args = ["chat", message];
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const fullCmd = `ada ${[...cmdArgs, ...args].join(" ")}`;
    console.log(`[ada] ${fullCmd.slice(0, 100)}...`);

    return spawn("ada", [...cmdArgs, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  parseEvent(line: string): AgentStreamEvent | null {
    const event = JSON.parse(line);
    // Ada events already match our normalized format
    return event as AgentStreamEvent;
  },
};

// ---------------------------------------------------------------------------
// Codex provider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",

  spawn({ message, cwd, env, resumeSessionId, model, reasoningEffort, serviceTier, mode }) {
    // Flags must come before the prompt argument
    const flags = ["--json", "--full-auto", "--skip-git-repo-check", "--model", model || ""];
    if (reasoningEffort) {
      flags.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (serviceTier) {
      flags.push("-c", `service_tier="${serviceTier}"`);
    }
    if (mode === "plan") {
      flags.push("--enable", "default_mode_request_user_input");
    }

    let args: string[];
    if (resumeSessionId) {
      args = ["exec", ...flags, "resume", resumeSessionId, message];
    } else {
      args = ["exec", ...flags, message];
    }

    const fullCmd = `codex ${args.join(" ")}`;
    console.log(`[codex] ${fullCmd.slice(0, 100)}...`);

    return spawn("codex", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  createParser() {
    const state = { threadId: "" };
    return (line: string): AgentStreamEvent | null => {
      const event = JSON.parse(line);
      return mapCodexEvent(event, state);
    };
  },

  parseEvent(line: string): AgentStreamEvent | null {
    const state = { threadId: "" };
    const event = JSON.parse(line);
    return mapCodexEvent(event, state);
  },
};

/**
 * Map a Codex JSONL event to our normalized AgentStreamEvent format.
 * Returns null for events we don't surface to the UI.
 */
function mapCodexEvent(event: Record<string, unknown>, state: { threadId: string }): AgentStreamEvent | null {
  const method = event.method as string | undefined;
  const params = event.params as Record<string, unknown> | undefined;
  if (method && params) {
    return mapCodexAppServerEvent(method, params, state);
  }

  const type = event.type as string;

  if (type === "thread.started") {
    state.threadId = event.thread_id as string;
    return {
      type: "run.started",
      sessionId: state.threadId,
      model: "",
      workingDirectory: "",
      timestamp: new Date().toISOString(),
    };
  }

  if (type === "item.completed" || type === "item.started") {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return null;

    const itemType = item.type as string;
    const itemId = (item.id as string) ?? "";

    // Agent message (assistant text)
    if (itemType === "agent_message" && type === "item.completed") {
      const text = (item.text as string) ?? "";
      if (!text) return null;
      return { type: "assistant.text", text };
    }

    // Reasoning
    if (itemType === "reasoning" && type === "item.completed") {
      const text =
        (item.text as string) ??
        (item.content as string) ??
        "";
      if (!text) return null;
      return { type: "assistant.reasoning", text };
    }

    // Command execution / tool calls
    if (
      itemType === "command_execution" ||
      itemType === "mcp_call" ||
      itemType === "file_change" ||
      itemType === "web_search"
    ) {
      if (type === "item.started") {
        const name =
          (item.tool as string) ??
          (item.command as string) ??
          itemType;
        const input =
          (item.input as Record<string, unknown>) ??
          (item.args as Record<string, unknown>) ??
          {};
        return { type: "tool.call", id: itemId, name, input };
      }

      if (type === "item.completed") {
        const name =
          (item.tool as string) ??
          (item.command as string) ??
          itemType;
        const rawContent =
          item.aggregated_output ??
          item.output ??
          item.content ??
          item.result ??
          item;
        const content = normalizeToolResultContent(rawContent);
        const isError = (item.exit_code as number) !== 0 && item.exit_code != null;
        return { type: "tool.result", id: itemId, name, content, isError };
      }
    }

    return null;
  }

  if (type === "turn.completed") {
    return {
      type: "run.completed",
      sessionId: state.threadId,
      status: "completed",
      stopReason: "completed",
      timestamp: new Date().toISOString(),
    };
  }

  if (type === "turn.failed" || type === "error") {
    const error =
      (event.error as string) ??
      (event.message as string) ??
      "Unknown error";
    return {
      type: "run.failed",
      sessionId: state.threadId,
      error,
      timestamp: new Date().toISOString(),
    };
  }

  // Ignore other event types (turn.started, etc.)
  return null;
}

function mapCodexAppServerEvent(
  method: string,
  params: Record<string, unknown>,
  state: { threadId: string }
): AgentStreamEvent | null {
  if (method === "thread/started") {
    const thread = params.thread as Record<string, unknown> | undefined;
    const threadId =
      (params.threadId as string | undefined) ??
      (thread?.id as string | undefined) ??
      "";
    if (!threadId) return null;
    state.threadId = threadId;
    return {
      type: "run.started",
      sessionId: threadId,
      model: "",
      workingDirectory: "",
      timestamp: new Date().toISOString(),
    };
  }

  if (method === "thread/status/changed") {
    const threadId = (params.threadId as string | undefined) ?? state.threadId;
    const status = getThreadStatusName(params.status);
    const activeFlags = getThreadActiveFlags(params.status);
    if (!threadId || !status) return null;
    return {
      type: "thread.status",
      threadId,
      status,
      activeFlags,
    };
  }

  if (method === "turn/plan/updated") {
    const plan = Array.isArray(params.plan)
      ? params.plan
          .map((item) => normalizePlanStep(item))
          .filter((item): item is AgentPlanStep => item !== null)
      : [];
    return {
      type: "plan.updated",
      explanation: (params.explanation as string | null | undefined) ?? null,
      plan,
    };
  }

  if (method === "item/plan/delta") {
    const itemId = (params.itemId as string | undefined) ?? "";
    const delta = (params.delta as string | undefined) ?? "";
    if (!itemId || !delta) return null;
    return {
      type: "plan.delta",
      id: itemId,
      delta,
    };
  }

  if (method === "item/tool/requestUserInput") {
    const itemId = (params.itemId as string | undefined) ?? "";
    const questions = Array.isArray(params.questions)
      ? params.questions
          .map((question) => normalizeUserInputQuestion(question))
          .filter((question): question is AgentUserInputQuestion => question !== null)
      : [];
    if (!itemId || questions.length === 0) return null;
    return {
      type: "user.input_requested",
      id: itemId,
      questions,
    };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return null;

    const itemType = item.type as string | undefined;
    const itemId = (item.id as string | undefined) ?? "";
    const isCompleted = method === "item/completed";

    if (itemType === "agentMessage" && isCompleted) {
      const text = (item.text as string | undefined) ?? "";
      if (!text) return null;
      return {
        type: "assistant.text",
        text,
      };
    }

    if (itemType === "reasoning" && isCompleted) {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === "string")
        : [];
      const content = Array.isArray(item.content)
        ? item.content.filter((part): part is string => typeof part === "string")
        : [];
      const text = [...summary, ...content].join("\n").trim();
      if (!text) return null;
      return {
        type: "assistant.reasoning",
        text,
      };
    }

    if (itemType === "plan" && isCompleted) {
      const text = (item.text as string | undefined) ?? "";
      if (!text) return null;
      return {
        type: "assistant.text",
        text,
      };
    }

    if (
      itemType === "commandExecution" ||
      itemType === "mcpToolCall" ||
      itemType === "fileChange" ||
      itemType === "webSearch" ||
      itemType === "dynamicToolCall"
    ) {
      if (!itemId) return null;

      const name =
        (item.tool as string | undefined) ??
        (item.command as string | undefined) ??
        itemType;

      if (!isCompleted) {
        const input: Record<string, unknown> =
          itemType === "fileChange"
            ? { changes: (item.changes as unknown[] | undefined) ?? [] }
            : (item.arguments as Record<string, unknown> | undefined) ??
              (item.commandActions as Record<string, unknown> | undefined) ??
              {};
        return {
          type: "tool.call",
          id: itemId,
          name,
          input,
        };
      }

      const rawContent =
        itemType === "fileChange"
          ? { changes: (item.changes as unknown[] | undefined) ?? [] }
          : item.aggregatedOutput ??
            item.result ??
            item.text ??
            item;
      const content = normalizeToolResultContent(rawContent);
      const status = item.status as string | undefined;
      const exitCode = item.exitCode as number | null | undefined;
      const isError =
        (typeof exitCode === "number" && exitCode !== 0) ||
        status === "failed" ||
        status === "error";

      return {
        type: "tool.result",
        id: itemId,
        name,
        content,
        isError,
      };
    }
  }

  if (method === "turn/completed") {
    const turn = params.turn as Record<string, unknown> | undefined;
    const status = turn?.status as string | undefined;
    if (status === "failed") {
      const error = turn?.error as Record<string, unknown> | undefined;
      const message =
        (error?.message as string | undefined) ??
        (error?.additionalDetails as string | undefined) ??
        "Codex turn failed";
      return {
        type: "run.failed",
        sessionId: (params.threadId as string | undefined) ?? state.threadId,
        error: message,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      type: "run.completed",
      sessionId: (params.threadId as string | undefined) ?? state.threadId,
      status: status === "interrupted" ? "max_iterations" : "completed",
      stopReason: status ?? "completed",
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

function normalizePlanStep(value: unknown): AgentPlanStep | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const step = raw.step as string | undefined;
  const status = normalizePlanStatus(raw.status as string | undefined);
  if (!step || !status) return null;
  return { step, status };
}

function normalizePlanStatus(
  status: string | undefined
): AgentPlanStep["status"] | null {
  if (!status) return null;
  if (status === "pending" || status === "completed") return status;
  if (status === "inProgress" || status === "in_progress") {
    return "in_progress";
  }
  return null;
}

function normalizeUserInputQuestion(
  value: unknown
): AgentUserInputQuestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = raw.id as string | undefined;
  const header = raw.header as string | undefined;
  const question = raw.question as string | undefined;
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => normalizeUserInputOption(option))
        .filter((option): option is AgentUserInputOption => option !== null)
    : [];
  if (!id || !header || !question || options.length === 0) return null;
  return { id, header, question, options };
}

function normalizeUserInputOption(
  value: unknown
): AgentUserInputOption | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label = raw.label as string | undefined;
  const description = raw.description as string | undefined;
  if (!label || !description) return null;
  return { label, description };
}

function getThreadStatusName(status: unknown): string | null {
  if (!status) return null;
  if (typeof status === "string") return status;
  if (typeof status === "object") {
    const raw = status as Record<string, unknown>;
    return (raw.type as string | undefined) ?? null;
  }
  return null;
}

function getThreadActiveFlags(status: unknown): string[] | undefined {
  if (!status || typeof status !== "object") return undefined;
  const raw = status as Record<string, unknown>;
  if (!Array.isArray(raw.activeFlags)) return undefined;
  return raw.activeFlags.filter(
    (flag): flag is string => typeof flag === "string"
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers: Record<string, AgentProvider> = {
  ada: adaProvider,
  codex: codexProvider,
};

export function getAgentProvider(id: string): AgentProvider | undefined {
  return providers[id];
}

export function getAgentProviders(): AgentProvider[] {
  return Object.values(providers);
}
