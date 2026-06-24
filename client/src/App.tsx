import { Component, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Archive, ArrowRight, Menu, Radar, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  archiveSession,
  fetchProjects,
  markSessionFocusDone,
  pinSessionFocus,
  subscribeProjectEvents,
  unpinSessionFocus,
  type Project,
  type ProjectEvent,
  type Worktree,
} from "./api.ts";
import { Sidebar, type FocusQueueItem } from "./components/sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ProjectSetup } from "./pages/ProjectSetup.tsx";
import { EditProject } from "./pages/EditProject.tsx";
import { NewWorktree } from "./pages/NewWorktree.tsx";
import { SessionView } from "./pages/SessionView.tsx";
import { SettingsPage, type SettingsSection } from "./pages/Settings.tsx";
import { useResizablePanel } from "./lib/useResizablePanel.ts";
import { useControllerModeShortcuts } from "./lib/useControllerModeShortcuts.ts";
import { pickNextFocusItem } from "./lib/focus-advance.ts";

/**
 * Time the focus-advance toast shows a "Moving to next..." countdown
 * before actually navigating. The countdown is what keeps the user
 * from losing sight of the message they just sent: the in-flight
 * bubble stays on screen for at least this long, and they can
 * cancel the advance with the **Stay** button or Esc.
 *
 * Single source of truth — do not introduce a second timing knob.
 */
const FOCUS_ADVANCE_COUNTDOWN_MS = 4000;

export interface PendingFocusAdvance {
  sentFromSessionId: string;
  next: FocusQueueItem;
  /** Epoch ms when the advance was scheduled. */
  scheduledAt: number;
}

function FocusAdvanceToast({
  scheduledAt,
  durationMs,
  onCancel,
}: {
  scheduledAt: number;
  durationMs: number;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  const elapsedMs = Math.max(0, now - scheduledAt);
  const progress = Math.min(1, elapsedMs / durationMs);
  const remainingProgress = Math.max(0, 1 - progress);
  const secondsRemaining = Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));

  return (
    <div className="w-80 overflow-hidden rounded-lg border border-blue-400/20 bg-[#151922] text-slate-100 shadow-xl shadow-black/35">
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 rounded-md border border-blue-400/15 bg-blue-400/10 p-1 text-blue-300">
            <ArrowRight className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-50">
              Advancing to next conversation
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              <span className="hidden md:inline">
                Press <span className="font-medium text-slate-200">S</span> to stay ·{" "}
                <span className="font-medium text-slate-200">N</span> to continue ·{" "}
              </span>
              <span>{secondsRemaining}s</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end md:hidden">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100"
          >
            Stay
          </button>
        </div>
      </div>
      <div className="h-1 bg-slate-700/80">
        <div
          className="h-full bg-blue-400 transition-[width] duration-200 ease-linear"
          style={{ width: `${remainingProgress * 100}%` }}
        />
      </div>
    </div>
  );
}

