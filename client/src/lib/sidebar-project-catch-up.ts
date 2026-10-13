import type { SessionSummary, Worktree } from "../api.ts";

export interface CatchUpCommit {
  attemptId: number;
  fullLoadVersion: number;
}

export function isCurrentCatchUpCommit(
  commit: CatchUpCommit | undefined,
  attemptId: number,
  fullLoadVersion: number,
  fullLoadInFlight: boolean,
): boolean {
  return (
    !fullLoadInFlight &&
    commit?.attemptId === attemptId &&
    commit.fullLoadVersion === fullLoadVersion
  );
}

/** Reconcile a project that may have missed events while it was inactive. */
export async function fetchProjectSessionSnapshot(
  projectId: string,
  getWorktrees: (projectId: string) => Promise<Worktree[]>,
  getSessions: (projectId: string, worktreeId: string) => Promise<SessionSummary[]>,
): Promise<Array<{ worktree: Worktree; sessions: SessionSummary[] }>> {
  const worktrees = await getWorktrees(projectId);
  return Promise.all(
    worktrees.map(async (worktree) => ({
      worktree,
      sessions: await getSessions(projectId, worktree.id),
    })),
  );
}

/** Retry when a lifecycle event arrives during the snapshot fetch. */
export async function fetchStableProjectSessionSnapshot(
  projectId: string,
  getGeneration: () => number,
  isCancelled: () => boolean,
  getWorktrees: (projectId: string) => Promise<Worktree[]>,
  getSessions: (projectId: string, worktreeId: string) => Promise<SessionSummary[]>,
): Promise<Array<{ worktree: Worktree; sessions: SessionSummary[] }> | null> {
  while (!isCancelled()) {
    const generation = getGeneration();
    const snapshot = await fetchProjectSessionSnapshot(
      projectId,
      getWorktrees,
      getSessions,
    );
    if (isCancelled()) return null;
    if (getGeneration() === generation) return snapshot;
  }
  return null;
}

export function mergeProjectSessionSnapshot(
  existing: Array<Worktree & { sessions: SessionSummary[]; isExpanded: boolean }>,
  snapshot: Array<{ worktree: Worktree; sessions: SessionSummary[] }>,
  archivedIds: ReadonlySet<string>,
  isDefaultExpanded: (worktree: Worktree) => boolean,
): Array<Worktree & { sessions: SessionSummary[]; isExpanded: boolean }> {
  const existingById = new Map(existing.map((worktree) => [worktree.id, worktree]));
  return snapshot.map(({ worktree, sessions }) => ({
    ...worktree,
    sessions: sessions.filter((session) => !archivedIds.has(session.id)),
    isExpanded:
      existingById.get(worktree.id)?.isExpanded ?? isDefaultExpanded(worktree),
  }));
}
