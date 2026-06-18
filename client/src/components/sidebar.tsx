import { useState, useEffect, useCallback, useMemo } from "react";
import {
  PenSquare,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  ChevronDown,
  ChevronRight,
  Settings,
  Trash2,
  Pencil,
  MessageSquare,
  Archive,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchSessions,
  fetchActiveRuntimes,
  fetchWorktrees,
  deleteProject,
  deleteWorktree,
  archiveSession,
  markSessionFocusDone,
  updateSessionTitle,
  type Project,
  type Session,
  type Worktree,
} from "../api.ts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

const SESSION_BATCH_SIZE = 5;

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeWorktreeId?: string;
  activeSessionId?: string;
  completedSessions?: Set<string>;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (
    projectId: string,
    sessionId: string,
    worktreeId?: string,
  ) => void;
  onNewThread: (projectId: string, worktreeId?: string) => void;
  onNewProject: () => void;
  onEditProject: (projectId: string) => void;
  onNewWorktree: (projectId: string) => void;
  onProjectsChanged: () => void;
  onSettings: () => void;
  onFocusQueueChange?: (queue: FocusQueueItem[]) => void;
  focusMode?: boolean;
  onFocusModeToggle?: () => void;
  focusRefreshKey?: number;
}

interface WorktreeWithSessions extends Worktree {
  sessions: Session[];
  isExpanded: boolean;
}

interface ProjectWithWorktrees extends Project {
  worktrees: WorktreeWithSessions[];
  isExpanded: boolean;
}

export interface FocusQueueItem {
  projectId: string;
  projectName: string;
  worktreeId: string;
  worktreeName: string;
  session: Session;
  active: boolean;
}

function CodexLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z" />
    </svg>
  );
}

function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function AdaLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  );
}

function SessionProviderIcon({
  provider,
  className,
}: {
  provider?: string;
  className?: string;
}) {
  // Ada is the default provider — sessions created by the Ada CLI don't
  // persist a `provider` field, so a missing/empty value means "ada".
  if (!provider || provider === "ada") {
    return <AdaLogo className={className} />;
  }
  if (provider === "codex") {
    return <CodexLogo className={className} />;
  }
  if (provider === "claude") {
    return <ClaudeLogo className={className} />;
  }
  return <MessageSquare className={className} />;
}

function worktreeVisibilityKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export function Sidebar({
  projects,
  activeProjectId,
  activeWorktreeId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
  onNewThread,
  onNewProject,
  onEditProject,
  onNewWorktree,
  onProjectsChanged,
  onSettings,
  onFocusQueueChange,
  focusMode = false,
  onFocusModeToggle,
  focusRefreshKey,
  completedSessions,
}: SidebarProps) {
  const [projectData, setProjectData] = useState<ProjectWithWorktrees[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(
    new Set(),
  );
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<
    Record<string, number>
  >({});
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<
    string | null
  >(null);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] = useState<{
    projectId: string;
    worktreeId: string;
    name: string;
  } | null>(null);
  const [renameSession, setRenameSession] = useState<{
    projectId: string;
    worktreeId: string;
    sessionId: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const focusQueue = useMemo<FocusQueueItem[]>(() => {
    return projectData
      .flatMap((project) =>
        project.worktrees.flatMap((worktree) =>
          worktree.sessions
            .filter((session) => Boolean(session.focusPinnedAt))
            .map((session) => ({
              projectId: project.id,
              projectName: project.name,
              worktreeId: worktree.id,
              worktreeName: worktree.name,
              session,
              active: activeSessionIds.has(session.id),
            })),
        ),
      )
      .sort((a, b) => {
        const aTime = new Date(
          a.session.focusPinnedAt ?? a.session.createdAt,
        ).getTime();
        const bTime = new Date(
          b.session.focusPinnedAt ?? b.session.createdAt,
        ).getTime();
        return aTime - bTime;
      });
  }, [activeSessionIds, projectData]);

  useEffect(() => {
    onFocusQueueChange?.(focusQueue);
  }, [focusQueue, onFocusQueueChange]);

  const refreshActiveSessions = useCallback(async () => {
    // One bulk request replaces the previous per-session /runtime polling loop
    // (which issued N requests every 2s for every non-archived session).
    const entries = await fetchActiveRuntimes().catch(() => []);
    setActiveSessionIds(
      new Set(entries.filter((entry) => entry.active).map((entry) => entry.sessionId)),
    );
  }, []);

  const loadAll = useCallback(async () => {
    const next = await Promise.all(
      projects.map(async (project) => {
        const worktrees = await fetchWorktrees(project.id);
        const wtWithSessions = await Promise.all(
          worktrees.map(async (wt) => {
            const sessions = await fetchSessions(project.id, wt.id);
            const existingProject = projectData.find(
              (p) => p.id === project.id,
            );
            const existingWt = existingProject?.worktrees.find(
              (w) => w.id === wt.id,
            );
            const isActiveWt =
              wt.id === activeWorktreeId ||
              (!activeWorktreeId &&
                wt.isMain &&
                project.id === activeProjectId);
            return {
              ...wt,
              sessions: sessions.filter((s) => !archivedIds.has(s.id)),
              isExpanded: existingWt?.isExpanded ?? isActiveWt,
            } satisfies WorktreeWithSessions;
          }),
        );
        const existing = projectData.find((p) => p.id === project.id);
        return {
          ...project,
          worktrees: wtWithSessions,
          isExpanded: existing?.isExpanded ?? project.id === activeProjectId,
        } satisfies ProjectWithWorktrees;
      }),
    );
    setProjectData(next);
    await refreshActiveSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId, activeWorktreeId, archivedIds]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll, focusRefreshKey]);

  useEffect(() => {
    if (activeSessionIds.size === 0) return;
    const interval = window.setInterval(() => {
      refreshActiveSessions().catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [activeSessionIds, refreshActiveSessions]);

  const toggleProject = (id: string) => {
    setProjectData((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isExpanded: !p.isExpanded } : p)),
    );
  };

  const toggleWorktree = (projectId: string, worktreeId: string) => {
    setProjectData((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              worktrees: p.worktrees.map((w) =>
                w.id === worktreeId ? { ...w, isExpanded: !w.isExpanded } : w,
              ),
            }
          : p,
      ),
    );
  };

  const showMoreSessions = (projectId: string, worktreeId: string) => {
    const key = worktreeVisibilityKey(projectId, worktreeId);
    setVisibleSessionCounts((prev) => ({
      ...prev,
      [key]: (prev[key] ?? SESSION_BATCH_SIZE) + SESSION_BATCH_SIZE,
    }));
  };

  const confirmDeleteProject = async () => {
    if (!confirmDeleteProjectId) return;
    await deleteProject(confirmDeleteProjectId);
    setConfirmDeleteProjectId(null);
    onProjectsChanged();
  };

  const confirmDeleteWorktreeAction = async () => {
    if (!confirmDeleteWorktree) return;
    const { projectId, worktreeId } = confirmDeleteWorktree;
    try {
      await deleteWorktree(projectId, worktreeId);
      setConfirmDeleteWorktree(null);
      await loadAll();
      toast.success("Worktree deleted");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete worktree",
      );
    }
  };

  const openRenameDialog = (
    projectId: string,
    worktreeId: string,
    session: Session,
  ) => {
    setRenameSession({ projectId, worktreeId, sessionId: session.id });
    setRenameDraft(session.title ?? "");
  };

  // Persist a renamed session title, updating local state optimistically so
  // the new title shows immediately without a full reload.
  const handleRename = async () => {
    if (!renameSession) return;
    const { projectId, worktreeId, sessionId } = renameSession;
    const next = renameDraft.trim();
    setSavingRename(true);
    try {
      const updated = await updateSessionTitle(
        projectId,
        sessionId,
        next,
        worktreeId,
      );
      setProjectData((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.id === worktreeId
                    ? {
                        ...w,
                        sessions: w.sessions.map((s) =>
                          s.id === sessionId
                            ? { ...s, title: updated.title }
                            : s,
                        ),
                      }
                    : w,
                ),
              }
            : p,
        ),
      );
      setRenameSession(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to rename conversation",
      );
    } finally {
      setSavingRename(false);
    }
  };

  const handleFocusDone = async (item: FocusQueueItem) => {
    try {
      await markSessionFocusDone(
        item.projectId,
        item.session.id,
        item.worktreeId,
      );
      toast.success("Session marked done");
      await loadAll();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update focus queue",
      );
    }
  };

  const formatTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  return (
    <aside className="flex h-full flex-col border-r border-border bg-sidebar" style={{ width: "100%" }}>
      <div className="flex flex-col gap-1 p-3">
        <button
          onClick={onNewProject}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <FolderPlus className="h-4 w-4" />
          <span>New project</span>
        </button>
      </div>

      <Separator />

      <ScrollArea className="flex-1 overflow-hidden px-3">
        <div className="flex items-center justify-between py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Pinned
          </span>
          {focusQueue.length > 0 ? (
            <button
              type="button"
              onClick={onFocusModeToggle}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                focusMode
                  ? "bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 hover:text-blue-200"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
              )}
              title={focusMode ? "Exit focus mode (E)" : "Start focus mode (F)"}
            >
              Focus Mode
            </button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 pb-3">
          {focusQueue.length === 0 ? (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              No pinned sessions
            </span>
          ) : (
            focusQueue.map((item) => (
              <div
                key={`${item.projectId}:${item.worktreeId}:${item.session.id}`}
                className="group/focus flex items-center"
              >
                <button
                  onClick={() =>
                    onSelectSession(
                      item.projectId,
                      item.session.id,
                      item.worktreeId,
                    )
                  }
                  className={cn(
                    "flex flex-1 items-start justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors min-w-0",
                    item.session.id === activeSessionId
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-start gap-2">
                    <SessionProviderIcon
                      provider={item.session.provider}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-left">
                        {item.session.title || item.session.id.slice(0, 8)}
                      </span>
                      <span className="block truncate text-left text-[11px] text-muted-foreground">
                        {item.projectName} / {item.worktreeName}
                      </span>
                    </span>
                  </span>
                  {item.active ? (
                    <Loader2 className="hidden h-3 w-3 shrink-0 animate-spin text-muted-foreground md:inline md:group-hover/focus:hidden" />
                  ) : null}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFocusDone(item);
                    }}
                    className="inline-flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors md:hidden md:group-hover/focus:inline-flex"
                    title="Mark done"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                </button>
              </div>
            ))
          )}
        </div>

        <Separator />

        <div className="flex items-center justify-between py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Projects
          </span>
        </div>

        <div className="flex flex-col gap-1 pb-3">
          {projectData.length === 0 ? (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              No projects yet
            </span>
          ) : (
            projectData.map((project) => (
              <div key={project.id}>
                <div className="group flex items-center">
                  <button
                    onClick={() => {
                      toggleProject(project.id);
                      onSelectProject(project.id);
                    }}
                    className={cn(
                      "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors min-w-0",
                      project.id === activeProjectId
                        ? "text-sidebar-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                    )}
                  >
                    {project.isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{project.name}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewWorktree(project.id);
                    }}
                    title="New worktree"
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                  >
                    <GitBranchPlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditProject(project.id);
                    }}
                    title="Edit project"
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteProjectId(project.id);
                    }}
                    title="Delete project"
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {project.isExpanded && (
                  <div className="ml-4 flex flex-col">
                    {project.worktrees.length === 0 ? (
                      <span className="px-4 py-1.5 text-xs text-muted-foreground">
                        No worktrees
                      </span>
                    ) : (
                      project.worktrees.map((worktree) => {
                        const storedVisibleSessionCount =
                          visibleSessionCounts[
                            worktreeVisibilityKey(project.id, worktree.id)
                          ] ?? SESSION_BATCH_SIZE;
                        const activeSessionIndex = worktree.sessions.findIndex(
                          (session) => session.id === activeSessionId,
                        );
                        const visibleSessionCount =
                          activeSessionIndex >= 0
                            ? Math.max(
                                storedVisibleSessionCount,
                                activeSessionIndex + 1,
                              )
                            : storedVisibleSessionCount;
                        const visibleSessions = worktree.sessions.slice(
                          0,
                          visibleSessionCount,
                        );
                        const remainingSessionCount =
                          worktree.sessions.length - visibleSessions.length;

                        return (
                          <div key={worktree.id}>
                            <div className="group/worktree flex items-center">
                              <button
                                onClick={() =>
                                  toggleWorktree(project.id, worktree.id)
                                }
                                className={cn(
                                  "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors min-w-0",
                                  worktree.id === activeWorktreeId
                                    ? "text-sidebar-foreground"
                                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                                )}
                              >
                                {worktree.isExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {worktree.name}
                                  {worktree.setupExitCode != null &&
                                    worktree.setupExitCode !== 0 && (
                                      <span
                                        className="ml-1 text-destructive"
                                        title="Setup failed"
                                      >
                                        !
                                      </span>
                                    )}
                                </span>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onNewThread(project.id, worktree.id);
                                }}
                                title="New session"
                                className="opacity-100 md:opacity-0 md:group-hover/worktree:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                              >
                                <PenSquare className="h-3.5 w-3.5" />
                              </button>
                              {!worktree.isMain && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDeleteWorktree({
                                      projectId: project.id,
                                      worktreeId: worktree.id,
                                      name: worktree.name,
                                    });
                                  }}
                                  title="Delete worktree"
                                  className="opacity-100 md:opacity-0 md:group-hover/worktree:opacity-100 rounded p-1 text-muted-foreground hover:text-destructive transition-all"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>

                            {worktree.isExpanded && (
                              <div className="ml-4 flex flex-col">
                                {worktree.sessions.length === 0 ? (
                                  <span className="px-4 py-1.5 text-xs text-muted-foreground">
                                    No sessions
                                  </span>
                                ) : (
                                  <>
                                    {visibleSessions.map((session) => (
                                      <div
                                        key={session.id}
                                        className="group/session flex items-center"
                                      >
                                        <button
                                          onClick={() =>
                                            onSelectSession(
                                              project.id,
                                              session.id,
                                              worktree.id,
                                            )
                                          }
                                          className={cn(
                                            "flex flex-1 items-center justify-between gap-3 rounded-md px-4 py-1.5 text-sm transition-colors min-w-0",
                                            session.id === activeSessionId
                                              ? "bg-sidebar-accent text-sidebar-foreground"
                                              : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                                          )}
                                        >
                                          <span className="flex min-w-0 flex-1 items-center gap-2 truncate pr-2">
                                            <SessionProviderIcon
                                              provider={session.provider}
                                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                            />
                                            <span className="truncate">
                                              {session.title ||
                                                session.id.slice(0, 8)}
                                            </span>
                                            {completedSessions?.has(
                                              session.id,
                                            ) && (
                                              <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                                            )}
                                          </span>
                                          {activeSessionIds.has(session.id) ? (
                                            <Loader2 className="hidden h-3 w-3 shrink-0 animate-spin text-muted-foreground md:inline md:group-hover/session:hidden" />
                                          ) : (
                                            <span className="hidden shrink-0 text-xs text-muted-foreground md:inline md:group-hover/session:hidden">
                                              {formatTime(session.lastActiveAt)}
                                            </span>
                                          )}
                                          <span
                                            role="button"
                                            tabIndex={0}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              openRenameDialog(
                                                project.id,
                                                worktree.id,
                                                session,
                                              );
                                            }}
                                            className="inline-flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors md:hidden md:group-hover/session:inline-flex"
                                            title="Rename conversation"
                                          >
                                            <Pencil className="h-3.5 w-3.5" />
                                          </span>
                                          <span
                                            role="button"
                                            tabIndex={0}
                                            onClick={async (e) => {
                                              e.stopPropagation();
                                              setArchivedIds((prev) =>
                                                new Set(prev).add(session.id),
                                              );
                                              setProjectData((prev) =>
                                                prev.map((p) =>
                                                  p.id === project.id
                                                    ? {
                                                        ...p,
                                                        worktrees:
                                                          p.worktrees.map(
                                                            (w) =>
                                                              w.id ===
                                                              worktree.id
                                                                ? {
                                                                    ...w,
                                                                    sessions:
                                                                      w.sessions.filter(
                                                                        (s) =>
                                                                          s.id !==
                                                                          session.id,
                                                                      ),
                                                                  }
                                                                : w,
                                                          ),
                                                      }
                                                    : p,
                                                ),
                                              );
                                              toast.success("Session archived");
                                              await archiveSession(
                                                project.id,
                                                session.id,
                                                worktree.id,
                                              );
                                            }}
                                            className="inline-flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors md:hidden md:group-hover/session:inline-flex"
                                            title="Archive session"
                                          >
                                            <Archive className="h-3.5 w-3.5" />
                                          </span>
                                        </button>
                                      </div>
                                    ))}
                                    {remainingSessionCount > 0 && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          showMoreSessions(
                                            project.id,
                                            worktree.id,
                                          )
                                        }
                                        className="mx-2 mt-1 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                                      >
                                        Show more
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />
      <div className="p-3">
        <button
          onClick={onSettings}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </button>
      </div>

      <Dialog
        open={!!confirmDeleteProjectId}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteProjectId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {projectData.find((p) => p.id === confirmDeleteProjectId)?.name}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={confirmDeleteProject}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmDeleteWorktree}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteWorktree(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete worktree</DialogTitle>
            <DialogDescription>
              Delete worktree{" "}
              <span className="font-medium text-foreground">
                {confirmDeleteWorktree?.name}
              </span>
              ? This removes the directory from disk. The git branch is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={confirmDeleteWorktreeAction}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renameSession}
        onOpenChange={(open) => {
          if (!open && !savingRename) setRenameSession(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              Give this conversation a title to help you find it later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRename();
            }}
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="Untitled conversation"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <DialogFooter className="mt-4">
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={savingRename}>
                {savingRename ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
