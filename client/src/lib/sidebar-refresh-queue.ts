export interface SidebarRefreshScopes {
  projects: string[];
  catchUpProjects: string[];
  sessions: Array<{ projectId: string; worktreeId: string }>;
}

/** Runs one sidebar write at a time. Events received during a run form the next batch. */
export class SidebarRefreshQueue {
  private pendingFull: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private pendingProjects = new Set<string>();
  private pendingCatchUpProjects = new Set<string>();
  private pendingSessions = new Set<string>();
  // Scopes covered by a queued full reload. Restore them if it fails.
  private coveredProjects = new Set<string>();
  private coveredCatchUpProjects = new Set<string>();
  private coveredSessions = new Set<string>();
  private running = false;

  constructor(
    private readonly runFull: () => Promise<void>,
    private readonly runTargets: (scopes: SidebarRefreshScopes) => Promise<void>,
  ) {}

  enqueueFull(): Promise<void> {
    // The next full snapshot covers every scope that has not started.
    for (const projectId of this.pendingProjects) this.coveredProjects.add(projectId);
    for (const projectId of this.pendingCatchUpProjects) this.coveredCatchUpProjects.add(projectId);
    for (const key of this.pendingSessions) this.coveredSessions.add(key);
    this.pendingProjects.clear();
    this.pendingCatchUpProjects.clear();
    this.pendingSessions.clear();
    const result = new Promise<void>((resolve, reject) => {
      this.pendingFull.push({ resolve, reject });
    });
    this.schedule();
    return result;
  }

  enqueueSession(projectId: string, worktreeId: string): void {
    const target = this.pendingFull.length ? this.coveredSessions : this.pendingSessions;
    target.add(`${projectId}\u0000${worktreeId}`);
    this.schedule();
  }

  enqueueProject(projectId: string): void {
    const target = this.pendingFull.length ? this.coveredProjects : this.pendingProjects;
    target.add(projectId);
    this.schedule();
  }

  enqueueCatchUpProject(projectId: string): void {
    const target = this.pendingFull.length ? this.coveredCatchUpProjects : this.pendingCatchUpProjects;
    target.add(projectId);
    this.schedule();
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => { void this.drain(); });
  }

  private async drain(): Promise<void> {
    try {
      while (this.pendingFull.length || this.pendingProjects.size || this.pendingCatchUpProjects.size || this.pendingSessions.size) {
        if (this.pendingFull.length) {
          const waiters = this.pendingFull.splice(0);
          const coveredProjects = this.coveredProjects;
          const coveredCatchUpProjects = this.coveredCatchUpProjects;
          const coveredSessions = this.coveredSessions;
          this.coveredProjects = new Set();
          this.coveredCatchUpProjects = new Set();
          this.coveredSessions = new Set();
          try {
            await this.runFull();
            waiters.forEach(({ resolve }) => resolve());
          } catch (error) {
            if (!this.pendingFull.length) {
              for (const id of coveredProjects) this.pendingProjects.add(id);
              for (const id of coveredCatchUpProjects) this.pendingCatchUpProjects.add(id);
              for (const key of coveredSessions) this.pendingSessions.add(key);
            } else {
              for (const id of coveredProjects) this.coveredProjects.add(id);
              for (const id of coveredCatchUpProjects) this.coveredCatchUpProjects.add(id);
              for (const key of coveredSessions) this.coveredSessions.add(key);
            }
            waiters.forEach(({ reject }) => reject(error));
          }
          continue;
        }
        const scopes: SidebarRefreshScopes = {
          projects: [...this.pendingProjects],
          catchUpProjects: [...this.pendingCatchUpProjects],
          sessions: [...this.pendingSessions].map((key) => {
            const split = key.indexOf("\u0000");
            return { projectId: key.slice(0, split), worktreeId: key.slice(split + 1) };
          }),
        };
        this.pendingProjects.clear();
        this.pendingCatchUpProjects.clear();
        this.pendingSessions.clear();
        try {
          await this.runTargets(scopes);
        } catch {
          // A failed batch must not block later refreshes.
        }
      }
    } finally {
      this.running = false;
      if (this.pendingFull.length || this.pendingProjects.size || this.pendingCatchUpProjects.size || this.pendingSessions.size) this.schedule();
    }
  }
}
