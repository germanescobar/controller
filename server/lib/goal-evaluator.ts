import fs from "node:fs/promises";
import path from "node:path";
import {
  clearSessionGoal,
  readSessionGoal,
  writeSessionGoal,
  type SessionGoal,
} from "./goal-state.js";
import { getApiKeyEnvVars } from "./api-keys.js";
import { projectStoreDir } from "./paths.js";
import { listQueue, enqueue as enqueueMessage } from "./session-queue.js";
import {
  getEvents,
  appendEvent,
  type AgentEvent,
} from "./sessions.js";
import type { SessionState } from "./sessions.js";

/*
 * Goal evaluator (issue #339).
 *
 * The GoalEvaluator is the third wheel of the same-session, condition-
 * driven loop alongside `wake --delay` and the run-completion queue
 * drain. After every `run.completed` for a session with a goal, the
 * shared wakeup loop (issue #243) hands the session to this evaluator;
 * it reads the goal + the session's recent events, asks a small fast
 * model whether the condition is met, and either:
 *
 *   1. clears the goal (met, or cap exceeded), emitting `goal.cleared`;
 *   2. leaves the goal alone (the agent has already enqueued a follow-up
 *      that the queue pipeline will drain);
 *   3. enqueues a short follow-up on the agent's behalf when the
 *      condition isn't met AND the queue is empty — the safety net that
 *      distinguishes `/goal` from `/loop` (a sloppy agent can't decide
 *      the work is done by ending the turn quietly).
 *
 * The model is intentionally haiku-class: this is a cheap judgment on
 * a transcript excerpt, not the agent's actual work.
 */

const TRANSCRIPT_TAIL_EVENTS = 50;
/** Default follow-up prompt the evaluator enqueues when the goal isn't met. */
const DEFAULT_FOLLOW_UP_PROMPT =
  "Continue working toward the active goal. Re-read the goal condition and the latest transcript, take the next concrete step, and either re-set the goal if you have more work to do or call `controller sessions goal clear` if the condition is satisfied.";
const DEFAULT_MODEL = "anthropic/claude-3-haiku";
/** OpenRouter chat-completions endpoint; the orchestrator's providers
 *  include OpenRouter, so reusing it keeps the evaluator on a key the
 *  user has already configured. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface EvaluatorOutcome {
  /** Resulting goal state after this evaluation pass. */
  goal: SessionGoal | null;
  /** Whether the evaluator enqueued a follow-up turn. */
  enqueued: boolean;
  /** Reason string the evaluator recorded. */
  reason: string;
}

export interface GoalEvaluatorDeps {
  /** Returns the project id for a session id (the consumer-side lookup). */
  locateSession: (sessionId: string) => Promise<{
    projectId: string;
    worktreeId: string;
    worktreePath: string;
  } | null>;
  /**
   * Returns true when the session has an in-flight turn. The evaluator
   * skips judgment while a turn is active so a five-turn goal can't be
   * exhausted by repeated ticks of a single long run, and so an
   * OpenRouter call doesn't fire while the agent is still writing.
   * Defaults to "always idle" (test-only safe default).
   */
  isSessionActive?: (sessionId: string) => boolean;
  /**
   * Read the live session state. Used to (a) populate the continuation
   * message with the session's `provider`/`model` so a Codex goal
   * doesn't resume as Claude, and (b) bail out when the session is
   * archived so an archived session can't keep generating paid calls.
   * Optional; when omitted the evaluator falls back to Claude defaults
   * and never detects the archived case.
   */
  readSession?: (
    worktreePath: string,
    sessionId: string
  ) => Promise<SessionState | null>;
  /**
   * Trigger a queue advance after the evaluator enqueues a follow-up
   * turn (issue #339 review). When the queue was empty, the existing
   * triggers (`run.completed`, the wakes consumer) wouldn't fire the
   * newly queued message, so the goal loop would stall after its
   * first judgment. The injected dep keeps the `routes/sessions.ts`
   * ↔ `goal-evaluator.ts` link one-way: the evaluator calls the
   * consumer's advance helper, the consumer never imports the
   * evaluator.
   */
  advanceSessionQueue?: (
    projectId: string,
    worktreeId: string,
    sessionId: string
  ) => Promise<void>;
  /** Wall-clock injection for tests. */
  now?: () => Date;
  /** API key lookup; defaults to the orchestrator's provider keys. */
  getApiKey?: () => Promise<Record<string, string>>;
  /** Override the model id (defaults to a haiku-class OpenRouter model). */
  model?: string;
  /** Override the follow-up prompt the evaluator enqueues. */
  followUpPrompt?: string;
  /** Inject the chat-completions call for tests. */
  callModel?: (params: {
    model: string;
    system: string;
    user: string;
    apiKey: string;
  }) => Promise<{ met: boolean; reason: string }>;
}

