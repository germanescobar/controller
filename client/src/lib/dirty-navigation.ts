interface NavigationView {
  page: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
}

/** SessionView is keyed by project and worktree, so only these moves discard its editor. */
export function editorWillUnmount(current: NavigationView, next: NavigationView): boolean {
  return current.page === "session" && (
    next.page !== "session" ||
    next.projectId !== current.projectId ||
    next.worktreeId !== current.worktreeId
  );
}

/** An earlier confirmation covers only the draft revision visible when it was accepted. */
export function confirmNewEditsAfterAwait(
  approvedRevision: number,
  currentRevision: number,
  wasDirtyAtApproval: boolean,
  dirty: boolean,
  confirm: () => boolean,
): boolean {
  return !dirty || (wasDirtyAtApproval && approvedRevision === currentRevision) || confirm();
}
