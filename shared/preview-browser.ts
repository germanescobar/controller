/*
 * Wire protocol for the agent-controlled preview browser (issue #109).
 *
 * An agent drives the visible Electron preview pane through the
 * `controller-browser` CLI. The CLI calls the Express server over HTTP, the
 * server forwards the command to the renderer that owns the pane over a
 * WebSocket, and the renderer executes it against the `<webview>` element and
 * replies. These types are shared by all three hops so the contract stays
 * consistent.
 *
 * A pane is addressed by a `BrowserKey` (`projectId:worktreeId`), which is the
 * one identifier known on every hop: injected into the agent's environment at
 * spawn time and held by the renderer that renders the session.
 */

/** Actions supported by the v1 vertical slice. */
export type BrowserAction = "open" | "snapshot" | "click" | "type";

export interface BrowserOpenParams {
  /** Web URL, localhost address, or project-relative/absolute file path. */
  url: string;
}

export interface BrowserSnapshotParams {
  /** Optional CSS selector to scope the snapshot. Defaults to the document. */
  selector?: string;
}

export interface BrowserClickParams {
  /** CSS selector of the element to click. */
  selector: string;
}

export interface BrowserTypeParams {
  /** CSS selector of the field to type into. */
  selector: string;
  /** Text to set as the field value. */
  text: string;
  /** When true, submit the field's form after typing. */
  submit?: boolean;
}

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
// WebSocket framing (server <-> renderer)
// ---------------------------------------------------------------------------

/** Renderer announces which pane it owns. */
export interface BrowserRegisterMessage {
  kind: "register";
  key: string;
}

/** Server asks the renderer to run a command against its `<webview>`. */
export interface BrowserCommandMessage {
  kind: "command";
  requestId: string;
  action: BrowserAction;
  params: Record<string, unknown>;
}

/** Renderer reports the outcome of a command. */
export interface BrowserResultMessage {
  kind: "result";
  requestId: string;
  result: BrowserCommandResult;
}

export type BrowserServerMessage = BrowserCommandMessage;
export type BrowserClientMessage = BrowserRegisterMessage | BrowserResultMessage;
