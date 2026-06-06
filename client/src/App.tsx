import { Component, useState, useEffect, useCallback, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { toast } from "sonner";
import { fetchProjects, markSessionFocusDone, type Project, type Worktree } from "./api.ts";
import { Sidebar, type FocusQueueItem } from "./components/sidebar.tsx";
import { SettingsDialog } from "./components/settings-dialog.tsx";
import { ProjectSetup } from "./pages/ProjectSetup.tsx";
import { EditProject } from "./pages/EditProject.tsx";
import { NewWorktree } from "./pages/NewWorktree.tsx";
import { SessionView } from "./pages/SessionView.tsx";
import { useResizablePanel } from "./lib/useResizablePanel.ts";

export type View =
  | { page: "empty" }
  | { page: "new-project" }
  | { page: "edit-project"; projectId: string }
  | { page: "new-worktree"; projectId: string }
  | { page: "session"; projectId: string; worktreeId?: string; sessionId?: string };

class AppErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <div className="text-sm font-medium text-destructive-foreground">
            This view crashed while rendering.
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-xs text-accent-foreground"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

function loadSavedView(): View {
  try {
    const saved = localStorage.getItem("activeView");
    if (saved) return JSON.parse(saved) as View;
  } catch {}
  return { page: "empty" };
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setViewState] = useState<View>(loadSavedView);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const saved = loadSavedView();
    return saved.page === "session" ? saved.projectId : null;
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [completedSessions, setCompletedSessions] = useState<Set<string>>(new Set());
  const [focusMode, setFocusMode] = useState(false);
  const [focusQueue, setFocusQueue] = useState<FocusQueueItem[]>([]);
  const [focusRefreshKey, setFocusRefreshKey] = useState(0);

  const setView = (v: View) => {
    setViewState(v);
    localStorage.setItem("activeView", JSON.stringify(v));
  };

  const loadProjects = useCallback(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(loadProjects, [loadProjects]);

  const closeSidebar = () => setSidebarOpen(false);

  const handleFocusQueueChange = useCallback((queue: FocusQueueItem[]) => {
    setFocusQueue(queue);
  }, []);

  const openFocusItem = useCallback((item: FocusQueueItem) => {
    setActiveProjectId(item.projectId);
    setView({
      page: "session",
      projectId: item.projectId,
      worktreeId: item.worktreeId,
      sessionId: item.session.id,
    });
    closeSidebar();
  }, []);

  const handleFocusModeToggle = useCallback(() => {
    if (focusMode) {
      setFocusMode(false);
      return;
    }
    const firstItem = focusQueue[0];
    if (!firstItem) {
      toast.info("Pin a session to use focus mode");
      return;
    }
    setFocusMode(true);
    openFocusItem(firstItem);
  }, [focusMode, focusQueue, openFocusItem]);

  const handleSelectProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId });
  };

  const handleSelectSession = (
    projectId: string,
    sessionId: string,
    worktreeId?: string
  ) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId, worktreeId, sessionId });
    setCompletedSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    closeSidebar();
  };

  const handleNewThread = (projectId: string, worktreeId?: string) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId, worktreeId });
    closeSidebar();
  };

  const handleProjectCreated = () => {
    loadProjects();
    setView({ page: "empty" });
    closeSidebar();
  };

  const handleProjectSaved = (project: Project) => {
    loadProjects();
    setView({ page: "session", projectId: project.id });
    closeSidebar();
  };

  const handleWorktreeCreated = (projectId: string, worktree: Worktree) => {
    loadProjects();
    setView({ page: "session", projectId, worktreeId: worktree.id });
    closeSidebar();
  };

  const activeView = view;
  const currentFocusIndex =
    activeView.page === "session" && activeView.sessionId
      ? focusQueue.findIndex(
          (item) =>
            item.projectId === activeView.projectId &&
            item.worktreeId === (activeView.worktreeId ?? item.worktreeId) &&
            item.session.id === activeView.sessionId
        )
      : -1;
  const focusPosition =
    currentFocusIndex >= 0
      ? { current: currentFocusIndex + 1, total: focusQueue.length }
      : focusMode
        ? { current: 0, total: focusQueue.length }
        : undefined;
  const currentFocusItem = currentFocusIndex >= 0 ? focusQueue[currentFocusIndex] : null;

  const handleFocusSkip = () => {
    if (focusQueue.length === 0) {
      setFocusMode(false);
      toast.info("Focus queue is empty");
      return;
    }
    const nextIndex =
      currentFocusIndex >= 0 ? (currentFocusIndex + 1) % focusQueue.length : 0;
    openFocusItem(focusQueue[nextIndex]);
  };

  const handleFocusDone = async () => {
    if (activeView.page !== "session" || !activeView.sessionId) return;
    const projectId = activeView.projectId;
    const worktreeId = currentFocusItem?.worktreeId ?? activeView.worktreeId;
    const sessionId = activeView.sessionId;

    try {
      await markSessionFocusDone(projectId, sessionId, worktreeId);
      const nextQueue = focusQueue.filter(
        (item) =>
          !(
            item.projectId === projectId &&
            item.worktreeId === worktreeId &&
            item.session.id === sessionId
          )
      );
      setFocusQueue(nextQueue);
      setFocusRefreshKey((key) => key + 1);

      if (nextQueue.length === 0) {
        setFocusMode(false);
        toast.success("Focus queue complete");
        return;
      }

      const nextIndex =
        currentFocusIndex >= 0
          ? currentFocusIndex % nextQueue.length
          : 0;
      openFocusItem(nextQueue[nextIndex]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update focus queue");
    }
  };

  // Sidebar resizing
  const sidebarResize = useResizablePanel({
    storageKey: "sidebarWidth",
    defaultWidth: 256, // w-64
    minWidth: 180,
    maxWidth: 480,
  });

  const sessionViewKey =
    activeView.page === "session"
      ? `${activeView.projectId}:${activeView.worktreeId ?? "main"}`
      : "non-session";
  const mobileHeaderProjectId =
    activeView.page === "session" ||
    activeView.page === "edit-project" ||
    activeView.page === "new-worktree"
      ? activeView.projectId
      : null;
  const mobileHeaderTitle =
    projects.find((project) => project.id === mobileHeaderProjectId)?.name ?? "Coding Orchestrator";

  return (
    <div className="dark flex h-dvh w-full bg-background text-foreground">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={closeSidebar}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ width: `${sidebarResize.width}px`, minWidth: `${sidebarResize.width}px` }}
      >
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeWorktreeId={activeView.page === "session" ? activeView.worktreeId : undefined}
          activeSessionId={activeView.page === "session" ? activeView.sessionId : undefined}
          completedSessions={completedSessions}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onNewThread={handleNewThread}
          onNewProject={() => {
            setView({ page: "new-project" });
            closeSidebar();
          }}
          onEditProject={(projectId) => {
            setView({ page: "edit-project", projectId });
            closeSidebar();
          }}
          onNewWorktree={(projectId) => {
            setView({ page: "new-worktree", projectId });
            closeSidebar();
          }}
          onProjectsChanged={loadProjects}
          onSettings={() => {
            setSettingsOpen(true);
            closeSidebar();
          }}
          onFocusQueueChange={handleFocusQueueChange}
          focusMode={focusMode}
          onFocusModeToggle={handleFocusModeToggle}
          focusRefreshKey={focusRefreshKey}
        />
      </div>

      {/* Sidebar resize handle — desktop only */}
      <div
        {...sidebarResize.handleProps}
        className={`hidden md:flex w-1.5 cursor-col-resize shrink-0 items-center justify-center bg-transparent hover:bg-border/50 active:bg-border transition-colors ${
          sidebarResize.dragging ? "bg-border" : ""
        }`}
      />

      <main className="flex flex-1 flex-col min-h-0 min-w-0">
        <div className="flex h-12 shrink-0 items-center border-b border-border bg-background px-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {sidebarOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
          <span className="ml-3 min-w-0 flex-1 truncate text-sm font-medium">
            {mobileHeaderTitle}
          </span>
        </div>

        <AppErrorBoundary resetKey={JSON.stringify(activeView)}>
        {activeView.page === "empty" && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="text-center">
              <h2 className="text-lg font-medium text-muted-foreground">
                Select a project or create a new one
              </h2>
            </div>
          </div>
        )}

        {activeView.page === "new-project" && (
          <ProjectSetup
            onCreated={handleProjectCreated}
            onCancel={() => setView({ page: "empty" })}
          />
        )}

        {activeView.page === "edit-project" && (() => {
          const project = projects.find((p) => p.id === activeView.projectId);
          if (!project) return null;
          return (
            <EditProject
              project={project}
              onSaved={handleProjectSaved}
              onCancel={() => setView({ page: "session", projectId: activeView.projectId })}
            />
          );
        })()}

        {activeView.page === "new-worktree" && (() => {
          const project = projects.find((p) => p.id === activeView.projectId);
          if (!project) return null;
          return (
            <NewWorktree
              project={project}
              onCreated={(worktree) => handleWorktreeCreated(activeView.projectId, worktree)}
              onCancel={() => setView({ page: "session", projectId: activeView.projectId })}
            />
          );
        })()}

        {activeView.page === "session" && (
          <SessionView
            key={sessionViewKey}
            projectId={activeView.projectId}
            sessionId={activeView.sessionId}
            worktreeId={activeView.worktreeId}
            project={projects.find((p) => p.id === activeView.projectId)}
            onSessionCreated={(sessionId) => {
              setView({
                page: "session",
                projectId: activeView.projectId,
                worktreeId: activeView.worktreeId,
                sessionId,
              });
              loadProjects();
            }}
            onBackgroundComplete={(sessionId) => {
              setCompletedSessions((prev) => new Set(prev).add(sessionId));
              loadProjects();
              toast.success("Session completed", {
                description: "A background session has finished.",
                action: {
                  label: "View",
                  onClick: () =>
                    handleSelectSession(activeView.projectId, sessionId, activeView.worktreeId),
                },
              });
            }}
            focusMode={focusMode}
            focusPosition={focusPosition}
            onFocusDone={handleFocusDone}
            onFocusSkip={handleFocusSkip}
            onFocusExit={() => setFocusMode(false)}
            onFocusPinnedChange={() => setFocusRefreshKey((key) => key + 1)}
          />
        )}
        </AppErrorBoundary>
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