interface GoalEvalResult {
  met: boolean;
  reason: string;
}

/**
 * Evaluate one session's goal. Returns the resulting goal state plus a
 * flag for whether the evaluator enqueued a follow-up.
 *
 * Gating (issue #339 review):
 *   - Skip when the session has an in-flight turn. Without this a single
 *     long turn could exhaust a five-turn goal purely via repeated ticks
 *     and burn an OpenRouter call every 30 seconds with no progress to
 *     judge against.
 *   - When the session is archived, clear the goal without a model call.
 *     An uncapped archived goal would otherwise keep paying for a
 *     session the user has explicitly retired.
 */
export async function evaluateGoal(
  sessionId: string,
  deps: GoalEvaluatorDeps
): Promise<EvaluatorOutcome> {
  const goal = await readSessionGoal(sessionId);
  if (!goal) {
    return { goal: null, enqueued: false, reason: "no goal attached" };
  }

  // Active-run gate (issue #339 review). Defaults to "always idle"
  // when the dep is omitted so existing tests don't need to wire it.
  if (deps.isSessionActive?.(sessionId)) {
    return { goal, enqueued: false, reason: "session is mid-turn" };
  }

  const now = (deps.now ?? (() => new Date()))();
  // Cap checks first: an expired goal clears without a model call. The
  // evaluator's whole point is to be cheap, so we skip the LLM hop
  // whenever the cap forces a clear.
  if (goal.expiresAt && new Date(goal.expiresAt).getTime() <= now.getTime()) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "expired", deps);
    return { goal: null, enqueued: false, reason: "expired" };
  }
  if (goal.maxTurns != null && goal.turnsEvaluated >= goal.maxTurns) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "exceeded", deps);
    return { goal: null, enqueued: false, reason: "exceeded" };
  }

  // Located session is needed for the rest of the path (transcript
  // tail + post-judgment enqueue/advance). We also use it here to
  // detect the archived case before paying for a model call.
  const located = await deps.locateSession(sessionId).catch(() => null);
  if (!located) {
    // Session vanished entirely (e.g. between ticks). Drop the goal so
    // the sidecar doesn't accumulate as cruft.
    await clearSessionGoal(sessionId);
    return { goal: null, enqueued: false, reason: "session not found" };
  }
  if (deps.readSession) {
    const session = await deps
      .readSession(located.worktreePath, sessionId)
      .catch(() => null);
    if (session?.status === "archived") {
      await clearSessionGoal(sessionId);
      await emitCleared(sessionId, "archived", deps);
      return { goal: null, enqueued: false, reason: "archived" };
    }
  }

  // Otherwise ask the small model. A throw or a malformed response leaves
  // the goal in place (a transient failure shouldn't kill the loop), but
  // we surface the failure via `reason` so the user sees why the
  // evaluator didn't progress.
  let result: GoalEvalResult;
  try {
    result = await judgeCondition(goal, sessionId, located, deps);
  } catch (error) {
    const reason = `judge failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await stampReason(sessionId, reason);
    return { goal: { ...goal, lastReason: reason }, enqueued: false, reason };
  }

  const updated: SessionGoal = {
    ...goal,
    turnsEvaluated: goal.turnsEvaluated + 1,
    lastReason: result.reason,
  };
  await writeSessionGoal(updated);

  if (result.met) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "met", deps);
    return { goal: null, enqueued: false, reason: result.reason };
  }

  // Not met: if the agent has already enqueued a follow-up, the queue
  // pipeline drains it naturally — we leave the goal in place and
  // exit. If the queue is empty, the evaluator enqueues a short prompt
  // and immediately fires the queue advance so the loop continues
  // without requiring the agent to remember to re-fire. The cap above
  // still bounds this.
  const queue = await listQueue(sessionId).catch(() => []);
  if (queue.length > 0) {
    // The agent has already queued a follow-up; nothing to do.
    return { goal: updated, enqueued: false, reason: result.reason };
  }
  const prompt = deps.followUpPrompt ?? DEFAULT_FOLLOW_UP_PROMPT;
  // Reuse the session's own provider/model when available so a Codex
  // goal resumes as Codex and a Claude goal resumes with the configured
  // model id (not the test stub). Falls back to the Claude default for
  // tests / unconfigured sessions.
  let provider = "claude";
  let model = "claude/test";
  let mode: "default" | "plan" = "default";
  if (deps.readSession) {
    const session = await deps
      .readSession(located.worktreePath, sessionId)
      .catch(() => null);
    if (session) {
      if (typeof session.provider === "string" && session.provider) {
        provider = session.provider;
      }
      if (typeof session.model === "string" && session.model) {
        model = session.model;
      }
      if (session.mode === "plan") mode = "plan";
    }
  }
  await enqueueMessage(sessionId, {
    text: prompt,
    visibleText: prompt,
    origin: "goal",
    provider,
    model,
    mode,
    attachmentIds: [],
  });
  // Fire the queue advance so the freshly enqueued follow-up actually
  // runs (issue #339 review). The wakes consumer only triggers on
  // `runAt`-stamped heads, so without this hook the loop would stall
  // after its first judgment.
  if (deps.advanceSessionQueue) {
    try {
      await deps.advanceSessionQueue(
        located.projectId,
        located.worktreeId,
        sessionId
      );
    } catch (error) {
      // Best-effort: a failed advance leaves the message in the queue
      // for the next scheduler tick / run-completion. Don't undo the
      // enqueue or clear the goal.
      console.error(
        `[goal-evaluator] advance failed for ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return { goal: updated, enqueued: true, reason: result.reason };
}