export type View =
  | { page: "empty" }
  | { page: "new-project" }
  | { page: "edit-project"; projectId: string }
  | { page: "new-worktree"; projectId: string }
  | { page: "session"; projectId: string; worktreeId?: string; sessionId?: string }
  | { page: "settings"; section: SettingsSection };

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
  const [completedSessions, setCompletedSessions] = useState<Set<string>>(new Set());
  const [controllerMode, setControllerMode] = useState(false);
  const [focusQueue, setFocusQueue] = useState<FocusQueueItem[]>([]);
  const [focusRefreshKey, setFocusRefreshKey] = useState(0);
  // Scheduled "advance to the next focus item" while a 4-second
  // countdown is showing in a toast. Set by
  // `handleFocusAdvanceAfterSend` after a send, cleared either by the
  // timer firing (then we navigate) or by any of the cancel paths
  // (S, Esc, manual nav, unmount). See issue #104.
  const [pendingFocusAdvance, setPendingFocusAdvance] =
    useState<PendingFocusAdvance | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const pendingFocusAdvanceRef = useRef<PendingFocusAdvance | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const advanceToastIdRef = useRef<string | number | null>(null);
  // The view to return to when settings is closed (the last non-settings view).
  const preSettingsViewRef = useRef<View>({ page: "empty" });

  const dismissAdvanceToast = () => {
    if (advanceToastIdRef.current === null) return;
    toast.dismiss(advanceToastIdRef.current);
    advanceToastIdRef.current = null;
  };

  const setView = (v: View) => {
    // Entering settings: remember the view we're leaving so closing returns there.
    if (v.page === "settings" && view.page !== "settings") {
      preSettingsViewRef.current = view;
    }
    setViewState(v);
    localStorage.setItem("activeView", JSON.stringify(v));
    // Any user-initiated navigation cancels a scheduled focus
    // advance. The countdown is opt-in: once the user picks a
    // different session, the timer is no longer their intent.
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    pendingFocusAdvanceRef.current = null;
    dismissAdvanceToast();
    setPendingFocusAdvance((current) => (current ? null : current));
  };

  const closeSidebar = () => setSidebarOpen(false);

  const handleFocusQueueChange = useCallback((queue: FocusQueueItem[]) => {
    setFocusQueue(queue);
  }, []);

  /**
   * Open a pinned focus item by switching the view to its session
   * and closing the mobile sidebar if it's open. Hoisted above
   * `commitPendingAdvance` so the countdown can reuse it.
   */
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

  /**
   * Commit a scheduled focus advance: navigate to the target session
   * and clear the pending state. Safe to call when nothing is pending
   * (it just no-ops).
   */
  const commitPendingAdvance = useCallback(() => {
    const pending = pendingFocusAdvanceRef.current;
    if (!pending) return;
    pendingFocusAdvanceRef.current = null;
    setPendingFocusAdvance(null);
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    dismissAdvanceToast();
    openFocusItem(pending.next);
  }, [openFocusItem]);

  /**
   * Cancel a scheduled focus advance: clear the pending state and
   * the timer. Safe to call when nothing is pending.
   */
  const cancelPendingAdvance = useCallback(() => {
    pendingFocusAdvanceRef.current = null;
    setPendingFocusAdvance(null);
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    dismissAdvanceToast();
  }, []);

  // Clear the countdown on unmount so a stale timer doesn't fire
  // after the component is gone (hot reload, view change, etc.).
  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      pendingFocusAdvanceRef.current = null;
      dismissAdvanceToast();
    };
  }, []);

  const loadProjects = useCallback(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(loadProjects, [loadProjects]);

  // Project lifecycle event stream (issue #210). Subscribes when an
  // active project is set, refetches the relevant slice of state when
  // an event lands. The events themselves are "the data on disk
  // changed" — debounce a burst (e.g. session-add + first user_message
  // + a title pin) into a single refetch so the sidebar doesn't
  // thrash.
  const [eventsRefreshKey, setEventsRefreshKey] = useState(0);
  const eventsDebounceRef = useRef<number | null>(null);
  const scheduleEventsRefetch = useCallback((event: ProjectEvent) => {
    if (eventsDebounceRef.current !== null) {
      window.clearTimeout(eventsDebounceRef.current);
    }
    eventsDebounceRef.current = window.setTimeout(() => {
      eventsDebounceRef.current = null;
      // Project-lifecycle events change the sidebar's project list;
      // the rest live under an active project so the sidebar's
      // `loadAll` picks them up. Bumping one key drives both.
      if (
        event.type === "project_added" ||
        event.type === "project_updated" ||
        event.type === "project_removed"
      ) {
        loadProjects();
      }
      setEventsRefreshKey((key) => key + 1);
    }, 50);
  }, [loadProjects]);
  useEffect(() => {
    if (!activeProjectId) return;
    const source = subscribeProjectEvents(activeProjectId, scheduleEventsRefetch);
    return () => {
      source.close();
      if (eventsDebounceRef.current !== null) {
        window.clearTimeout(eventsDebounceRef.current);
        eventsDebounceRef.current = null;
      }
    };
  }, [activeProjectId, scheduleEventsRefetch]);

  const handleControllerModeToggle = useCallback(() => {
    if (controllerMode) {
      setControllerMode(false);
      cancelPendingAdvance();
      return;
    }
    const firstItem = focusQueue[0];
    if (!firstItem) {
      toast.info("Add a session to in-flight mode to use Controller Mode");
      return;
    }
    setControllerMode(true);
    openFocusItem(firstItem);
  }, [controllerMode, focusQueue, openFocusItem, cancelPendingAdvance]);

  const handleControllerModeEnter = useCallback(() => {
    const firstItem = focusQueue[0];
    if (!firstItem) {
      toast.info("Add a session to in-flight mode to use Controller Mode");
      return;
    }
    setControllerMode(true);
    openFocusItem(firstItem);
  }, [focusQueue, openFocusItem]);

  const handleControllerModeExit = useCallback(() => {
    setControllerMode(false);
    // Exiting controller mode also cancels any pending advance — the
    // target session is no longer relevant once controller mode is off.
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    pendingFocusAdvanceRef.current = null;
    dismissAdvanceToast();
    setPendingFocusAdvance(null);
  }, []);

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
      : controllerMode
        ? { current: 0, total: focusQueue.length }
        : undefined;
  const currentFocusItem = currentFocusIndex >= 0 ? focusQueue[currentFocusIndex] : null;

  const handleFocusSkip = () => {
    // If a countdown is already scheduled, `N` (and the **Next**
    // button) commit it immediately rather than skipping to a
    // *third* session.
    if (pendingFocusAdvance) {
      commitPendingAdvance();
      return;
    }
    if (focusQueue.length === 0) {
      setControllerMode(false);
      toast.info("Focus queue is empty");
      return;
    }
    const nextIndex =
      currentFocusIndex >= 0 ? (currentFocusIndex + 1) % focusQueue.length : 0;
    openFocusItem(focusQueue[nextIndex]);
  };

  const handleToggleCurrentSessionPin = async () => {
    if (activeView.page !== "session" || !activeView.sessionId) return;
    const { projectId, worktreeId, sessionId } = activeView;
    const pinned = currentFocusIndex >= 0;

    try {
      if (pinned) {
        await unpinSessionFocus(projectId, sessionId, worktreeId);
      } else {
        await pinSessionFocus(projectId, sessionId, worktreeId);
      }
      setFocusRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update focus queue");
    }
  };

  const handleArchiveCurrentSession = () => {
    if (activeView.page !== "session" || !activeView.sessionId) return;
    setArchiveConfirmOpen(true);
  };

  const confirmArchiveCurrentSession = async () => {
    if (activeView.page !== "session" || !activeView.sessionId) return;
    const { projectId, worktreeId, sessionId } = activeView;

    try {
      await archiveSession(projectId, sessionId, worktreeId);
      setFocusQueue((prev) =>
        prev.filter(
          (item) =>
            !(
              item.projectId === projectId &&
              item.worktreeId === (worktreeId ?? item.worktreeId) &&
              item.session.id === sessionId
            )
        )
      );
      setFocusRefreshKey((key) => key + 1);
      loadProjects();
      setView({ page: "session", projectId, worktreeId });
      toast.success("Session archived");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive session");
    }
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
        setControllerMode(false);
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

  // After the user sends a message in controller mode, schedule an
  // advance to the next focus item rather than navigating
  // immediately. The user just committed a message, and bouncing
  // them away from the originating session before the in-flight
  // user bubble can render is what made the message look "lost"
  // (issue #104). The countdown gives them FOCUS_ADVANCE_COUNTDOWN_MS
  // to see the bubble, with S / Esc shortcuts for cancelling.
  //
  // The "sent from" session id is passed in so we can apply the
  // stay-put rule when the only pinned item is the one the user
  // just replied to (queue-of-one, no-op).
  const handleFocusAdvanceAfterSend = useCallback(
    (sentFromSessionId: string) => {
      if (!controllerMode) return;
      const next = pickNextFocusItem(focusQueue, sentFromSessionId);
      if (!next) return;
      // Replace any existing pending advance (the user sent again
      // before the previous countdown finished). The new origin
      // session is what matters; we restart the clock.
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
      dismissAdvanceToast();
      const pendingAdvance = {
        sentFromSessionId,
        next,
        scheduledAt: Date.now(),
      };
      pendingFocusAdvanceRef.current = pendingAdvance;
      setPendingFocusAdvance(pendingAdvance);
      advanceToastIdRef.current = toast.custom(
        () => (
          <FocusAdvanceToast
            scheduledAt={pendingAdvance.scheduledAt}
            durationMs={FOCUS_ADVANCE_COUNTDOWN_MS}
            onCancel={cancelPendingAdvance}
          />
        ),
        {
          duration: Infinity,
          position: "top-right",
          unstyled: true,
        },
      );
      advanceTimerRef.current = window.setTimeout(() => {
        commitPendingAdvance();
      }, FOCUS_ADVANCE_COUNTDOWN_MS);
    },
    [controllerMode, focusQueue, commitPendingAdvance, cancelPendingAdvance],
  );

  // Sidebar resizing
  const sidebarResize = useResizablePanel({
    storageKey: "sidebarWidth",
    defaultWidth: 256, // w-64
    minWidth: 180,
    maxWidth: 480,
  });

  // Controller Mode keyboard shortcuts (N / D / F / E). While an advance is
  // pending, S (or Esc) stays and N continues immediately (even while the
  // composer is focused). Esc only cancels when focus is not in an editable
  // element (issue #104).
  useControllerModeShortcuts({
    controllerMode,
    onSkip: handleFocusSkip,
    onDone: handleFocusDone,
    onEnter: handleControllerModeEnter,
    onExit: handleControllerModeExit,
    onCancelAdvance: pendingFocusAdvance ? cancelPendingAdvance : undefined,
    onCommitAdvance: pendingFocusAdvance ? commitPendingAdvance : undefined,
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
    projects.find((project) => project.id === mobileHeaderProjectId)?.name ?? "Controller";

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
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
            setView({ page: "settings", section: "agents" });
            closeSidebar();
          }}
          onFocusQueueChange={handleFocusQueueChange}
          controllerMode={controllerMode}
          onControllerModeToggle={handleControllerModeToggle}
          focusRefreshKey={focusRefreshKey}
          eventsRefreshKey={eventsRefreshKey}
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
          {activeView.page === "session" && activeView.sessionId && (
            <button
              onClick={handleToggleCurrentSessionPin}
              className={`ml-2 shrink-0 rounded-md p-1.5 transition-colors ${
                currentFocusIndex >= 0
                  ? "bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 hover:text-blue-200"
                  : "text-muted-foreground/50 opacity-50 hover:bg-transparent hover:text-muted-foreground/50"
              }`}
              title={currentFocusIndex >= 0 ? "Remove from in-flight" : "Add to in-flight"}
            >
              <Radar className="h-4 w-4" />
            </button>
          )}
          {activeView.page === "session" && activeView.sessionId && (
            <button
              onClick={handleArchiveCurrentSession}
              className="ml-2 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Archive session"
            >
              <Archive className="h-4 w-4" />
            </button>
          )}
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
            controllerMode={controllerMode}
            focusPosition={focusPosition}
            onFocusDone={handleFocusDone}
            onFocusSkip={handleFocusSkip}
            onFocusExit={handleControllerModeExit}
            onFocusPinnedChange={() => setFocusRefreshKey((key) => key + 1)}
            onTitleChange={() => setFocusRefreshKey((key) => key + 1)}
            onFocusAdvanceAfterSend={handleFocusAdvanceAfterSend}
            focusAdvanceCountdown={
              pendingFocusAdvance
                ? {
                    // SessionView only needs the origin to preserve
                    // the pending message and cancel if the user
                    // starts typing there again. The visible
                    // countdown lives in the toast.
                    sentFromSessionId: pendingFocusAdvance.sentFromSessionId,
                    onCancel: cancelPendingAdvance,
                  }
                : null
            }
          />
        )}

        {activeView.page === "settings" && (
          <SettingsPage
            section={activeView.section}
            onSectionChange={(section) => setView({ page: "settings", section })}
            onClose={() => setView(preSettingsViewRef.current)}
          />
        )}
        </AppErrorBoundary>

        <StatusBar />
      </main>

      <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this session?</AlertDialogTitle>
            <AlertDialogDescription>
              You can find it later in the archived sessions view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmArchiveCurrentSession}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
