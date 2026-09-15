export type ControllerStatus =
  | { state: "starting"; port: number }
  | { state: "listening"; port: number }
  | { state: "error"; port?: number; message: string };

export interface ControllerCheckResult {
  available: boolean;
  suggestion?: number;
  error?: string;
}

export interface PreviewUrlCheckResult {
  allowed: boolean;
  url?: string;
  error?: string;
}

/**
 * Result of a single preview-file read inside the Electron main process
 * (issue #356). The server has already canonicalized the path; the main
 * process re-checks the path is still inside the active worktree (or
 * `allowOutside` is set) and returns the bytes as base64 so the
 * renderer can hand them to the guest `<input type="file">` via a
 * single `executeJavaScript` round-trip.
 *
 * `scope` echoes the same values `server/lib/browser-policy.ts`
 * returns so the renderer can confirm the policy verdict that the
 * main process applied at read time.
 */
export interface PreviewFileReadResult {
  ok: boolean;
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  /** Base64-encoded file contents. */
  contentBase64?: string;
  scope?: "inside-project" | "outside-project" | "invalid";
  error?: string;
}

export interface ControllerBridge {
  isElectron: true;
  checkPort: (port: number) => Promise<ControllerCheckResult>;
  startServer: (port: number) => Promise<{ port: number; url: string }>;
  onStatus: (cb: (status: ControllerStatus) => void) => () => void;
  // Synchronously read the latest known status. Returns null if the
  // server hasn't been started in this process yet. Useful for
  // re-mounting UI that needs the current state without waiting
  // for the next broadcast.
  getStatus: () => ControllerStatus | null;
  validatePreviewUrl: (
    url: string,
    projectRoot?: string
  ) => Promise<PreviewUrlCheckResult>;
  /**
   * Toggle the TLS-cert verification bypass on the preview pane's session.
   * Used by the agent-controlled browser when the user passes `--insecure`
   * to `controller browser open`. The bypass is scoped to loopback hosts in
   * the main process, so external URLs are unaffected.
   */
  setPreviewCertPolicy: (opts: { insecure: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Read a file from disk for the agent-driven preview browser
   * (issue #356). The main process re-runs the path policy at read
   * time — `projectRoot` should match the worktree the renderer is
   * currently driving — and returns the bytes base64-encoded. The
   * server-side pre-check has already accepted the path; this is the
   * final gate before bytes leave the sandboxed main process.
   */
  readPreviewFile: (
    path: string,
    options: { projectRoot?: string; allowOutside?: boolean }
  ) => Promise<PreviewFileReadResult>;
  /**
   * Open a native folder picker. Returns the absolute path the user
   * selected, or null if they cancelled. The picker is window-modal
   * to the renderer that initiated the call.
   */
  pickDirectory: () => Promise<string | null>;
  navigateToApp: (url: string) => void;
  showWindow: () => void;
  quit: () => void;
}
