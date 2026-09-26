/**
 * Pull-request metadata for the right sidebar's PR tab (issue #387).
 *
 * Resolves the open PR for a worktree's branch by shelling out to
 * `gh pr view --json …` in three parallel calls (metadata / review
 * state / threads), with a small in-memory cache keyed by
 * `${worktreePath}:${branch}` and invalidated when the worktree's
 * HEAD changes.
 *
 * Why three calls? `gh pr view --json` accepts a single flag, and the
 * full set of fields we want (title + body + checks + comments +
 * reviews) makes for a very wide JSON document. Splitting it into
 * three calls lets us keep the per-call payload lean and lets the
 * call we *care* about (the threads) run concurrently with the
 * metadata. Each call's failure is independent; if the checks call
 * hangs, the metadata still returns.
 *
 * Why a cache? Each request hits `gh` three times. The PR panel polls
 * every 30s when open, but a human toggling between tabs / worktrees
 * could trigger rapid back-to-back fetches. The cache lets us
 * amortize that without making the user wait.
 *
 * IMPORTANT: keep the `PrAuthor`/`PullRequest` block below in sync
 * with the matching types in `shared/controller.ts`. They are
 * duplicated here (rather than imported) because the server's `tsc`
 * build has `rootDir: "."` so it cannot resolve across the `server/`
 * boundary at emit time — see `server/lib/shortcut-settings.ts` for
 * the exact same precedent. The client reads the canonical types.
 */

import { exec, type ExecException } from "node:child_process";
import { promisify } from "node:util";
import { childProcessEnv } from "./shell-env.js";

/* --- Internals ------------------------------------------------------- */

const execAsync = promisify(exec);

const CACHE_TTL_MS = 30_000;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const GH_TIMEOUT_MS = 15_000;

