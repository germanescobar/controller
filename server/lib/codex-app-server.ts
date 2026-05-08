import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getAgentProvider, type AgentStreamEvent, type AgentUserInputQuestion } from "./agents.js";

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string } | string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingUserInputRequest {
  requestId: JsonRpcId;
  itemId: string;
  questions: AgentUserInputQuestion[];
}

interface SessionRuntime {
  sessionId: string;
  threadId: string;
  cwd: string;
  mode: "default" | "plan";
  startedEmitted: boolean;
  turnInProgress: boolean;
  currentTurnId?: string;
  listeners: Set<(event: AgentStreamEvent) => void>;
  pendingUserInput?: PendingUserInputRequest;
  parseEvent: (line: string) => AgentStreamEvent | null;
  currentTurn?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
}

class JsonRpcStreamParser {
  private buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const payload = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!payload) continue;

      try {
        messages.push(JSON.parse(payload) as JsonRpcMessage);
      } catch {
        // Ignore malformed payloads and keep the stream alive.
      }
    }

    return messages;
  }
}

export interface StartPlanTurnOptions {
  message: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  resumeSessionId?: string;
  mode?: "default" | "plan";
}

interface CodexModelListItem {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  defaultReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  additionalSpeedTiers?: string[];
  isDefault: boolean;
}

interface CollaborationModePayload {
  mode: "default" | "plan";
  settings?: {
    model: string;
    reasoning_effort: StartPlanTurnOptions["reasoningEffort"] | null;
    developer_instructions: string | null;
  };
}

