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
 *
 * Issue #170 added locator-style selector engines (`text=`, `role=`, `label=`,
 * `placeholder=`, `ref=`) so the CLI can target elements on third-party pages
 * without hand-built CSS, and an accessibility-tree snapshot mode that emits
 * refs the agent can pass back to `click`/`type`. Selectors are still resolved
 * inside the guest page — the protocol is just an opaque string + flag
 * handshake so this layer stays UI-framework agnostic.
 */

/** Actions supported. */
export type BrowserAction = "open" | "snapshot" | "click" | "type";

/**
 * Refs emitted by an accessibility snapshot. Each key is a short opaque id
 * (e.g. `e1`, `e2`) the agent can pass back to `click`/`type` as
 * `ref=<id>`. The value is the resolved CSS selector the renderer can
 * `querySelector` on the same page.
 */
export type BrowserSnapshotRefs = Record<string, string>;

/** Result payload returned for a successful command. */
export interface BrowserCommandResultData {
  /** Current page URL after the command, when known. */
  url?: string;
  /** Current page title after the command, when known. */
  title?: string;
  /** Text snapshot of the page (snapshot action). */
  text?: string;
  /** Stable element refs the agent can target by id (snapshot action). */
  refs?: BrowserSnapshotRefs;
  /** Number of refs the agent should expect to see in the snapshot text. */
  refCount?: number;
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
