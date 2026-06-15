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
 */

import type { WebSocket } from "ws";

/** Generic command result mirrored from `shared/preview-browser.ts`. */
export interface BridgeResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  summary?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (result: BridgeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 20_000;

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
   */
  execute(
    key: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<BridgeResult> {
    const ws = this.hosts.get(key);
    if (!ws) {
      return Promise.reject(
        new Error(
          "No preview pane is connected for this session. Open the Preview tab in the app first."
        )
      );
    }

    const requestId = String(this.nextRequestId++);
    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Browser command "${action}" timed out`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ kind: "command", requestId, action, params }));
    });
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