export class CodexAppServerManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new JsonRpcStreamParser();
  private nextRequestId = 1;
  private pendingCalls = new Map<JsonRpcId, PendingCall>();
  private sessions = new Map<string, SessionRuntime>();
  private initializePromise: Promise<void> | null = null;
  private readonly codexProvider = getAgentProvider("codex");

  async startPlanTurn(
    options: StartPlanTurnOptions,
    listener: (event: AgentStreamEvent) => void
  ): Promise<{ sessionId: string; done: Promise<void> }> {
    if (!this.codexProvider) {
      throw new Error("Codex provider is not available");
    }

    await this.ensureStarted(options.env);

    let runtime = options.resumeSessionId
      ? this.sessions.get(options.resumeSessionId)
      : undefined;

    if (!runtime) {
      runtime = options.resumeSessionId
        ? await this.resumeSession(options)
        : await this.createSession(options);
    }

    if (runtime.turnInProgress) {
      throw new Error("A Codex turn is already in progress for this session");
    }

    runtime.cwd = options.cwd;
    runtime.mode = options.mode ?? "plan";
    // `run.started` is a turn-level event in our UI/persistence layer, so we
    // need to re-emit it for every follow-up turn on an existing thread.
    runtime.startedEmitted = false;
    runtime.turnInProgress = true;
    runtime.pendingUserInput = undefined;
    runtime.listeners.add(listener);

    const done = new Promise<void>((resolve, reject) => {
      runtime.currentTurn = { resolve, reject };
    });

    this.emitStarted(runtime, options.model ?? "");

    try {
      const serviceTier = options.serviceTier === "fast" ? "fast" : null;
      const turnResult = await this.call("turn/start", {
        threadId: runtime.threadId,
        input: [{ type: "text", text: options.message, text_elements: [] }],
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: options.model ?? null,
        serviceTier,
        effort: options.reasoningEffort ?? null,
        summary: null,
        collaborationMode: this.getCollaborationModePayload(options),
      }) as { turn?: { id?: string } } | null;
      runtime.currentTurnId = turnResult?.turn?.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(runtime, {
        type: "run.failed",
        sessionId: runtime.threadId,
        error: message,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    return { sessionId: runtime.sessionId, done };
  }

  async stopSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.turnInProgress) {
      throw new Error("No active turn for this session");
    }
    if (!runtime.currentTurnId) {
      throw new Error("Turn ID not yet available");
    }
    await this.call("turn/interrupt", {
      threadId: runtime.threadId,
      turnId: runtime.currentTurnId,
    });
  }

  async steerSession(sessionId: string, message: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.turnInProgress) {
      throw new Error("No active turn for this session");
    }
    if (!runtime.currentTurnId) {
      throw new Error("Turn ID not yet available");
    }
    await this.call("turn/steer", {
      threadId: runtime.threadId,
      input: [{ type: "text", text: message, text_elements: [] }],
      expectedTurnId: runtime.currentTurnId,
    });
  }

  async submitUserInput(
    sessionId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.pendingUserInput) {
      throw new Error("This session is not waiting for user input");
    }

    const request = runtime.pendingUserInput;
    runtime.pendingUserInput = undefined;

    const normalizedAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, value]) => [
        questionId,
        { answers: Array.isArray(value) ? value : [value] },
      ])
    );

    this.sendResponse(request.requestId, {
      answers: normalizedAnswers,
    });
  }

  async listModels(env: Record<string, string>): Promise<CodexModelListItem[]> {
    await this.ensureStarted(env);

    const models: CodexModelListItem[] = [];
    let cursor: string | null = null;

    do {
      const response = await this.call("model/list", {
        cursor,
        includeHidden: false,
        limit: 100,
      }) as {
        data?: CodexModelListItem[];
        nextCursor?: string | null;
      } | null;

      models.push(...(response?.data ?? []));
      cursor = response?.nextCursor ?? null;
    } while (cursor);

    return models;
  }

  private getCollaborationModePayload(
    options: StartPlanTurnOptions
  ): CollaborationModePayload {
    if (options.mode === "plan") {
      return {
        mode: "plan",
        settings: {
          model: options.model ?? "",
          reasoning_effort: options.reasoningEffort ?? null,
          developer_instructions: null,
        },
      };
    }

    return {
      mode: "default",
      settings: {
        model: options.model ?? "",
        reasoning_effort: options.reasoningEffort ?? null,
        developer_instructions:
          "<collaboration_mode># Collaboration Mode: Default\n\nYou are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.</collaboration_mode>",
      },
    };
  }

  private async createSession(options: StartPlanTurnOptions): Promise<SessionRuntime> {
    const serviceTier = options.serviceTier === "fast" ? "fast" : null;
    const response = await this.call("thread/start", {
      model: options.model ?? null,
      serviceTier,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ephemeral: false,
    });

    const thread = getThreadFromResponse(response);
    if (!thread?.id) {
      throw new Error("Codex app-server did not return a thread id");
    }

    const runtime: SessionRuntime = {
      sessionId: thread.id,
      threadId: thread.id,
      cwd: options.cwd,
      mode: options.mode ?? "plan",
      startedEmitted: false,
      turnInProgress: false,
      listeners: new Set(),
      parseEvent: this.codexProvider?.createParser?.() ?? (() => null),
    };
    this.sessions.set(runtime.sessionId, runtime);
    return runtime;
  }

  private async resumeSession(options: StartPlanTurnOptions): Promise<SessionRuntime> {
    const serviceTier = options.serviceTier === "fast" ? "fast" : null;
    const response = await this.call("thread/resume", {
      threadId: options.resumeSessionId,
      model: options.model ?? null,
      serviceTier,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
    });

    const thread = getThreadFromResponse(response);
    const threadId = thread?.id ?? options.resumeSessionId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }

    const runtime: SessionRuntime = {
      sessionId: threadId,
      threadId,
      cwd: options.cwd,
      mode: options.mode ?? "plan",
      startedEmitted: false,
      turnInProgress: false,
      listeners: new Set(),
      parseEvent: this.codexProvider?.createParser?.() ?? (() => null),
    };
    this.sessions.set(runtime.sessionId, runtime);
    return runtime;
  }

  private emitStarted(runtime: SessionRuntime, model: string) {
    if (runtime.startedEmitted) return;
    runtime.startedEmitted = true;
    this.emit(runtime, {
      type: "run.started",
      sessionId: runtime.sessionId,
      model,
      workingDirectory: runtime.cwd,
      timestamp: new Date().toISOString(),
    });
  }

  private emit(runtime: SessionRuntime, event: AgentStreamEvent) {
    if (event.type === "user.input_requested") {
      runtime.pendingUserInput = {
        requestId: runtime.pendingUserInput?.requestId ?? "",
        itemId: event.id,
        questions: event.questions,
      };
    }

    for (const listener of runtime.listeners) {
      listener(event);
    }

    if (event.type === "run.completed" || event.type === "run.failed") {
      runtime.turnInProgress = false;
      runtime.currentTurnId = undefined;
      runtime.pendingUserInput = undefined;
      runtime.listeners.clear();
      if (event.type === "run.completed") {
        runtime.currentTurn?.resolve();
      } else {
        runtime.currentTurn?.reject(new Error(event.error));
      }
      runtime.currentTurn = undefined;
    }
  }

  private async ensureStarted(env: Record<string, string>): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = new Promise<void>((resolve, reject) => {
      const child = spawn(
        "codex",
        ["app-server", "--listen", "stdio://", "--enable", "default_mode_request_user_input"],
        {
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      this.child = child;

      child.stdout.on("data", (chunk: Buffer) => {
        const messages = this.parser.push(chunk.toString("utf-8"));
        for (const message of messages) {
          this.handleMessage(message);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) {
          console.error(`[codex-app-server] ${text}`);
        }
      });

      child.on("error", (error) => {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      });

      child.on("close", () => {
        this.failAll(new Error("Codex app-server process exited"));
      });

      this.call("initialize", {
        clientInfo: { name: "coding-orchestrator", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      })
        .then(() => {
          this.writeMessage({ method: "initialized" });
          resolve();
        })
        .catch((error) => reject(error));
    });

    await this.initializePromise;
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.method) {
      const params = message.params ?? {};
      const runtime = this.findRuntime(params);

      if (message.id !== undefined) {
        if (message.method === "item/tool/requestUserInput" && runtime) {
          const mappedEvent = runtime.parseEvent(JSON.stringify(message));
          if (mappedEvent?.type === "user.input_requested") {
            runtime.pendingUserInput = {
              requestId: message.id,
              itemId: mappedEvent.id,
              questions: mappedEvent.questions,
            };
            this.emit(runtime, mappedEvent);
            return;
          }
        }

        this.sendError(message.id, `Unsupported app-server request: ${message.method}`);
        return;
      }

      if (!runtime) return;
      const mappedEvent = runtime.parseEvent(JSON.stringify(message));
      if (!mappedEvent) return;
      if (mappedEvent.type === "run.started" && runtime.startedEmitted) return;
      if (mappedEvent.type === "run.started") {
        runtime.startedEmitted = true;
      }
      this.emit(runtime, mappedEvent);
      return;
    }

    if (message.id === undefined) return;

    const pending = this.pendingCalls.get(message.id);
    if (!pending) return;
    this.pendingCalls.delete(message.id);

    if (message.error) {
      const errorMessage =
        typeof message.error === "string"
          ? message.error
          : message.error.message ?? "Unknown app-server error";
      pending.reject(new Error(errorMessage));
      return;
    }

    pending.resolve(message.result);
  }

  private findRuntime(params: Record<string, unknown>): SessionRuntime | undefined {
    const threadId = params.threadId as string | undefined;
    if (!threadId) return undefined;
    return this.sessions.get(threadId);
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      this.sendRequest({ id, method, params });
    });
  }

  private sendRequest(payload: { id: JsonRpcId; method: string; params: Record<string, unknown> }) {
    this.writeMessage({
      jsonrpc: "2.0",
      ...payload,
    });
  }

  private sendResponse(id: JsonRpcId, result: Record<string, unknown>) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private sendError(id: JsonRpcId, message: string) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message },
    });
  }

  private writeMessage(message: Record<string, unknown>) {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error) {
    this.child = null;
    this.initializePromise = null;

    for (const pending of this.pendingCalls.values()) {
      pending.reject(error);
    }
    this.pendingCalls.clear();

    for (const runtime of this.sessions.values()) {
      if (runtime.turnInProgress) {
        this.emit(runtime, {
          type: "run.failed",
          sessionId: runtime.sessionId,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.sessions.clear();
  }
}

function getThreadFromResponse(value: unknown): { id?: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const thread = raw.thread;
  if (!thread || typeof thread !== "object") return null;
  return thread as { id?: string };
}

export const codexAppServerManager = new CodexAppServerManager();
