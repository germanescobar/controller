export interface SidebarRefreshScopes {
  projects: string[];
  sessions: Array<{ projectId: string; worktreeId: string }>;
}

/** Runs one sidebar write at a time. Events received during a run form the next batch. */
export class SidebarRefreshQueue {
  private pendingFull: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private pendingProjects = new Set<string>();
  private pendingSessions = new Set<string>();
  private running = false;

  constructor(
    private readonly runFull: () => Promise<void>,
    private readonly runTargets: (scopes: SidebarRefreshScopes) => Promise<void>,
  ) {}

  enqueueFull(): Promise<void> {
    // The next full snapshot covers every scope that has not started.
    this.pendingProjects.clear();
    this.pendingSessions.clear();
    const result = new Promise<void>((resolve, reject) => {
      this.pendingFull.push({ resolve, reject });
    });
    this.schedule();
    return result;
  }

  enqueueSession(projectId: string, worktreeId: string): void {
    if (this.pendingFull.length > 0) return;
    this.pendingSessions.add(`${projectId}\u0000${worktreeId}`);
    this.schedule();
  }

  enqueueProject(projectId: string): void {
    if (this.pendingFull.length > 0) return;
    this.pendingProjects.add(projectId);
    this.schedule();
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => { void this.drain(); });
  }

  private async drain(): Promise<void> {
    try {
      while (this.pendingFull.length || this.pendingProjects.size || this.pendingSessions.size) {
        if (this.pendingFull.length) {
          const waiters = this.pendingFull.splice(0);
          try {
            await this.runFull();
            waiters.forEach(({ resolve }) => resolve());
          } catch (error) {
            waiters.forEach(({ reject }) => reject(error));
          }
          continue;
        }
        const scopes: SidebarRefreshScopes = {
          projects: [...this.pendingProjects],
          sessions: [...this.pendingSessions].map((key) => {
            const split = key.indexOf("\u0000");
            return { projectId: key.slice(0, split), worktreeId: key.slice(split + 1) };
          }),
        };
        this.pendingProjects.clear();
        this.pendingSessions.clear();
        try {
          await this.runTargets(scopes);
        } catch {
          // A failed batch must not block later refreshes.
        }
      }
    } finally {
      this.running = false;
      if (this.pendingFull.length || this.pendingProjects.size || this.pendingSessions.size) this.schedule();
    }
  }
}