async function stampReason(sessionId: string, reason: string): Promise<void> {
  const existing = await readSessionGoal(sessionId);
  if (!existing) return;
  await writeSessionGoal({ ...existing, lastReason: reason });
}

async function emitCleared(
  sessionId: string,
  reason: string,
  deps: GoalEvaluatorDeps
): Promise<void> {
  const located = await deps.locateSession(sessionId).catch(() => null);
  if (!located) return;
  const event: AgentEvent = {
    id: cryptoRandomId(),
    sessionId,
    timestamp: new Date().toISOString(),
    type: "goal_cleared",
    data: { reason },
  };
  try {
    await appendEvent(located.worktreePath, sessionId, event);
  } catch {
    // Best-effort: the goal file is the source of truth, the event log
    // is for the UI. A failed write doesn't undo the clear.
  }
}

function cryptoRandomId(): string {
  // Avoid pulling `node:crypto` at module load; use Web Crypto when
  // available, fall back to Math.random for environments without it
  // (the goal id only needs to be unique within one event log file).
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Call the small model and parse a `{ met, reason }` answer. The prompt
 * is short by design: the agent's transcript is the heavy context, and
 * the judge only needs the condition + the recent tail.
 */
async function judgeCondition(
  goal: SessionGoal,
  sessionId: string,
  located: { projectId: string; worktreeId: string; worktreePath: string },
  deps: GoalEvaluatorDeps
): Promise<GoalEvalResult> {
  const apiKeys = await (deps.getApiKey ?? getApiKeyEnvVars)();
  const apiKey = apiKeys.openrouter ?? apiKeys.OPENROUTER_API_KEY;
  if (!apiKey) {
    // No key configured — fail soft so the goal doesn't get stuck. The
    // session stays alive (the cap still bounds the loop); the user sees
    // a `lastReason` they can act on.
    throw new Error(
      "OpenRouter API key not configured (set it in the API keys surface for the evaluator to run)"
    );
  }

  const tail = await readTranscriptTail(
    located.worktreePath,
    sessionId
  ).catch(() => []);
  const transcript = tail
    .map((event) => formatEventForJudge(event))
    .filter(Boolean)
    .join("\n");

  const system = [
    "You are a goal-completion judge for a coding-agent session.",
    "Given a completion condition and the agent's recent transcript,",
    "decide whether the condition is now satisfied.",
    "Respond with a single JSON object: {\"met\": boolean, \"reason\": string}.",
    "The reason must be one short sentence a human can read.",
    "Do not run any tools. Do not produce anything other than the JSON object.",
  ].join(" ");

  const user = [
    `CONDITION: ${goal.condition}`,
    "",
    "RECENT TRANSCRIPT:",
    transcript || "(empty)",
  ].join("\n");

  const call = deps.callModel ?? defaultCallModel;
  return call({
    model: deps.model ?? DEFAULT_MODEL,
    system,
    user,
    apiKey,
  });
}

/**
 * Read the last `TRANSCRIPT_TAIL_EVENTS` events for the session. The
 * events file is JSONL so this is a tail-read with line skipping; we
 * keep the in-memory cost bounded so a long-lived session doesn't
 * balloon the judge's prompt.
 */
async function readTranscriptTail(
  worktreePath: string,
  sessionId: string
): Promise<AgentEvent[]> {
  const events = await getEvents(worktreePath, sessionId);
  if (events.length <= TRANSCRIPT_TAIL_EVENTS) return events;
  return events.slice(events.length - TRANSCRIPT_TAIL_EVENTS);
}

function formatEventForJudge(event: AgentEvent): string {
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant_response":
      return typeof data.text === "string"
        ? `assistant: ${truncate(data.text, 400)}`
        : "";
    case "tool_call":
      return `tool_call(${String(data.name ?? "unknown")})`;
    case "tool_result":
      return `tool_result(${truncate(asString(data.result), 200)})`;
    case "user_message":
      return typeof data.text === "string"
        ? `user: ${truncate(data.text, 200)}`
        : "";
    case "goal_cleared":
      return `goal_cleared(${String(data.reason ?? "")})`;
    case "error":
      return `error(${truncate(asString(data.text), 200)})`;
    default:
      return "";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * Default chat-completions caller. Hits OpenRouter (one HTTP POST) with
 * the model the evaluator was configured with. We force
 * `response_format: { type: "json_object" }` so the response is a
 * parseable JSON object, and fall back to a permissive regex parse when
 * the provider ignores the hint.
 */
async function defaultCallModel(params: {
  model: string;
  system: string;
  user: string;
  apiKey: string;
}): Promise<GoalEvalResult> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  return parseJudgeResponse(content);
}

/**
 * Parse the judge's response. OpenRouter with `response_format:
 * json_object` returns a JSON string the model produced; we accept
 * either strict JSON or a single-line JSON object embedded in text.
 */
export function parseJudgeResponse(raw: string): GoalEvalResult {
  const trimmed = raw.trim();
  // Direct parse first.
  try {
    const parsed = JSON.parse(trimmed) as { met?: unknown; reason?: unknown };
    if (typeof parsed.met === "boolean") {
      return {
        met: parsed.met,
        reason:
          typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason
            : parsed.met
              ? "condition met"
              : "condition not met",
      };
    }
  } catch {
    // Fall through to a regex extraction for providers that ignore
    // `response_format`.
  }
  const match = /\{[\s\S]*?"met"\s*:\s*(true|false)[\s\S]*?\}/.exec(trimmed);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { met: boolean; reason?: string };
      return {
        met: parsed.met,
        reason: parsed.reason ?? (parsed.met ? "met" : "not met"),
      };
    } catch {
      // Fall through to the default.
    }
  }
  // Default to "not met" so the loop continues — a malformed response
  // must never accidentally clear the goal.
  return { met: false, reason: "judge response could not be parsed" };
}

