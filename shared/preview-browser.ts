/*
 * Wire protocol for the agent-controlled preview browser (issue #109).
 *
 * An agent drives the visible Electron preview pane through the
 * `controller-browser` CLI. The CLI calls the Express server over HTTP, the
 * server forwards the command to the renderer that owns the pane over a
 * WebSocket, and the renderer executes it against the `<webview>` element and
 * replies.
 *
 * A pane is addressed by a `projectId:worktreeId` key: the renderer registers
 * under it, and the server resolves the same key from the agent's working
 * directory when a command arrives.
 */

/** Actions supported by the v1 vertical slice. */
export type BrowserAction = "open" | "snapshot" | "click" | "type";

/** Result payload returned for a successful command. */
export interface BrowserCommandResultData {
  /** Current page URL after the command, when known. */
  url?: string;
  /** Current page title after the command, when known. */
  title?: string;
  /** Text snapshot of the page (snapshot action). */
  text?: string;
  /** Human-readable one-line summary of what happened. */
  summary?: string;
}

export type BrowserCommandResult =
  | ({ ok: true } & BrowserCommandResultData)
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// WebSocket framing (server -> renderer)
// ---------------------------------------------------------------------------
//
// The renderer's outbound frames (`{ kind: "register", key }` and
// `{ kind: "result", requestId, result }`) are written inline; only the
// inbound command frame is consumed as a type, so that's the only one modeled
// here.

/** Server asks the renderer to run a command against its `<webview>`. */
export interface BrowserCommandMessage {
  kind: "command";
  requestId: string;
  action: BrowserAction;
  params: Record<string, unknown>;
}

export type BrowserServerMessage = BrowserCommandMessage;
