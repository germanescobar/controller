import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  resolveCommand,
  getCommandVersion,
} from "./command-resolver.js";
import { getAgentSetting, getAgentSettings } from "./agent-settings.js";
import { canonicalProviderId } from "./provider-id.js";
import { childProcessEnv } from "./shell-env.js";
import {
  DEFAULT_AUTO_APPROVE,
  anitaAutoApproveFlags,
  claudePermissionMode,
  codexExecAutoApproveFlags,
} from "./auto-approve.js";

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
 * A single permission update suggested by the Claude CLI alongside a
 * `can_use_tool` request (e.g. `addRules`, `setMode`, `addDirectories`). The
 * orchestrator never interprets these; it echoes the full set back as
 * `updatedPermissions` when the user picks "always allow", matching the CLI's
 * native behavior. Kept as an open record because the variants differ by type.
 */
export type ClaudePermissionSuggestion = Record<string, unknown>;

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
      // A tool the agent wants to run requires the user's approval before it
      // can proceed. Unlike `user.input_requested` (a turn boundary that is
      // answered by resuming a new process), an approval is answered live on
      // the still-running process via its control channel. `id` is the
      // provider's control-request id used to send the decision back.
      type: "tool.approval_requested";
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      // Provider-supplied permission updates that, when echoed back, stop the
      // user being prompted again for this tool ("always allow"). Shape is
      // provider-defined; passed through verbatim.
      suggestions: ClaudePermissionSuggestion[];
    }
  | {
      // A pending approval was settled by something other than the user's live
      // Allow/Deny decision (which is persisted directly by the `/tool-approval`
      // endpoint). Anita emits this around every approval gate; we only surface
      // the non-user reasons so the approval card clears and the transcript
      // records *why* it was denied (e.g. the parent closed stdin, or the run
      // was cancelled). `id` matches the originating `tool.approval_requested`.
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

export interface SpawnOptions {
  message: string;
  cwd: string;
  env: Record<string, string>;
  /** Resolved absolute path to the CLI executable. Falls back to the bare command name. */
  command?: string;
  attachments?: AgentAttachment[];
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  mode?: "default" | "plan";
  /**
   * Whether the agent should auto-approve the actions it would otherwise
   * prompt for. Defaults to on (autonomous). When false, the provider omits
   * its auto-approve flags so the agent asks for permission, and Controller
   * routes those prompts as approval cards. See `./auto-approve.ts`.
   */
  autoApprove?: boolean;
  /**
   * Stable identity/environment context to deliver as a real system message
   * instead of prepending it to the user message. Only honored by providers
   * whose CLI exposes a `--system-prompt` flag today (Anita). Other providers
   * continue to receive context via the prepended user message — see
   * `server/lib/agent-preamble.ts` for the per-provider wiring.
   */
  systemPrompt?: string;
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
  /**
   * Build a stateful per-run parser. `autoApprove` mirrors the spawn flag so a
   * provider can decide whether to surface manual-approval prompts: Anita emits
   * approval events in every mode (for a uniform audit trail), but they must
   * only render as cards when auto-approve is off. Providers that don't need it
   * ignore the argument.
   */
  createParser?(autoApprove?: boolean): (line: string) => AgentStreamEvent | AgentStreamEvent[] | null;
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
// Anita provider
// ---------------------------------------------------------------------------

interface AnitaParserState {
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
  // Whether this run was launched with auto-approve on. Anita emits
  // `approval.request` / `approval.resolved` in every mode for a uniform
  // audit trail; when auto-approve is on we drop them so the UI never shows
  // a card the user can't (and shouldn't have to) answer.
  autoApprove: boolean;
}

function createAnitaParserState(autoApprove: boolean): AnitaParserState {
  return {
    sessionId: "",
    textSegment: "",
    reasoningSegment: "",
    toolCallInputs: new Map(),
    autoApprove,
  };
}

/**
 * Drain any in-progress text / reasoning segment accumulators into
 * standalone full events, in the order the segments were started
 * (reasoning first, then text). The caller decides what to do with
 * the returned events (e.g. prepend them to the current batch).
 */
function flushAnitaAccumulatedSegments(
  state: AnitaParserState
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
function resetAnitaParserState(state: AnitaParserState): void {
  state.textSegment = "";
  state.reasoningSegment = "";
  state.toolCallInputs.clear();
}

/**
 * Map a single raw Anita stream event (one JSONL line) to the
 * normalized `AgentStreamEvent` shape. Returns `null` for events that
 * should be dropped, an array when the line produces multiple
 * normalized events (e.g. flushing a text segment before a tool call),
 * or a single event otherwise.
 */
function mapAnitaEvent(
  raw: Record<string, unknown>,
  state: AnitaParserState
): AgentStreamEvent | AgentStreamEvent[] | null {
  const type = raw.type as string | undefined;
  if (!type) return null;

  if (type === "run.started") {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
    state.sessionId = sessionId;
    resetAnitaParserState(state);
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
    const flushed = flushAnitaAccumulatedSegments(state);
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    const index = typeof raw.index === "number" ? raw.index : 0;
    const inputRaw = raw.input;
    let input: Record<string, unknown> =
      inputRaw && typeof inputRaw === "object" && !Array.isArray(inputRaw)
        ? (inputRaw as Record<string, unknown>)
        : {};

    if (Object.keys(input).length === 0) {
      // Fall back to the accumulated `inputDelta` strings. Anita emits
      // them as JSON fragments that concatenate into a valid JSON
      // document; if they don't parse, keep the empty object so the
      // UI at least sees the tool name and id.
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
    }

    // Always clear the consumed fragments for this index, regardless of
    // which path produced the final `input`. Otherwise a later tool
    // call that reuses the same `index` would either parse the stale
    // fragments on its own fallback path or, if it also emits
    // `tool.call.delta` fragments, concatenate them onto the stale
    // ones and corrupt the JSON.
    state.toolCallInputs.delete(index);

    const event: AgentStreamEvent = { type: "tool.call", id, name, input };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "tool.result") {
    // Tool results can follow a tool call, but they can also follow a
    // short text or reasoning segment — flush those first so the
    // transcript order matches the model's emission order.
    const flushed = flushAnitaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "tool.result",
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : "",
      content: normalizeToolResultContent(raw.content),
      isError: raw.isError === true,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") {
    // Final flush — anything still being accumulated belongs in the
    // transcript before the run terminates.
    const flushed = flushAnitaAccumulatedSegments(state);
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
    if (type === "run.cancelled") {
      // Clean cancellation: Anita emits this when SIGINT aborts the run
      // cooperatively (see coding-agent#66). The orchestrator surfaces
      // it as a non-error terminal event so the UI does not flash a
      // red "exited with code 130" banner on top of it.
      const event: AgentStreamEvent = {
        type: "run.cancelled",
        sessionId,
        reason:
          typeof raw.reason === "string" && raw.reason.trim()
            ? raw.reason
            : "user_interrupt",
        timestamp:
          typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
      };
      return flushed.length > 0 ? [...flushed, event] : event;
    }
    const event: AgentStreamEvent = {
      type: "run.failed",
      sessionId,
      error: normalizeErrorMessage(raw.error, "Anita run failed"),
      timestamp:
        typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "plan.updated") {
    const flushed = flushAnitaAccumulatedSegments(state);
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
    const flushed = flushAnitaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "plan.delta",
      id: typeof raw.id === "string" ? raw.id : "",
      delta: typeof raw.delta === "string" ? raw.delta : "",
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "user.input_requested") {
    const flushed = flushAnitaAccumulatedSegments(state);
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

  if (type === "approval.request") {
    // Anita emits an approval gate for every tool call, in every mode, so the
    // audit trail is uniform. Only render a card when auto-approve is off —
    // otherwise there is no live responder (stdin is closed) and the matching
    // `approval.resolved` lands immediately, so the card would only flash.
    if (state.autoApprove) return null;
    const flushed = flushAnitaAccumulatedSegments(state);
    const id = typeof raw.id === "string" ? raw.id : "";
    const inputRaw = raw.input;
    const input: Record<string, unknown> =
      inputRaw && typeof inputRaw === "object" && !Array.isArray(inputRaw)
        ? (inputRaw as Record<string, unknown>)
        : {};
    const event: AgentStreamEvent = {
      type: "tool.approval_requested",
      id,
      // Anita's approval id is the model's tool-call id, which is also the
      // `tool.call` / `tool.result` lifecycle id — reuse it for both.
      toolUseId: id,
      toolName: typeof raw.tool === "string" ? raw.tool : "tool",
      input,
      // Anita has no persisted "always allow" rule set to echo back.
      suggestions: [],
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "approval.resolved") {
    // Auto-approve mode resolves silently (audit-only). When auto-approve is
    // off, a `reason: "user"` resolution is the echo of the decision the user
    // already made through `/tool-approval` (persisted there as
    // `tool_approval_response`), so dropping it avoids a duplicate transcript
    // entry. Only the non-user reasons need surfacing: they settle the pending
    // card and record why it was denied without the user clicking anything.
    const reason = raw.reason;
    if (
      state.autoApprove ||
      reason === "user" ||
      (reason !== "aborted" && reason !== "eof" && reason !== "error")
    ) {
      return null;
    }
    const flushed = flushAnitaAccumulatedSegments(state);
    const event: AgentStreamEvent = {
      type: "tool.approval_resolved",
      id: typeof raw.id === "string" ? raw.id : "",
      approved: raw.approved === true,
      reason,
    };
    return flushed.length > 0 ? [...flushed, event] : event;
  }

  if (type === "thread.status") {
    const flushed = flushAnitaAccumulatedSegments(state);
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
  // unknown shapes to `AgentStreamEvent`, which let Anita's delta events
  // leak into the SSE stream and reach a client that didn't know how
  // to handle them.
  return null;
}

const anitaProvider: AgentProvider = {
  id: "anita",
  name: "Anita",
  command: "anita",

  spawn({ message, cwd, env, command, attachments = [], resumeSessionId, model, reasoningEffort, serviceTier, systemPrompt, autoApprove = DEFAULT_AUTO_APPROVE }) {
    const cmdArgs = ["--stream-json", ...anitaAutoApproveFlags(autoApprove)];
    // Only emit `--model` when the caller actually supplied a value. The
    // anita CLI rejects empty model strings with "Invalid model format"
    // before any `run.started` event lands (issue #213); omit the flag
    // so anita can pick its own default.
    if (model && model.trim()) {
      cmdArgs.push("--model", model);
    }
    if (reasoningEffort) {
      cmdArgs.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (serviceTier === "fast") {
      cmdArgs.push("-c", `service_tier="${serviceTier}"`);
    }
    // Deliver stable identity/environment context (e.g. the Controller
    // preamble) as a real system message so it never reaches the chat
    // transcript. Anita labels it `Additional system prompt from
    // --system-prompt:` in its system prompt section. Flags must come
    // before the `chat` subcommand.
    if (systemPrompt && systemPrompt.trim()) {
      cmdArgs.push("--system-prompt", systemPrompt);
    }

    const args = ["chat"];
    for (const attachment of attachments) {
      args.push("--attach", attachment.path);
    }
    args.push(message);
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const fullCmd = `anita ${[...cmdArgs, ...args].join(" ")}`;
    console.log(`[anita] ${fullCmd.slice(0, 100)}...`);

    return spawn(command ?? "anita", [...cmdArgs, ...args], {
      cwd,
      env: childProcessEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  createParser(autoApprove = DEFAULT_AUTO_APPROVE) {
    const state = createAnitaParserState(autoApprove);
    return (line: string): AgentStreamParseResult => {
      const raw = JSON.parse(line) as Record<string, unknown>;
      return mapAnitaEvent(raw, state);
    };
  },

  parseEvent(line: string): AgentStreamParseResult {
    // Stateless one-shot reparse (e.g. replaying a persisted line). It has no
    // run context, so default to auto-approve on — the same default the
    // launcher uses — which keeps the audit-only approval events suppressed.
    const state = createAnitaParserState(DEFAULT_AUTO_APPROVE);
    const raw = JSON.parse(line) as Record<string, unknown>;
    return mapAnitaEvent(raw, state);
  },
};

// ---------------------------------------------------------------------------
// Codex provider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",
  command: "codex",

  spawn({ message, cwd, env, command, attachments = [], resumeSessionId, model, reasoningEffort, serviceTier, mode, autoApprove = DEFAULT_AUTO_APPROVE }) {
    // Flags must come before the prompt argument. Same belt-and-suspenders
    // guard as the anita provider: only emit `--model` when the caller
    // supplied a non-empty value (issue #213). Codex is more permissive
    // than anita with empty model strings, but emitting `--model ""`
    // still risks it picking a default the user didn't intend.
    const flags = ["--json", ...codexExecAutoApproveFlags(autoApprove), "--skip-git-repo-check"];
    if (model && model.trim()) {
      flags.push("--model", model);
    }
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

    return spawn(command ?? "codex", args, {
      cwd,
      env: childProcessEnv(env),
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

  spawn({ message, cwd, env, command, attachments = [], resumeSessionId, model, reasoningEffort, mode, autoApprove = DEFAULT_AUTO_APPROVE }) {
    const planMode = mode === "plan";
    const prompt = withAttachmentContext(message, attachments, "claude");
    // The CLI must route `can_use_tool` requests to us — over the stream-json
    // control channel — whenever the user should see approval prompts. That is
    // true in plan mode (interactive approval loop) and whenever auto-approve
    // is off (manual approval for every action).
    const usesControlChannel = planMode || !autoApprove;

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      // Plan mode drives an interactive approval loop, so it cannot bypass
      // permissions. Otherwise the mode follows the auto-approve setting:
      // `bypassPermissions` runs fully autonomously, `default` makes the CLI
      // ask before every action.
      planMode ? "plan" : claudePermissionMode(autoApprove),
      // Turn off Claude Code's built-in slash commands so the orchestrator
      // is the only path. The orchestrator's skill catalog is the single
      // source of truth for `/<name>` invocations; the CLI's `/help`,
      // `/clear`, and any marketplace-installed plugin skills are out of
      // scope for v1 (see issue #98).
      "--disable-slash-commands",
    ];

    if (usesControlChannel) {
      // Stream prompts and permission decisions over stdin/stdout so the CLI
      // routes `can_use_tool` requests to us (the `stdio` sentinel) instead of
      // silently denying them — the root cause of plan-mode tool failures, and
      // the channel that carries manual approvals when auto-approve is off.
      args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");
    }

    if (model) {
      args.push("--model", model);
    }
    if (reasoningEffort && CLAUDE_REASONING_EFFORTS.has(reasoningEffort)) {
      args.push("--effort", reasoningEffort);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    // Control-channel turns send the prompt over stream-json stdin after the
    // initialize handshake; otherwise the prompt is a plain argv argument.
    if (!usesControlChannel) {
      args.push(prompt);
    }

    const fullCmd = `claude ${args.join(" ")}`;
    console.log(`[claude] ${fullCmd.slice(0, 100)}...`);

    const child = spawn(command ?? "claude", args, {
      cwd,
      env: childProcessEnv(env),
      // Control-channel turns keep stdin open for the live approval channel;
      // fully autonomous turns never read stdin (the caller ends it).
      stdio: [usesControlChannel ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (usesControlChannel) {
      writeClaudeControlLine(child, {
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "initialize", hooks: {} },
      });
      writeClaudeControlLine(child, {
        type: "user",
        message: { role: "user", content: prompt },
      });
    }

    return child;
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

/** A user's decision on a Claude tool-approval prompt. */
export type ClaudeApprovalDecision = "allow_once" | "always_allow" | "deny";

/** The persisted details of a pending approval, needed to answer it later. */
export interface ClaudeApprovalRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: ClaudePermissionSuggestion[];
}

/**
 * Write one newline-delimited JSON message to a Claude streaming child's stdin.
 * The CLI's control protocol is line-based; no-ops if stdin is gone.
 */
function writeClaudeControlLine(
  child: ChildProcess,
  message: Record<string, unknown>
): void {
  if (!child.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * Answer a pending Claude `can_use_tool` request on the live process. Maps the
 * user's decision onto the CLI's PermissionResult shape and writes the
 * control_response to stdin. Returns false if the process is no longer writable.
 */
export function sendClaudeApprovalDecision(
  child: ChildProcess,
  request: ClaudeApprovalRequest,
  decision: ClaudeApprovalDecision
): boolean {
  if (!child.stdin?.writable) return false;
  writeClaudeControlLine(child, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.requestId,
      response: buildClaudeApprovalResponse(request, decision),
    },
  });
  return true;
}

/**
 * Answer a pending Anita approval on the live process. Anita's `--stream-json`
 * responder reads newline-delimited `approval.response` lines from stdin and
 * matches them to the in-flight request by `id` (the tool-call id carried in
 * `approval.request`). Anita has no "always allow" concept, so both allow
 * decisions collapse to `approved: true`; only `deny` denies. Returns false if
 * the child's stdin is no longer writable.
 */
export function sendAnitaApprovalDecision(
  child: ChildProcess,
  requestId: string,
  decision: ClaudeApprovalDecision
): boolean {
  if (!child.stdin?.writable) return false;
  child.stdin.write(
    `${JSON.stringify({
      type: "approval.response",
      id: requestId,
      approved: decision !== "deny",
    })}\n`
  );
  return true;
}

/**
 * Inject the session-scoped `destination` Claude expects on every
 * `permissionUpdates` entry. Claude emits `permission_suggestions` without
 * `destination`; the control-protocol Zod schema rejects entries that omit
 * it ("Dropping malformed permissionUpdate entry"), so we default to
 * `"session"` to match the runtime scope the user is approving for.
 */
function withSessionDestination(
  entries: ClaudePermissionSuggestion[]
): Record<string, unknown>[] {
  return entries.map((entry) => ({
    ...entry,
    destination: entry.destination ?? "session",
  }));
}

function buildClaudeApprovalResponse(
  request: ClaudeApprovalRequest,
  decision: ClaudeApprovalDecision
): Record<string, unknown> {
  if (decision === "deny") {
    return {
      behavior: "deny",
      message:
        request.toolName === "ExitPlanMode"
          ? "Stay in plan mode and revise the plan before implementing. Ask any follow-up questions you need."
          : "The user denied permission to use this tool.",
    };
  }

  // Approving ExitPlanMode must also switch the session out of plan mode so the
  // CLI proceeds with implementation in the same turn; otherwise the turn ends
  // still in plan mode (verified against the CLI's control protocol).
  //
  // The wrapping field is `permissionUpdates` (camelCase). Claude's
  // permission-update schema requires every entry to carry both `behavior` and
  // `destination`; the inner `setMode` entry here already includes both, so
  // it goes through unmodified.
  if (request.toolName === "ExitPlanMode") {
    return {
      behavior: "allow",
      updatedInput: request.input,
      permissionUpdates: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    };
  }

  // The wrapping field is `permissionUpdates` (camelCase, matching Claude's
  // control-protocol schema). Claude sends the suggestions without
  // `destination`, but the schema requires it; `withSessionDestination` fills
  // it in so each entry parses cleanly and the rule is actually persisted.
  // Without this fix the response is dropped as malformed, the rule never
  // lands, and the run never emits a terminal event — the agent appears to
  // "keep working" until the inactivity watchdog kills it 5 minutes later.
  if (decision === "always_allow") {
    return {
      behavior: "allow",
      updatedInput: request.input,
      permissionUpdates: withSessionDestination(request.suggestions),
    };
  }

  return { behavior: "allow", updatedInput: request.input };
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

  if (type === "control_request") {
    const request = event.request as Record<string, unknown> | undefined;
    if (request?.subtype === "can_use_tool") {
      // AskUserQuestion is a clarification prompt, not a permission gate. The
      // CLI surfaces it through `can_use_tool` too, but the same assistant turn
      // already emitted it as a `tool_use` block that we map to a structured
      // `user.input_requested` (which also pauses the run). Map it to a generic
      // Allow/Deny approval and the user would lose the question UI. Drop it
      // explicitly so the structured-input path is the only one — independent
      // of the order the two events happen to arrive in.
      if (request.tool_name === "AskUserQuestion") return null;
      const requestId = (event.request_id as string | undefined) ?? "";
      if (!requestId) return null;
      const suggestions = Array.isArray(request.permission_suggestions)
        ? (request.permission_suggestions as ClaudePermissionSuggestion[])
        : [];
      return {
        type: "tool.approval_requested",
        id: requestId,
        toolUseId: (request.tool_use_id as string | undefined) ?? "",
        toolName: (request.tool_name as string | undefined) ?? "tool",
        input: (request.input as Record<string, unknown> | undefined) ?? {},
        suggestions,
      };
    }
    return null;
  }

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
    // Surface the plan text only. Approval is driven by the CLI's
    // `can_use_tool` request for ExitPlanMode, which arrives over the control
    // channel and is mapped to a `tool.approval_requested` event.
    const input = (raw.input as Record<string, unknown> | undefined) ?? {};
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    return plan ? [{ type: "assistant.text", text: plan }] : [];
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
  anita: anitaProvider,
  codex: codexProvider,
  claude: claudeProvider,
};

export function getAgentProvider(id: string): AgentProvider | undefined {
  return providers[canonicalProviderId(id)];
}

export function getAgentProviders(): AgentProvider[] {
  return Object.values(providers);
}

export interface AgentStatus {
  id: string;
  name: string;
  /** The CLI resolves on PATH (or via an explicit path override). */
  installed: boolean;
  /** The user has enabled this agent in Settings. */
  enabled: boolean;
  /** Absolute path the CLI resolved to, or null when not installed. */
  resolvedPath: string | null;
  /** Best-effort `--version` output, or null. */
  version: string | null;
  /** Default model id pre-selected for new sessions, or null. */
  defaultModel: string | null;
  /** Whether the agent auto-approves actions (on) or asks for them (off). */
  autoApprove: boolean;
}

/**
 * Resolve an agent's CLI to an absolute executable path, honoring an explicit
 * path override from settings. Throws an actionable error when it can't be
 * found so the caller can surface it to the user.
 */
export async function resolveAgentCommand(agentId: string): Promise<string> {
  const provider = providers[agentId];
  if (!provider) {
    throw new Error(`Unknown agent provider: ${agentId}`);
  }
  const setting = await getAgentSetting(agentId);
  const resolved = resolveCommand(provider.command, setting.path);
  if (!resolved) {
    throw new Error(
      `${provider.name} CLI ("${provider.command}") was not found on PATH. ` +
        `Set its path in Settings → Agents, or install it.`
    );
  }
  return resolved;
}

/** Install + enable status for every registered agent. */
export async function getAgentStatuses(): Promise<AgentStatus[]> {
  const settings = await getAgentSettings();
  return Promise.all(
    Object.values(providers).map(async (provider) => {
      const setting = settings[provider.id] ?? {
        enabled: true,
        path: null,
        defaultModel: null,
        autoApprove: DEFAULT_AUTO_APPROVE,
      };
      const resolvedPath = resolveCommand(provider.command, setting.path);
      const installed = resolvedPath !== null;
      const version = installed ? await getCommandVersion(resolvedPath) : null;
      return {
        id: provider.id,
        name: provider.name,
        installed,
        enabled: setting.enabled,
        resolvedPath,
        version,
        defaultModel: setting.defaultModel,
        autoApprove: setting.autoApprove,
      };
    })
  );
}

/** Providers that are both installed and enabled — the ones a user can run. */
export async function getAvailableAgentProviders(): Promise<AgentProvider[]> {
  const statuses = await getAgentStatuses();
  const availableIds = new Set(
    statuses.filter((status) => status.installed && status.enabled).map((status) => status.id)
  );
  return Object.values(providers).filter((provider) => availableIds.has(provider.id));
}