/**
 * Build a tick consumer (issue #339). The returned function is
 * synchronous and detaches its work via `fireAndForget` so a slow
 * evaluator on one session cannot block the next tick.
 */
export function makeGoalEvaluatorConsumer(
  deps: GoalEvaluatorDeps,
  fireAndForget: (work: Promise<unknown>) => void,
  listCandidateSessions: () => Promise<string[]>
): (now: Date) => void {
  return (now: Date) => {
    fireAndForget(runGoalEvaluatorSweep(listCandidateSessions(), deps));
  };
}

/**
 * Sweep every session with a goal. Exported for tests. Failures on
 * individual sessions do not abort the sweep.
 */
export async function runGoalEvaluatorSweep(
  candidateSessions: Promise<string[]> | string[],
  deps: GoalEvaluatorDeps
): Promise<void> {
  const sessions = await candidateSessions;
  await Promise.all(
    sessions.map(async (sessionId) => {
      try {
        await evaluateGoal(sessionId, deps);
      } catch (error) {
        console.error(
          `[goal-evaluator] failed for ${sessionId}:`,
          error instanceof Error ? error.message : error
        );
      }
    })
  );
}

/**
 * List every session id that currently has a goal sidecar. Used by the
 * consumer to enumerate the work for a tick. Iterates the goals
 * directory directly so the evaluator is decoupled from project state
 * (e.g. a session whose project is archived is still reachable for
 * evaluation until the goal clears on its own). The shape check (a
 * candidate must look like `{ condition, setAt }`) filters out files
 * that share the directory but aren't goals, so a malformed sidecar
 * can't crash the sweep.
 */
export async function listGoalSessions(): Promise<string[]> {
  const dir = path.join(projectStoreDir("."), "..", "..", "goals");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  const valid: string[] = [];
  await Promise.all(
    candidates.map(async (sessionId) => {
      try {
        const content = await fs.readFile(
          path.join(dir, `${sessionId}.json`),
          "utf-8"
        );
        const parsed = JSON.parse(content) as { condition?: unknown; setAt?: unknown };
        if (typeof parsed.condition === "string" && typeof parsed.setAt === "string") {
          valid.push(sessionId);
        }
      } catch {
        // Skip malformed files — one bad sidecar must never crash the
        // sweep. Matches the focus-state listSessions behavior.
      }
    })
  );
  return valid;
}