type ExecResult = { stdout: string; stderr: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* --- Type mirror of `shared/controller.ts` PR shape ----------------- */

export interface PrAuthor {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export type PrCheckState = string;

export interface PrCheck {
  name: string;
  state: PrCheckState;
  description?: string;
  targetUrl?: string;
  workflow?: string;
}

export interface PrComment {
  id: string;
  author: PrAuthor;
  body: string;
  createdAt: string;
  url: string;
}

export type PrReviewState = string;

export interface PrReview {
  id: string;
  author: PrAuthor;
  state: PrReviewState;
  body: string;
  submittedAt: string;
  url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  author: PrAuthor;
  body: string;
  createdAt: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  isDraft: boolean;
  reviewDecision?: string;
  statusCheckRollup?: PrCheck[];
  comments: PrComment[];
  reviews: PrReview[];
}

export type PrErrorCode =
  | "gh_not_installed"
  | "gh_not_authenticated"
  | "no_pr_for_branch";

export interface PrResponse {
  pr: PullRequest | null;
  error?: PrErrorCode;
}

/* --- Runner injection (for tests) ----------------------------------- */

/**
 * Spawn signature for `gh` invocations. Production returns the same
 * shape `promisify(exec)` produces — one callable per `gh pr view
 * --json …` field set. Exposed so tests can stub it deterministically
 * without leaning on PATH tricks.
 */
export type GhRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GhRunner = async (args, cwd) => {
  const out = await execAsync(`gh ${args.map(shellQuote).join(" ")}`, {
    cwd,
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
    env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
  });
  return { stdout: out.stdout, stderr: out.stderr };
};

/**
 * The runner currently in use. Production uses `defaultRunner`;
 * tests swap it for a stub via {@link __setPrGhRunnerForTests}.
 */
let activeRunner: GhRunner = defaultRunner;

/**
 * Categorized failure modes of a `gh pr view` invocation. The route
 * maps these into `PrErrorCode` strings the panel can log; the UI
 * silently hides the tab in v1 regardless of cause.
 */
type GhFailure =
  | { kind: "not_installed" }
  | { kind: "not_authenticated"; message: string }
  | { kind: "no_pr"; message: string }
  | { kind: "spawn_failed"; message: string }
  | { kind: "non_zero_exit"; code: number | null; message: string }
  | { kind: "invalid_json"; message: string };

interface CacheEntry {
  fetchedAt: number;
  headSha: string | null;
  payload: { pr: PullRequest | null; error?: PrErrorCode };
}

const cache = new Map<string, CacheEntry>();

/**
 * Build the cache key. We include the path + branch so the same
 * machine can serve multiple worktrees independently; we exclude the
 * HEAD from the key because the head-SHA check is the *value*, not
 * the key.
 */
function cacheKey(worktreePath: string, branch: string | null): string {
  return `${worktreePath}::${branch ?? "(detached)"}`;
}

function isExecException(value: unknown): value is ExecException {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "stdout" in value &&
      "stderr" in value
  );
}

/**
 * Run `gh pr view --json <fields>` and classify the outcome. Returns
 * the parsed JSON on success or a `GhFailure` describing why we
 * couldn't get it. We rely on `gh`'s exit codes + stderr text — the
 * CLI never returns a structured error envelope we can parse.
 *
 * Spawns `gh` through {@link activeRunner} so tests can swap in a
 * stub without touching PATH.
 */
async function fetchGhJson(
  cwd: string,
  fields: string[]
): Promise<{ ok: true; data: unknown } | { ok: false; failure: GhFailure }> {
  const args = ["pr", "view", "--json", fields.join(",")];
  let result: ExecResult;
  try {
    result = await activeRunner(args, cwd);
  } catch (err) {
    if (isExecException(err)) {
      const stderr = typeof err.stderr === "string" ? err.stderr : "";
      // `err.code` is typed as number for `child_process.exec`, but
      // Node also surfaces "ENOENT" as a string when the binary is
      // missing. Widen explicitly here.
      const errCode: unknown = err.code;
      const numericCode = typeof errCode === "number" ? errCode : null;
      // Detect "gh binary missing" two ways:
      //   1. Direct ENOENT — Node's `child_process.exec` itself
      //      could not spawn the wrapper script (rare; we always go
      //      through `sh -c`).
      //   2. Exit code 127 + stderr mentioning "not found" — the
      //      shell ran, could not locate `gh` on PATH, and reported
      //      the conventional `sh: gh: not found` / `gh: command
      //      not found` message. This is what production actually
      //      surfaces (issue #387 review feedback).
      if (errCode === "ENOENT") {
        return { ok: false, failure: { kind: "not_installed" } };
      }
      const stderrLooksLikeMissingGh =
        stderr.includes("not found") ||
        stderr.includes("No such file") ||
        /gh(?::\s*command)? not found/i.test(stderr);
      if (numericCode === 127 && stderrLooksLikeMissingGh) {
        return { ok: false, failure: { kind: "not_installed" } };
      }
      if (stderr.includes("not logged into") || stderr.includes("gh auth login")) {
        return {
          ok: false,
          failure: { kind: "not_authenticated", message: stderr.trim() },
        };
      }
      if (errCode === 8 || stderr.includes("no pull requests found")) {
        return { ok: false, failure: { kind: "no_pr", message: stderr.trim() } };
      }
      return {
        ok: false,
        failure: {
          kind: numericCode != null ? "non_zero_exit" : "spawn_failed",
          code: numericCode,
          message: stderr.trim() || err.message,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: "invalid_json",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function ghFailureToErrorCode(failure: GhFailure): PrErrorCode | null {
  switch (failure.kind) {
    case "not_installed":
      return "gh_not_installed";
    case "not_authenticated":
      return "gh_not_authenticated";
    case "no_pr":
      return "no_pr_for_branch";
    default:
      return null;
  }
}

/**
 * Build the deterministic GitHub avatar URL from an author login.
 * `gh pr view --json author` does not include the avatar URL, but the
 * public avatar CDN resolves any login to a consistent image.
 */
function avatarUrlFor(login: string | undefined): string | undefined {
  if (!login) return undefined;
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=80`;
}

function asAuthor(value: unknown): PrAuthor {
  const obj = (value ?? {}) as Record<string, unknown>;
  const login = typeof obj.login === "string" ? obj.login : "";
  const name = typeof obj.name === "string" ? obj.name : undefined;
  return { login, name, avatarUrl: avatarUrlFor(login) };
}

function asCheck(value: unknown): PrCheck | null {
  const obj = (value ?? {}) as Record<string, unknown>;
  const name =
    typeof obj.name === "string"
      ? obj.name
      : typeof obj.context === "string"
      ? obj.context
      : null;
  if (!name) return null;
  const state =
    typeof obj.state === "string"
      ? obj.state
      : typeof obj.conclusion === "string"
      ? obj.conclusion
      : typeof obj.status === "string"
      ? obj.status
      : "PENDING";
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const targetUrl =
    typeof obj.targetUrl === "string"
      ? obj.targetUrl
      : typeof obj.detailsUrl === "string"
      ? obj.detailsUrl
      : typeof obj.link === "string"
      ? obj.link
      : undefined;
  const suite = obj.checkSuite as Record<string, unknown> | undefined;
  const workflow =
    typeof obj.workflow === "string"
      ? obj.workflow
      : suite && typeof suite.workflow === "string"
      ? suite.workflow
      : undefined;
  return { name, state, description, targetUrl, workflow };
}

function asComment(value: unknown): PrComment | null {
  const obj = (value ?? {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const body = typeof obj.body === "string" ? obj.body : "";
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : null;
  const url = typeof obj.url === "string" ? obj.url : null;
  if (!id || !createdAt || !url) return null;
  return { id, body, createdAt, url, author: asAuthor(obj.author) };
}

function asReview(value: unknown): PrReview | null {
  const obj = (value ?? {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const state = typeof obj.state === "string" ? obj.state : "COMMENTED";
  const body = typeof obj.body === "string" ? obj.body : "";
  const submittedAt = typeof obj.submittedAt === "string"
    ? obj.submittedAt
    : typeof obj.createdAt === "string"
    ? obj.createdAt
    : null;
  const url = typeof obj.url === "string" ? obj.url : null;
  if (!id || !submittedAt || !url) return null;
  return { id, body, state, submittedAt, url, author: asAuthor(obj.author) };
}

interface RawPr {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  author?: unknown;
  body?: string;
  createdAt?: string;
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  statusCheckRollup?: unknown[];
  comments?: unknown[];
  reviews?: unknown[];
}

function mergePrParts(
  meta: RawPr | null,
  state: RawPr | null,
  threads: RawPr | null
): RawPr {
  return {
    ...(meta ?? {}),
    reviewDecision: state?.reviewDecision ?? meta?.reviewDecision,
    statusCheckRollup: state?.statusCheckRollup ?? meta?.statusCheckRollup ?? [],
    comments: threads?.comments ?? meta?.comments ?? [],
    reviews: threads?.reviews ?? meta?.reviews ?? [],
  };
}

function normalizePr(raw: RawPr): PullRequest | null {
  const number = typeof raw.number === "number" ? raw.number : null;
  const title = typeof raw.title === "string" ? raw.title : null;
  const state = typeof raw.state === "string" ? raw.state : null;
  const url = typeof raw.url === "string" ? raw.url : null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : null;
  const headRefName = typeof raw.headRefName === "string" ? raw.headRefName : null;
  const baseRefName = typeof raw.baseRefName === "string" ? raw.baseRefName : null;
  if (
    number == null ||
    !title ||
    !state ||
    !url ||
    !createdAt ||
    !headRefName ||
    !baseRefName
  ) {
    return null;
  }
  return {
    number,
    title,
    state,
    url,
    author: asAuthor(raw.author),
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt,
    headRefName,
    baseRefName,
    additions: typeof raw.additions === "number" ? raw.additions : 0,
    deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
    changedFiles: typeof raw.changedFiles === "number" ? raw.changedFiles : 0,
    mergeable: typeof raw.mergeable === "string" ? raw.mergeable : "UNKNOWN",
    isDraft: Boolean(raw.isDraft),
    reviewDecision:
      typeof raw.reviewDecision === "string" ? raw.reviewDecision : undefined,
    statusCheckRollup: Array.isArray(raw.statusCheckRollup)
      ? raw.statusCheckRollup.map(asCheck).filter((c): c is PrCheck => c !== null)
      : [],
    comments: Array.isArray(raw.comments)
      ? raw.comments.map(asComment).filter((c): c is PrComment => c !== null)
      : [],
    reviews: Array.isArray(raw.reviews)
      ? raw.reviews.map(asReview).filter((r): r is PrReview => r !== null)
      : [],
  };
}

async function resolveHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", {
      cwd,
      maxBuffer: 4096,
      env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function resolveBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      maxBuffer: 4096,
      env: childProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Fetch the open PR for a worktree's current branch. Returns
 * `{ pr: null }` when the branch has no PR (the normal "nothing to
 * show" case) and `{ pr: null, error: ... }` when something else went
 * wrong.
 *
 * Results are cached per `${path}::${branch}` for up to 30s, with
 * a fast-path invalidation whenever the worktree's HEAD changes.
 */
export async function fetchPullRequestForWorktree(
  worktreePath: string
): Promise<PrResponse> {
  const branch = await resolveBranch(worktreePath);
  const headSha = await resolveHeadSha(worktreePath);

  // No branch → not on a PR-able ref (detached HEAD with no PR
  // backing it). Don't even try `gh`.
  if (!branch) {
    return { pr: null };
  }

  const key = cacheKey(worktreePath, branch);
  const cached = cache.get(key);
  const now = Date.now();
  if (
    cached &&
    now - cached.fetchedAt < CACHE_TTL_MS &&
    cached.headSha === headSha
  ) {
    return cached.payload;
  }

  // Run the three calls in parallel. The route will get a single
  // combined `GhFailure` if *any* of them errored; in practice the
  // metadata call is the one that returns "no PR found", and the
  // others happily return empty arrays.
  const [meta, stateRes, threads] = await Promise.all([
    fetchGhJson(worktreePath, [
      "number",
      "title",
      "state",
      "url",
      "author",
      "body",
      "createdAt",
      "headRefName",
      "baseRefName",
      "additions",
      "deletions",
      "changedFiles",
      "mergeable",
      "isDraft",
    ]),
    fetchGhJson(worktreePath, ["reviewDecision", "statusCheckRollup"]),
    fetchGhJson(worktreePath, ["comments", "reviews"]),
  ]);

  // Install / auth / no-PR errors short-circuit everything. We use the
  // first failure we see, preferring metadata (the call that's most
  // likely to surface "no PR").
  const firstFailure =
    !meta.ok ? meta.failure : !stateRes.ok ? stateRes.failure : !threads.ok ? threads.failure : null;
  if (firstFailure) {
    const code = ghFailureToErrorCode(firstFailure);
    if (code === "no_pr_for_branch") {
      // Definitively no PR — cache and return. The client can safely
      // tear the tab down on the next poll.
      const payload: PrResponse = { pr: null };
      cache.set(key, { fetchedAt: now, headSha, payload });
      return payload;
    }
    if (code === "gh_not_installed" || code === "gh_not_authenticated") {
      // Surface the error so the client can log it; we still cache
      // the negative result so we don't repeatedly spawn `gh` while
      // the user's environment is broken (issue #387 review feedback
      // — only overwrites the cache when there was no prior payload).
      const prior = cache.get(key);
      if (prior) {
        return prior.payload;
      }
      const payload: PrResponse = { pr: null, error: code };
      cache.set(key, { fetchedAt: now, headSha, payload });
      return payload;
    }
    // Uncategorized / transient failure (network error, timeout,
    // non-zero exit we don't recognize, invalid JSON envelope, …).
    // Returning `{ pr: null }` here is indistinguishable from "no PR
    // exists" to the client and would cause it to rip the tab out
    // and switch to Terminal. Prefer the most recent successful
    // payload instead — even if its `headSha` no longer matches —
    // so the user keeps seeing data through transient blips. The
    // 30s poll retries the live fetch; on success the cache catches
    // up (issue #387 review feedback).
    const prior = cache.get(key);
    if (prior) {
      return prior.payload;
    }
    return { pr: null };
  }

  const metaRaw = (meta as { ok: true; data: unknown }).data as RawPr;
  const stateRaw = (stateRes as { ok: true; data: unknown }).data as RawPr;
  const threadsRaw = (threads as { ok: true; data: unknown }).data as RawPr;
  const pr = normalizePr(mergePrParts(metaRaw, stateRaw, threadsRaw));
  const payload: PrResponse = pr ? { pr } : { pr: null };
  cache.set(key, { fetchedAt: now, headSha, payload });
  return payload;
}

/**
 * Test seam: clear the in-memory cache so route tests can assert
 * freshness after an explicit head change. Production code never
 * calls this.
 */
export function __resetPrCacheForTests(): void {
  cache.clear();
}

/**
 * Test seam: replace the `gh` runner with a stub for the duration of
 * a test. Returns a `dispose`-style function that restores the
 * default runner when called. Always pair with
 * {@link __resetPrCacheForTests} to avoid a previously-cached
 * payload leaking into a new test's stub.
 */
export function __setPrGhRunnerForTests(
  runner: GhRunner | null
): () => void {
  const previous = activeRunner;
  activeRunner = runner ?? defaultRunner;
  cache.clear();
  return () => {
    activeRunner = previous;
    cache.clear();
  };
}

/**
 * Test seam: put the {@link defaultRunner} back in place. Pair with
 * {@link __setPrGhRunnerForTests} if you need it later.
 */
export function __resetPrGhRunnerForTests(): void {
  activeRunner = defaultRunner;
  cache.clear();
}
