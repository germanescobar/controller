import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { updateWorktree, type Worktree } from "./worktrees.js";

/*
 * Keeps each worktree's linked PR in sync with GitHub off the request path.
 * Listing worktrees must not wait on the network, so callers render the
 * persisted `linkedPr` and receive changed rows through `onUpdated`.
 * Persisting the PR lets a removed worktree keep its last known PR label.
 * The PR follows the branch currently checked out in the worktree, not the
 * branch recorded at creation, matching what the PR panel resolves.
 */

type LinkedPr = NonNullable<Worktree["linkedPr"]>;

interface PullRequestRow {
  number: number;
  state: LinkedPr["state"];
  url: string;
  headRefName: string;
  isCrossRepository: boolean;
}

const execFileAsync = promisify(execFile);
const REFRESH_INTERVAL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const lastRefreshAt = new Map<string, number>();
const inFlight = new Set<string>();

/** Start a throttled background PR sync for one project's worktrees. */
export function refreshWorktreePullRequests(
  projectPath: string,
  worktrees: Worktree[],
  onUpdated: (worktree: Worktree) => void
): void {
  const last = lastRefreshAt.get(projectPath) ?? 0;
  if (inFlight.has(projectPath) || Date.now() - last < REFRESH_INTERVAL_MS) return;
  inFlight.add(projectPath);
  lastRefreshAt.set(projectPath, Date.now());
  syncPullRequests(projectPath, worktrees, onUpdated)
    .catch((err) => {
      console.warn(`PR sync skipped for ${projectPath}: ${(err as Error).message}`);
    })
    .finally(() => inFlight.delete(projectPath));
}

async function syncPullRequests(
  projectPath: string,
  worktrees: Worktree[],
  onUpdated: (worktree: Worktree) => void
): Promise<void> {
  const pullRequests = await listPullRequestsByBranch(projectPath);
  for (const worktree of worktrees) {
    if (worktree.isMain || worktree.presence !== "active") continue;
    const branch = await currentBranch(worktree.path);
    if (branch === undefined) continue;
    const patch = linkedPrPatch(worktree, branch, pullRequests);
    if (!patch) continue;
    const updated = await updateWorktree(worktree.id, patch);
    if (updated) onUpdated(updated);
  }
}

/*
 * The change to apply to a worktree's PR for the branch it has checked out
 * (`null` when detached), or `null` when nothing changed. A branch with no PR
 * clears a previously recorded one.
 */
export function linkedPrPatch(
  worktree: Worktree,
  branch: string | null,
  pullRequests: Map<string, LinkedPr>
): Pick<Worktree, "linkedPr"> | null {
  const linkedPr = branch ? pullRequests.get(branch) : undefined;
  const previous = worktree.linkedPr;
  if (!linkedPr) return previous ? { linkedPr: undefined } : null;
  if (previous?.number === linkedPr.number && previous.state === linkedPr.state) return null;
  return { linkedPr };
}

/*
 * The branch checked out in a worktree: `null` when HEAD is detached, and
 * `undefined` when git can't tell, so the caller leaves the PR untouched.
 */
async function currentBranch(worktreePath: string): Promise<string | null | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    const branch = stdout.trim();
    return branch === "HEAD" ? null : branch;
  } catch (err) {
    console.warn(`Could not read the branch of ${worktreePath}: ${(err as Error).message}`);
    return undefined;
  }
}

async function listPullRequestsByBranch(projectPath: string): Promise<Map<string, LinkedPr>> {
  const { stdout } = await execFileAsync("gh", [
    "pr", "list", "--state", "all", "--limit", "500",
    "--json", "number,state,url,headRefName,isCrossRepository",
  ], { cwd: projectPath, timeout: GH_TIMEOUT_MS });
  const rows = JSON.parse(stdout) as PullRequestRow[];
  const byBranch = new Map<string, LinkedPr>();
  // `gh pr list` returns newest first; fork PRs can reuse local branch names.
  for (const row of rows) {
    if (row.isCrossRepository || byBranch.has(row.headRefName)) continue;
    byBranch.set(row.headRefName, { number: row.number, state: row.state, url: row.url });
  }
  return byBranch;
}
