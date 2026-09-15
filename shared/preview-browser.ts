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
export type BrowserAction = "open" | "snapshot" | "click" | "type" | "setFiles";

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
  /** Per-file outcome from a `setFiles` action — input order, one row each. */
  files?: BrowserSetFilesResultEntry[];
}

export type BrowserCommandResult =
  | ({ ok: true } & BrowserCommandResultData)
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// WebSocket framing (server -> renderer)
// ---------------------------------------------------------------------------
//
// The renderer's outbound registration/result frames are written inline.
// Server messages are modeled here because both the pane host and the
// app-level lazy-pane registry consume them.

/** Server asks the renderer to run a command against its `<webview>`. */
export interface BrowserCommandMessage {
  kind: "command";
  requestId: string;
  action: BrowserAction;
  params: Record<string, unknown>;
}

/** Server asks the app-level preview pool to create a host for a worktree. */
export interface BrowserEnsurePaneMessage {
  kind: "ensure-pane";
  key: string;
  projectRoot: string;
}

/**
 * Subset of `params` recognized by the renderer. Defined here so both ends
 * agree on the shape without a separate types module.
 *
 * `insecure` is only meaningful on `open`: when true, the renderer asks the
 * Electron main process to install a cert-verify bypass scoped to localhost
 * before navigating, so a local dev server with a self-signed cert can be
 * reached. The server-side policy has already constrained the target to a
 * localhost hostname by the time this flag is acted on.
 */
export interface BrowserOpenParams {
  url: string;
  insecure?: boolean;
}

/**
 * Per-file metadata carried over the wire for a `setFiles` call (issue #356).
 *
 * The server has already validated each path against the worktree policy
 * before forwarding; the bytes themselves come from the Electron main
 * process via `controller.readPreviewFile` (the renderer asks for them
 * once the server's canonical path list arrives). Two shapes flow over
 * the wire:
 *
 *  - `BrowserSetFilesFileMeta` — what the server → renderer hop carries.
 *    No bytes; just enough metadata for the renderer to ask the main
 *    process for the right file and to correlate the per-file outcome
 *    back to the original CLI argument (via `path`).
 *  - `BrowserSetFilesFileInput` — what the renderer → webview hop
 *    carries after the bytes have been loaded by the main process.
 *    Base64 keeps the payload inside one `executeJavaScript` round-trip
 *    without an additional streaming channel.
 *
 * The split exists because the policy lives on the server side
 * (canonical path resolution + symlink defense) and the file IO lives
 * in the Electron main process (size cap, user confirmation prompt);
 * the renderer is just the bridge that stitches them together.
 */
export interface BrowserSetFilesFileMeta {
  /** Canonical absolute path the file lives at, as resolved by the server-side policy. */
  path: string;
  /** Filename the page will see on the resulting `File` object. */
  name: string;
  /** MIME type best-effort inferred from extension; refined by the main process on read. */
  type: string;
  /** File size in bytes, observed by the server before forwarding. */
  size: number;
}

export interface BrowserSetFilesFileInput extends BrowserSetFilesFileMeta {
  /** Base64-encoded file contents. */
  contentBase64: string;
}

export interface BrowserSetFilesParams {
  selector: string;
  /** Canonical per-file metadata the renderer must ask the main process to read. */
  files: BrowserSetFilesFileMeta[];
  /** Pass-through of the CLI's `--allow-outside` flag. */
  allowOutside?: boolean;
}

/** Per-file outcome reported back so the agent can detect rejections. */
export interface BrowserSetFilesResultEntry {
  /** Canonical absolute path the renderer read from (or that the server rejected). */
  path: string;
  /** Filename the page will see on the resulting `File` object. */
  name: string;
  /** Input-list position. Lets the renderer correlate even when basenames collide. */
  index: number;
  /** True when the file was accepted onto the input element. */
  accepted: boolean;
  /**
   * Page-observed rejection reason (when `accepted=false`):
   * `type-mismatch`, `too-large`, `single-file-input`, `no-files-set`,
   * `read-failed`, the Electron main process's policy text for
   * outside-worktree / oversized / user-denied, or a free-form string
   * the page dispatched.
   */
  reason?: string;
}

export type BrowserServerMessage = BrowserCommandMessage | BrowserEnsurePaneMessage;
