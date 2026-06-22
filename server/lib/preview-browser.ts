/*
 * Preview browser bridge (issue #109).
 *
 * Routes browser commands from the `controller-browser` CLI (over HTTP) to the
 * renderer that owns the visible preview pane (over a WebSocket), and returns
 * the renderer's reply. A pane is addressed by a `projectId:worktreeId` key.
 *
 * The bridge is intentionally generic about command shapes: it forwards an
 * action name plus an opaque params object and resolves with whatever result
 * the renderer reports. The typed protocol lives in `shared/preview-browser.ts`
 * and is used by the CLI and renderer, which sit at the two strongly-typed ends
 * of this pipe.
 *
 * Issue #170 hardened the connection: the renderer auto-reconnects on socket
 * drop, so a transient pane detach is followed by a fresh `register` frame. To
 * bridge the gap, `execute` waits briefly for a host to appear instead of
 * erroring immediately. The grace window is short enough that a genuinely
 * disconnected pane still fails fast, but long enough to absorb a reconnect
 * cycle or a quick render-tab switch.
 */

import type { WebSocket } from "ws";

/** Generic command result mirrored from `shared/preview-browser.ts`. */
export interface BridgeResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  summary?: string;
  refs?: Record<string, string>;
  refCount?: number;
  error?: string;
}

interface PendingRequest {
  resolve: (result: BridgeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  hostWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** How long `execute` waits for a host to register before erroring. */
const DEFAULT_HOST_WAIT_MS = 3_000;
/** Poll cadence while waiting for a host to register. */
const HOST_WAIT_POLL_MS = 100;

class PreviewBrowserBridge {
  // Most recently registered renderer socket per pane key. A session is
  // normally visible in a single window; last-writer-wins keeps the active
  // window in control without leaking stale sockets.
  private hosts = new Map<string, WebSocket>();
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  /** Whether a renderer is currently hosting the given pane. */
  hasHost(key: string): boolean {
    return this.hosts.has(key);
  }

  /**
   * Wire up a renderer connection. The socket must send a `register` frame
   * naming the pane it owns; afterwards it receives `command` frames and
   * replies with `result` frames.
   */
  handleConnection(ws: WebSocket): void {
    let registeredKey: string | null = null;

    ws.on("message", (raw: Buffer) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.kind === "register" && typeof message.key === "string") {
        registeredKey = message.key;
        this.hosts.set(message.key, ws);
        return;
      }

      if (message.kind === "result" && typeof message.requestId === "string") {
        this.resolvePending(message.requestId, message.result as BridgeResult);
      }
    });

    const detach = () => {
      if (registeredKey && this.hosts.get(registeredKey) === ws) {
        this.hosts.delete(registeredKey);
      }
    };
    ws.on("close", detach);
    ws.on("error", detach);
  }

  /**
   * Send a command to the renderer that owns `key` and wait for its reply.
   * Rejects if no pane is connected or the renderer does not answer in time.
   * If a host is already present the command is sent synchronously, matching
   * the pre-#170 behavior; otherwise the call waits up to `hostWaitMs` for a
   * host to register (issue #170).
   */
  execute(
    key: string,
    action: string,
    params: Record<string, unknown>,
    options: ExecuteOptions = {}
  ): Promise<BridgeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const hostWaitMs = options.hostWaitMs ?? DEFAULT_HOST_WAIT_MS;
    const existing = this.hosts.get(key);
    if (existing) {
      return this.send(existing, action, params, timeoutMs);
    }
    if (hostWaitMs <= 0) {
      return Promise.reject(
        new Error(
          "No preview pane is connected for this session. Open the Preview tab in the app first."
        )
      );
    }
    return this.waitForHostThenSend(key, action, params, timeoutMs, hostWaitMs);
  }

  /** Send a command to a known socket and resolve when the renderer answers. */
  private send(
    ws: WebSocket,
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BridgeResult> {
    const requestId = String(this.nextRequestId++);
    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Browser command "${action}" timed out`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ kind: "command", requestId, action, params }));
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Wait for a host to register, then send the command. Polls every
   * `HOST_WAIT_POLL_MS` so a freshly reconnected renderer picks up the
   * command without the agent having to retry.
   */
  private async waitForHostThenSend(
    key: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    hostWaitMs: number
  ): Promise<BridgeResult> {
    const deadline = Date.now() + hostWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, HOST_WAIT_POLL_MS));
      const host = this.hosts.get(key);
      if (host) return this.send(host, action, params, timeoutMs);
    }
    throw new Error(
      "No preview pane is connected for this session. Open the Preview tab in the app first."
    );
  }

  private resolvePending(requestId: string, result: BridgeResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result ?? { ok: false, error: "Empty result" });
  }
}

export const previewBrowserBridge = new PreviewBrowserBridge();