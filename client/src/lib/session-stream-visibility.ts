interface SessionViewTarget {
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
}

/** A stream may attach a new session only while its originating view is open. */
export function isStreamVisible(
  currentView: SessionViewTarget,
  streamContext: SessionViewTarget | null,
  detectedSessionId: string | undefined,
  pendingAttachedSessionId: string | null,
): boolean {
  if (!streamContext) return false;
  if (
    currentView.projectId !== streamContext.projectId ||
    currentView.worktreeId !== streamContext.worktreeId
  ) return false;
  if (currentView.sessionId === streamContext.sessionId) return true;
  return currentView.sessionId == null &&
    pendingAttachedSessionId === streamContext.sessionId &&
    streamContext.sessionId === detectedSessionId;
}
