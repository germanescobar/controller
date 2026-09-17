/*
 * Helpers for rendering coordinator sessions as a parent/child
 * subtree (issue #351).
 *
 * `SessionSummary` already carries `parentId` on the wire (it's
 * the same field `sessions start --parent` writes; the cross-
 * session `sessions send` route also persists it). The sidebar
 * gets a flat list per worktree, but a parent can spawn children
 * from any other worktree in the same project, and those children
 * land on different `worktree.sessions` arrays in the sidebar's
 * data shape.
 *
 * The sidebar can't merge two worktrees into one tree without
 * breaking the worktree-collapse UX, so v1 renders children on
 * the *same worktree as their parent only*. A future
 * cross-worktree subtree is out of scope per the "Decisions"
 * section of issue #351 (no recursion).
 *
 * The helpers here are pure functions over the wire shape so
 * they can be unit-tested without a renderer.
 */

export interface SessionLike {
  id: string;
  parentId?: string | null;
}

/**
 * Group a flat session list into a `{ roots, childrenByParent }`
 * shape. Roots are the sessions that have no `parentId`
 * (top-level) OR whose parent is not in the supplied list
 * (orphans — the parent was archived or never existed in this
 * snapshot; show them at the top level rather than hiding them).
 *
 * `childrenByParent.get(parentId)` returns children in the order
 * they appear in the input list; the caller decides whether to
 * sort.
 *
 * The function never throws on a malformed input — sessions
 * with a non-string `parentId` are treated as roots. The
 * grouping is therefore idempotent: calling it with the same
 * input always returns the same shape, so React can cache the
 * result via `useMemo`.
 */
export function groupSessionsByParent<T extends SessionLike>(
  sessions: readonly T[]
): {
  roots: T[];
  childrenByParent: Map<string, T[]>;
} {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (typeof session.id === "string") ids.add(session.id);
  }
  const roots: T[] = [];
  const childrenByParent = new Map<string, T[]>();
  for (const session of sessions) {
    if (!session || typeof session.id !== "string") continue;
    const parentId =
      typeof session.parentId === "string" && session.parentId
        ? session.parentId
        : null;
    // Orphans (parent known but not in this list) and roots (no
    // parent at all) both go to the top level. The sidebar can't
    // nest under a missing parent, and silently hiding them
    // would be worse — the user would never know a child is
    // orphaned.
    if (parentId && ids.has(parentId)) {
      let bucket = childrenByParent.get(parentId);
      if (!bucket) {
        bucket = [];
        childrenByParent.set(parentId, bucket);
      }
      bucket.push(session);
    } else {
      roots.push(session);
    }
  }
  return { roots, childrenByParent };
}

/**
 * Default expansion state for the sidebar subtree.
 *
 * Issue #351 calls out a specific UX choice: parents with
 * `active` children are expanded by default (the agent just
 * sent work to them — they should be visible); parents whose
 * children are all `queued` or `archived` start collapsed.
 *
 * `active` and `archived` are optional fields. When neither is
 * present (legacy summaries, server without the new fields),
 * the function defaults to `false` so the sidebar matches the
 * pre-#351 behavior — every parent collapsed. Operators who
 * want everything expanded can override via the per-worktree
 * toggle in the UI.
 */
export function isSubtreeExpandedByDefault<
  T extends SessionLike & {
    status?: string | null;
    archivedAt?: string | null;
  }
>(children: readonly T[]): boolean {
  if (!Array.isArray(children) || children.length === 0) return false;
  let hasActive = false;
  for (const child of children) {
    if (typeof child?.archivedAt === "string" && child.archivedAt) continue;
    if (typeof child?.status === "string" && child.status === "active") {
      hasActive = true;
      break;
    }
  }
  return hasActive;
}
