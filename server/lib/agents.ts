import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  attachments?: AgentAttachment[];
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  mode?: "default" | "plan";
}

export interface AgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  isImage: boolean;
}

export interface AgentProvider {
  id: string;
  name: string;
  command: string;
  spawn(opts: SpawnOptions): ChildProcess;
  parseEvent(line: string): AgentStreamEvent | AgentStreamEvent[] | null;
  createParser?(): (line: string) => AgentStreamEvent | AgentStreamEvent[] | null;
}

export type AgentStreamParseResult = AgentStreamEvent | AgentStreamEvent[] | null;

function normalizeToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (typeof raw.message === "string" && raw.message.trim()) return raw.message;
    if (typeof raw.error === "string" && raw.error.trim()) return raw.error;
    if (typeof raw.additionalDetails === "string" && raw.additionalDetails.trim()) {
      return raw.additionalDetails;
    }
  }
  if (value != null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Ada provider
// ---------------------------------------------------------------------------

interface AdaParserState {
  sessionId: string;
  // Current assistant text / reasoning segment being assembled from
  // token-level deltas. Emitted as a single `assistant.text` /
  // `assistant.reasoning` event the next time a non-delta event arrives
  // (or when the run completes) so the rest of the system — and the
  // UI — only ever sees the normalized full-event types.
  textSegment: string;
  reasoningSegment: string;
  // Per-index accumulator for `tool.call.delta` `inputDelta` strings.
  // Used as a fallback if a downstream `tool.call` event arrives without
  // the final structured `input` field.
  toolCallInputs: Map<number, string>;
}

function createAdaParserState(): AdaParserState {
  return {
    sessionId: "",
    textSegment: "",
    reasoningSegment: "",
    toolCallInputs: new Map(),
  };
}

/**
 * Drain any in-progress text / reasoning segment accumulators into
 * standalone full events, in the order the segments were started
 * (reasoning first, then text). The caller decides what to do with
 * the returned events (e.g. prepend them to the current batch).
 */
function flushAdaAccumulatedSegments(
  state: AdaParserState
): AgentStreamEvent[] {
  const out: AgentStreamEvent[] = [];
  if (state.reasoningSegment) {
    out.push({ type: "assistant.reasoning", text: state.reasoningSegment });
    state.reasoningSegment = "";
  }
  if (state.textSegment) {
    out.push({ type: "assistant.text", text: state.textSegment });
    state.textSegment = "";
  }
  return out;
}

/**
 * Reset segment accumulators and any per-index tool call deltas. Called
 * at the start of every new run so a resumed session doesn't bleed
 * stale text into the new turn.
 */
function resetAdaParserState(state: AdaParserState): void {
  state.textSegment = "";
  state.reasoningSegment = "";
  state.toolCallInputs.clear();
}

/**
 * Map a single raw Ada stream event (one JSONL line) to the
 * normalized `AgentStreamEvent` shape. Returns `null` for events that
 * should be dropped, an array when the line produces multiple
 * normalized events (e.g. flushing a text segment before a tool call),
 * or a single event otherwise.
 */
function mapAdaEvent(
  raw: Record<string, unknown>,
  state: AdaParserState
): AgentStreamEvent | AgentStreamEvent[] | null {
  const type = raw.type as string | undefined;
  if (!type) return null;

  if (type === "run.started") {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
    state.sessionId = sessionId;
    resetAdaParserState(state);
    return {
      type: "run.started",
      sessionId,
      model: typeof raw.model === "string" ? raw.model : "",
      workingDirectory:
        typeof raw.workingDirectory === "string" ? raw.workingDirectory : "",
      timestamp:
        typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    };
  }

  if (type === "assistant.text.delta") {
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!text) return null;
    state.textSegment += text;
    return null;
  }

  if (type === "assistant.reasoning.delta") {
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!text) return null;
    state.reasoningSegment += text;
    return null;
  }

  if (type === "tool.call.delta") {
    const index = typeof raw.index === "number" ? raw.index : 0;
    const inputDelta = typeof raw.inputDelta === "string" ? raw.inputDelta : "";
    if (inputDelta) {
      state.toolCallInputs.set(index, (state.toolCallInputs.get(index) ?? "") + inputDelta);
    }
    return null;
  }

  if (type === "tool.call") {
    // Flush any pending prose so it renders before the tool call in
    // the live transcript.
    const flushed = flushAdaAccumulatedSegments(state);
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    const inputRaw = raw.input;
    let input: Record<string, unknown> =
      inputRaw && typeof inputRaw === "object" && !Array.isArray(inputRaw)
        ? (inputRaw as Record<string, unknown>)
        : {};

    if (Object.keys(input).length === 0) {
      // Fall back to the accumulated `inputDelta` strings. Ada emits
      // them as JSON fragments that concatenate into a valid JSON
      // document; if they don't parse, keep the empty object so the
      // UI at least sees the tool name and id.
      const index = typeof raw.index === "number" ? raw.index : 0;
      const deltaString = state.toolCallInputs.get(index);
      if (deltaString) {
        try {
          const parsed = JSON.parse(deltaString);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // leave `input` empty; client will still see id + name
        }
      }
      state.toolCallInputs.delete(index);
    }

    const event: AgentStreamEvent = { type: "tool.call", id, name, input };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "tool.result") {
    // Tool results can follow a tool call, but they can also follow a
    // short text or reasoning segment — flush those first so the
    // transcript order matches the model's emission order.
    const flushed = flushAdaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "tool.result",
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : "",
      content: normalizeToolResultContent(raw.content),
      isError: raw.isError === true,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "run.completed" || type === "run.failed") {
    // Final flush — anything still being accumulated belongs in the
    // transcript before the run terminates.
    const flushed = flushAdaAccumulatedSegments(state);
    state.toolCallInputs.clear();
    const sessionId =
      typeof raw.sessionId === "string" && raw.sessionId
        ? raw.sessionId
        : state.sessionId;
    if (type === "run.completed") {
      const event: AgentStreamEvent = {
        type: "run.completed",
        sessionId,
        status: raw.status === "max_iterations" ? "max_iterations" : "completed",
        stopReason: typeof raw.stopReason === "string" ? raw.stopReason : "completed",
        timestamp:
          typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
      };
      return flushed.length > 0 ? [...flushed, event] : event;
    }
    const event: AgentStreamEvent = {
      type: "run.failed",
      sessionId,
      error: normalizeErrorMessage(raw.error, "Ada run failed"),
      timestamp:
        typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "plan.updated") {
    const flushed = flushAdaAccumulatedSegments(state);
    const plan = Array.isArray(raw.plan)
      ? (raw.plan
          .map((step) => normalizePlanStep(step))
          .filter((step): step is AgentPlanStep => step !== null))
      : [];
    const event: AgentStreamEvent = {
      type: "plan.updated",
      explanation:
        typeof raw.explanation === "string" || raw.explanation === null
          ? (raw.explanation as string | null)
          : null,
      plan,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "plan.delta") {
    const flushed = flushAdaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "plan.delta",
      id: typeof raw.id === "string" ? raw.id : "",
      delta: typeof raw.delta === "string" ? raw.delta : "",
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "user.input_requested") {
    const flushed = flushAdaAccumulatedSegments(state);
    const questions = Array.isArray(raw.questions)
      ? (raw.questions
          .map((question) => normalizeUserInputQuestion(question))
          .filter((question): question is AgentUserInputQuestion => question !== null))
      : [];
    const event: AgentStreamEvent = {
      type: "user.input_requested",
      id: typeof raw.id === "string" ? raw.id : "",
      questions,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "thread.status") {
    const flushed = flushAdaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "thread.status",
      threadId: typeof raw.threadId === "string" ? raw.threadId : "",
      status: typeof raw.status === "string" ? raw.status : "",
      activeFlags: Array.isArray(raw.activeFlags)
        ? (raw.activeFlags.filter((flag): flag is string => typeof flag === "string"))
        : undefined,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  // Unknown event shape — drop it. The previous implementation cast
  // unknown shapes to `AgentStreamEvent`, which let Ada's delta events
  // leak into the SSE stream and reach a client that didn't know how
  // to handle them.
  return null;
}

const adaProvider: AgentProvider = {
  id: "ada",
  name: "Ada",
  command: "ada",

  spawn({ message, cwd, env, attachments = [], resumeSessionId, model, reasoningEffort, serviceTier }) {
    const cmdArgs = ["--stream-json", "--auto-approve", "--model", model || ""];
    if (reasoningEffort) {
      cmdArgs.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (serviceTier === "fast") {
      cmdArgs.push("-c", `service_tier="${serviceTier}"`);
    }

    const args = ["chat"];
    for (const attachment of attachments) {
      args.push("--attach", attachment.path);
    }
    args.push(message);
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const fullCmd = `ada ${[...cmdArgs, ...args].join(" ")}`;
    console.log(`[ada] ${fullCmd.slice(0, 100)}...`);

    return spawn("ada", [...cmdArgs, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  createParser() {
    const state = createAdaParserState();
    return (line: string): AgentStreamParseResult => {
      const raw = JSON.parse(line) as Record<string, unknown>;
      return mapAdaEvent(raw, state);
    };
  },

  parseEvent(line: string): AgentStreamParseResult {
    const state = createAdaParserState();
    const raw = JSON.parse(line) as Record<string, unknown>;
    return mapAdaEvent(raw, state);
  },
};

// ---------------------------------------------------------------------------
// Codex provider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",
  command: "codex",

  spawn({ message, cwd, env, attachments = [], resumeSessionId, model, reasoningEffort, serviceTier, mode }) {
    // Flags must come before the prompt argument
    const flags = ["--json", "--full-auto", "--skip-git-repo-check", "--model", model || ""];
    if (reasoningEffort) {
      flags.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (serviceTier === "fast") {
      flags.push("-c", `service_tier="${serviceTier}"`);
    }
    if (mode === "plan") {
      flags.push("--enable", "default_mode_request_user_input");
    }

    const imageArgs = attachments
      .filter((attachment) => attachment.isImage)
      .flatMap((attachment) => ["--image", attachment.path]);
    const prompt = withAttachmentContext(message, attachments, "codex");

    let args: string[];
    if (resumeSessionId) {
      args = ["exec", ...flags, "resume", ...imageArgs, "--", resumeSessionId, prompt];
    } else {
      args = ["exec", ...flags, ...imageArgs, "--", prompt];
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

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

const CLAUDE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const claudeProvider: AgentProvider = {
  id: "claude",
  name: "Claude",
  command: "claude",

  spawn({ message, cwd, env, attachments = [], resumeSessionId, model, reasoningEffort, mode }) {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      mode === "plan" ? "plan" : "bypassPermissions",
    ];

    if (model) {
      args.push("--model", model);
    }
    if (reasoningEffort && CLAUDE_REASONING_EFFORTS.has(reasoningEffort)) {
      args.push("--effort", reasoningEffort);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    args.push(withAttachmentContext(message, attachments, "claude"));

    const fullCmd = `claude ${args.join(" ")}`;
    console.log(`[claude] ${fullCmd.slice(0, 100)}...`);

    return spawn("claude", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  },

  createParser() {
    const state = { sessionId: "", pausedForUserInput: false };
    return (line: string): AgentStreamParseResult => {
      const event = JSON.parse(line);
      return mapClaudeEvent(event, state);
    };
  },

  parseEvent(line: string): AgentStreamParseResult {
    const state = { sessionId: "", pausedForUserInput: false };
    const event = JSON.parse(line);
    return mapClaudeEvent(event, state);
  },
};

function withAttachmentContext(
  message: string,
  attachments: AgentAttachment[],
  provider: "codex" | "claude"
): string {
  if (attachments.length === 0) return message;
  const lines = attachments.map((attachment, index) => {
    const note =
      provider === "codex" && attachment.isImage
        ? "also attached through --image"
        : "available as a local file";
    return `${index + 1}. ${attachment.name} (${attachment.mimeType || "application/octet-stream"}, ${attachment.size} bytes): ${attachment.path} - ${note}`;
  });
  return `${message}\n\nAttached files:\n${lines.join("\n")}`;
}

function mapClaudeEvent(
  event: Record<string, unknown>,
  state: { sessionId: string; pausedForUserInput: boolean }
): AgentStreamEvent | AgentStreamEvent[] | null {
  const sessionId = (event.session_id as string | undefined) ?? state.sessionId;
  if (sessionId) {
    state.sessionId = sessionId;
  }

  if (state.pausedForUserInput) {
    return null;
  }

  const type = event.type as string | undefined;
  const subtype = event.subtype as string | undefined;

  if (type === "system" && subtype === "init") {
    return {
      type: "run.started",
      sessionId: state.sessionId,
      model: (event.model as string | undefined) ?? "",
      workingDirectory: (event.cwd as string | undefined) ?? "",
      timestamp: new Date().toISOString(),
    };
  }

  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: AgentStreamEvent[] = [];
    for (const part of content) {
      events.push(...mapClaudeContentPartToEvents(part));
    }
    if (events.some((normalized) => normalized.type === "user.input_requested")) {
      state.pausedForUserInput = true;
    }
    if (events.length === 1) return events[0];
    if (events.length > 1) return events;
  }

  if (type === "user") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const normalized = mapClaudeToolResultPart(part);
      if (normalized) return normalized;
    }
  }

  if (type === "result") {
    const isError = event.is_error === true || (typeof subtype === "string" && subtype.startsWith("error"));
    if (isError) {
      return {
        type: "run.failed",
        sessionId: state.sessionId,
        error: normalizeErrorMessage(
          event.error ?? event.result ?? subtype,
          "Claude run failed"
        ),
        timestamp: new Date().toISOString(),
      };
    }

    return {
      type: "run.completed",
      sessionId: state.sessionId,
      status: "completed",
      stopReason: subtype ?? "completed",
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

function mapClaudeContentPart(part: unknown): AgentStreamEvent | null {
  if (!part || typeof part !== "object") return null;
  const raw = part as Record<string, unknown>;
  const type = raw.type as string | undefined;

  if (type === "text") {
    const text = raw.text as string | undefined;
    if (
      text &&
      (/^Plan is saved at .*retry exiting plan mode\.$/s.test(text.trim()) ||
        /^The user dismissed the questions\./.test(text.trim()))
    ) {
      return null;
    }
    return text ? { type: "assistant.text", text } : null;
  }

  if (type === "thinking") {
    const text =
      (raw.thinking as string | undefined) ??
      (raw.text as string | undefined);
    return text ? { type: "assistant.reasoning", text } : null;
  }

  if (type === "tool_use") {
    const name = (raw.name as string | undefined) ?? "tool_use";
    const input = (raw.input as Record<string, unknown> | undefined) ?? {};

    if (name === "AskUserQuestion") {
      const questions = Array.isArray(input.questions)
        ? input.questions
            .map((question, index) => normalizeClaudeUserInputQuestion(question, index))
            .filter((question): question is AgentUserInputQuestion => question !== null)
        : [];
      if (questions.length > 0) {
        return {
          type: "user.input_requested",
          id: (raw.id as string | undefined) ?? "",
          questions,
        };
      }
    }

    return {
      type: "tool.call",
      id: (raw.id as string | undefined) ?? "",
      name,
      input,
    };
  }

  return null;
}

function mapClaudeContentPartToEvents(part: unknown): AgentStreamEvent[] {
  if (!part || typeof part !== "object") return [];
  const raw = part as Record<string, unknown>;
  if (raw.type === "tool_use" && raw.name === "ExitPlanMode") {
    const input = (raw.input as Record<string, unknown> | undefined) ?? {};
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    const events: AgentStreamEvent[] = [];
    if (plan) {
      events.push({ type: "assistant.text", text: plan });
    }
    events.push({
      type: "user.input_requested",
      id: (raw.id as string | undefined) ?? "",
      questions: [
        {
          id: "claude_exit_plan_mode",
          header: "Plan approval",
          question: "Implement this plan, or tell Claude what to do next.",
          options: [
            {
              label: "Implement this plan",
              description: "Resume Claude and ask it to proceed with this plan.",
            },
          ],
        },
      ],
    });
    return events;
  }

  const event = mapClaudeContentPart(part);
  return event ? [event] : [];
}

function mapClaudeToolResultPart(part: unknown): AgentStreamEvent | null {
  if (!part || typeof part !== "object") return null;
  const raw = part as Record<string, unknown>;
  if (raw.type !== "tool_result") return null;
  const content = normalizeToolResultContent(raw.content);
  if (
    raw.is_error === true &&
    (content.trim() === "Answer questions?" || content.trim() === "Exit plan mode?")
  ) {
    return null;
  }

  return {
    type: "tool.result",
    id: (raw.tool_use_id as string | undefined) ?? "",
    name: "tool_result",
    content,
    isError: raw.is_error === true,
  };
}

function normalizeClaudeUserInputQuestion(
  value: unknown,
  index: number
): AgentUserInputQuestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const question = raw.question as string | undefined;
  const header = (raw.header as string | undefined) ?? `Question ${index + 1}`;
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => normalizeClaudeUserInputOption(option))
        .filter((option): option is AgentUserInputOption => option !== null)
    : [];
  if (!question) return null;
  return {
    id: `question-${index}`,
    header,
    question,
    options,
  };
}

function normalizeClaudeUserInputOption(value: unknown): AgentUserInputOption | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label = raw.label as string | undefined;
  if (!label) return null;
  return {
    label,
    description: (raw.description as string | undefined) ?? "",
  };
}

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
    return {
      type: "run.failed",
      sessionId: state.threadId,
      error: normalizeErrorMessage(event.error ?? event.message, "Unknown error"),
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
  if (!id || !header || !question) return null;
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
  claude: claudeProvider,
};

export function getAgentProvider(id: string): AgentProvider | undefined {
  return providers[id];
}

export function getAgentProviders(): AgentProvider[] {
  return Object.values(providers);
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export async function getAvailableAgentProviders(): Promise<AgentProvider[]> {
  const availability = await Promise.all(
    Object.values(providers).map(async (provider) => ({
      provider,
      available: await isCommandAvailable(provider.command),
    }))
  );

  return availability
    .filter(({ available }) => available)
    .map(({ provider }) => provider);
}
