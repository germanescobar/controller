import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { updateWorktree, type Worktree } from "./worktrees.js";

/*
 * Keeps each worktree's linked PR in sync with GitHub off the request path.
 * Listing worktrees must not wait on the network, so callers render the
 * persisted `linkedPr` and receive changed rows through `onUpdated`.
 * Persisting the PR lets a removed worktree keep its last known PR label.
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
    const patch = linkedPrPatch(worktree, pullRequests);
    if (!patch) continue;
    const updated = await updateWorktree(worktree.id, patch);
    if (updated) onUpdated(updated);
  }
}

/*
 * A newly merged PR finishes the task; a closed unmerged PR does not.
 * Only the transition finishes it, so a user who reopens the task by
 * hand is not overridden on the next sync.
 */
export function linkedPrPatch(
  worktree: Worktree,
  pullRequests: Map<string, LinkedPr>
): Pick<Worktree, "linkedPr" | "taskStatus"> | null {
  if (worktree.isMain || worktree.presence === "removed" || !worktree.branch) return null;
  const linkedPr = pullRequests.get(worktree.branch);
  if (!linkedPr) return null;
  const previous = worktree.linkedPr;
  if (previous?.number === linkedPr.number && previous.state === linkedPr.state) return null;
  const newlyMerged = linkedPr.state === "MERGED" && previous?.state !== "MERGED";
  return newlyMerged ? { linkedPr, taskStatus: "finished" } : { linkedPr };
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
