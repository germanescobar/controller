import { useState, useEffect, useCallback } from "react";
import { Menu, X } from "lucide-react";
import { toast } from "sonner";
import { fetchProjects, type Project, type Worktree } from "./api.ts";
import { Sidebar } from "./components/sidebar.tsx";
import { SettingsDialog } from "./components/settings-dialog.tsx";
import { ProjectSetup } from "./pages/ProjectSetup.tsx";
import { EditProject } from "./pages/EditProject.tsx";
import { NewWorktree } from "./pages/NewWorktree.tsx";
import { SessionView } from "./pages/SessionView.tsx";

export type View =
  | { page: "empty" }
  | { page: "new-project" }
  | { page: "edit-project"; projectId: string }
  | { page: "new-worktree"; projectId: string }
  | { page: "session"; projectId: string; worktreeId?: string; sessionId?: string };

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

  const setView = (v: View) => {
    setViewState(v);
    localStorage.setItem("activeView", JSON.stringify(v));
  };

  const loadProjects = useCallback(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(loadProjects, [loadProjects]);

  const closeSidebar = () => setSidebarOpen(false);

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
  const sessionViewKey =
    activeView.page === "session"
      ? `${activeView.projectId}:${activeView.worktreeId ?? "main"}`
      : "non-session";

  return (
    <div className="dark flex h-dvh w-full bg-background text-foreground">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={closeSidebar}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
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
        />
      </div>

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
          <span className="ml-3 text-sm font-medium">
            Coding Orchestrator
          </span>
        </div>

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
          />
        )}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
