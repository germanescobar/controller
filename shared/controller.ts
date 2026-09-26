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

/**
 * Read-only view of a pull request, surfaced in the right sidebar's
 * PR tab (issue #387). Fields mirror what `gh pr view --json` returns
 * today — keep them loose on optional fields so a future change in
 * `gh` output shape doesn't break the panel.
 */
export interface PrAuthor {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export type PrCheckState =
  | "SUCCESS"
  | "FAILURE"
  | "PENDING"
  | "NEUTRAL"
  | "SKIPPED"
  | "STALE"
  | "QUEUED"
  | "IN_PROGRESS"
  | "WAITING"
  | "REQUESTED"
  | "EXPECTED"
  | "CANCELLED"
  | "ERROR"
  | "ACTION_REQUIRED"
  | string;

export interface PrCheck {
  /** Check name as GitHub displays it. */
  name: string;
  state: PrCheckState;
  /** Description blob — often a single-line summary. */
  description?: string;
  /** Target URL for the check details page, when available. */
  targetUrl?: string;
  /** Context bucket so the panel can group per workflow / check run. */
  workflow?: string;
}

export interface PrComment {
  id: string;
  author: PrAuthor;
  body: string;
  createdAt: string;
  /** Canonical URL for this comment on GitHub. */
  url: string;
}

export type PrReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING"
  | string;

export interface PrReview {
  id: string;
  author: PrAuthor;
  state: PrReviewState;
  body: string;
  submittedAt: string;
  /**
   * Canonical URL for this review on GitHub. `gh pr view --json
   * reviews` does not emit this field on its review selection, so
   * the panel must work without it (issue #387 review feedback —
   * without a fallback the real review stream would be silently
   * filtered out by the server-side validator).
   */
  url?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  url: string;
  author: PrAuthor;
  body: string;
  createdAt: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  isDraft: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | string;
  statusCheckRollup?: PrCheck[];
  comments: PrComment[];
  reviews: PrReview[];
}

export type PrErrorCode =
  | "gh_not_installed"
  | "gh_not_authenticated"
  | "no_pr_for_branch";

/**
 * Return shape of `GET /api/projects/:projectId/git/pr`. `pr: null`
 * is a normal response for a worktree whose branch has no PR; the
 * `error` field is set only when the data fetch failed for a reason
 * the client might want to log.
 */
export interface PrResponse {
  pr: PullRequest | null;
  error?: PrErrorCode;
}
