import { Component, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Archive, ArrowRight, Menu, X } from "lucide-react";
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
  subscribeProjectEvents,
  type Project,
  type ProjectEvent,
  type Worktree,
} from "./api.ts";
import type { ControllerLinkTarget } from "../../shared/conversation-links.ts";
import {
  Sidebar,
  markFocusItemHandled,
  sortFocusQueue,
  type FocusQueueItem,
} from "./components/sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ProjectSetup } from "./pages/ProjectSetup.tsx";
import { EditProject } from "./pages/EditProject.tsx";
import { NewWorktree } from "./pages/NewWorktree.tsx";
import { SessionView } from "./pages/SessionView.tsx";
import { SettingsPage, type SettingsSection } from "./pages/Settings.tsx";
import { useResizablePanel } from "./lib/useResizablePanel.ts";
import { useFocusShortcuts } from "./lib/useFocusShortcuts.ts";
import {
  ShortcutBindingsProvider,
  useShortcutBindingsContext,
} from "./lib/useShortcutBindings.tsx";
import { FileIndexProvider } from "./lib/useFileIndex.tsx";
import { pickFirstFocusItem } from "./lib/focus-advance.ts";
import {
  loadSavedVisitedAt,
  persistVisitedAt,
} from "./lib/focus-visited-storage.ts";

/**
 * Time the conversation panel shows its auto-advance countdown before
 * navigating. The countdown is what keeps the user
 * from losing sight of the message they just sent: the in-flight
 * bubble stays on screen for at least this long, and they can
 * cancel the advance with the **Stay** button or Esc.
 *
 * Single source of truth — do not introduce a second timing knob.
 */
const FOCUS_ADVANCE_COUNTDOWN_MS = 4000;

export interface PendingFocusAdvance {
  sentFromSessionId: string;
  /** Epoch ms when the advance was scheduled. */
  scheduledAt: number;
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
  return (
    <ShortcutBindingsProvider>
      <FileIndexProvider>
        <AppBody />
      </FileIndexProvider>
    </ShortcutBindingsProvider>
  );
}

function AppBody() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setViewState] = useState<View>(loadSavedView);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const saved = loadSavedView();
    return saved.page === "session" ? saved.projectId : null;
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusQueue, setFocusQueue] = useState<FocusQueueItem[]>([]);
  const [focusRefreshKey, setFocusRefreshKey] = useState(0);
  // Per-session "last handled" timestamp. Updated only when the user
  // advances past a session with Next or committed auto-advance. Drives
  // the visited/unvisited split in `sortFocusQueue` — finished
  // sessions the user has not handled sit at the top of the
  // finished block ("triage pile"), and advancing past one sinks it below
  // the unvisited pile so the user isn't bounced back to them on
  // every cycle. The persisted key retains its historical "visited"
  // name for backwards compatibility.
  //
  // Hydrated from localStorage on first paint and persisted on
  // every update so the triage pile survives a reload. Without
  // persistence, a reload re-surfaces every pinned session as
  // "fresh" again and loses the user's triage progress.
  const [visitedAt, setVisitedAt] = useState<Record<string, string>>(
    () => loadSavedVisitedAt(window.localStorage),
  );
  // Write-through to localStorage whenever `visitedAt` changes. A
  // dedicated effect is cleaner than wrapping the setter because
  // Watching the state guarantees we persist exactly the value that
  // just became canonical. Persistence failures are swallowed inside
  // `persistVisitedAt`; the in-memory state still works.
  useEffect(() => {
    persistVisitedAt(window.localStorage, visitedAt);
  }, [visitedAt]);
  // Post-reply auto-advance countdown: on by default. When off,
  // replies stay on the current session until the user hits Next,
  // Mark Done, or re-enables the toggle. The Next chord always
  // advances regardless of this setting (it's the manual escape
  // hatch). Persisted to localStorage so a user who turns it off
  // doesn't have to turn it off again on every reload.
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(
        "controller.focus.autoAdvance",
      );
      if (saved === "false") return false;
    } catch {
      // localStorage can throw in private-mode browsers; fall
      // through to the default.
    }
    return true;
  });
  // Live shortcut bindings shared with the Settings panel and the
  // Focus-queue keyboard listener. Read here (top of AppBody) so
  // both the conversation panel and `useFocusShortcuts` can use the
  // same configured chords.
  const shortcutBindings = useShortcutBindingsContext();
  // Scheduled "advance to the next focus item" while a 4-second
  // countdown is showing in the conversation panel. Set by
  // `handleFocusAdvanceAfterSend` after a send, cleared either by the
  // timer firing (then we navigate) or by any of the cancel paths
  // (S, Esc, manual nav, unmount). See issue #104.
  const [pendingFocusAdvance, setPendingFocusAdvance] =
    useState<PendingFocusAdvance | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  // Live diff totals mirrored up from SessionView so the mobile top
  // header can show the same `+X -Y` chip the desktop header renders.
  // Null while no session is open or no files have changed.
  const [mobileDiffSummary, setMobileDiffSummary] = useState<
    { added: number; deleted: number } | null
  >(null);
  const pendingFocusAdvanceRef = useRef<PendingFocusAdvance | null>(null);
  const focusQueueRef = useRef<FocusQueueItem[]>([]);
  const visitedAtRef = useRef(visitedAt);
  const advanceTimerRef = useRef<number | null>(null);
  // The view to return to when settings is closed (the last non-settings view).
  const preSettingsViewRef = useRef<View>({ page: "empty" });

  useEffect(() => {
    focusQueueRef.current = focusQueue;
  }, [focusQueue]);

  useEffect(() => {
    visitedAtRef.current = visitedAt;
  }, [visitedAt]);

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
    setPendingFocusAdvance((current) => (current ? null : current));
  };

  const closeSidebar = () => setSidebarOpen(false);

  const handleFocusQueueChange = useCallback(
    (queue: FocusQueueItem[]) => {
      // Overlay the per-session handled timestamps onto the items the
      // sidebar emitted, then sort via the shared helper. The sidebar
      // builds the raw items (it owns the runtime / projectData
      // fetches); App owns the visit tracking and the canonical
      // ordering.
      const withVisits = queue.map((item) => {
        const visited = visitedAtRef.current[item.session.id];
        if (visited === item.lastVisitedAt) return item;
        return { ...item, lastVisitedAt: visited };
      });
      const sorted = sortFocusQueue(withVisits);
      focusQueueRef.current = sorted;
      setFocusQueue(sorted);
    },
    [],
  );

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
   * Advance past a session in two explicit steps: first mark and
   * re-sort the current item, then open the new first queue item.
   * Resolving the destination after the mutation keeps navigation
   * aligned with exactly what the sidebar displays.
   */
  const advancePastFocusItem = useCallback(
    (sessionId: string) => {
      const currentQueue = focusQueueRef.current;
      const isPinned = currentQueue.some(
        (item) => item.session.id === sessionId,
      );
      let reordered = currentQueue;

      if (isPinned) {
        const handledAt = new Date().toISOString();
        const nextVisitedAt = {
          ...visitedAtRef.current,
          [sessionId]: handledAt,
        };
        visitedAtRef.current = nextVisitedAt;
        setVisitedAt(nextVisitedAt);

        reordered = markFocusItemHandled(
          currentQueue,
          sessionId,
          handledAt,
        );
        focusQueueRef.current = reordered;
        setFocusQueue(reordered);
      }

      const next = pickFirstFocusItem(reordered, sessionId);
      if (next) openFocusItem(next);
    },
    [openFocusItem],
  );

  /**
   * Commit a scheduled focus advance: reorder the originating session,
   * then navigate to the queue's new first row. The target is resolved
   * here rather than when the countdown starts, so live queue changes
   * during those four seconds are respected.
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
    advancePastFocusItem(pending.sentFromSessionId);
  }, [advancePastFocusItem]);

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
    closeSidebar();
  };

  /**
   * Open a conversation referenced by a `controller://` link in transcript
   * output. The URI always carries project/worktree/session, so navigation is
   * a direct, synchronous switch — no server resolution. If the target no
   * longer exists, SessionView renders an empty session view rather than
   * breaking.
   */
  const handleOpenConversation = useCallback((target: ControllerLinkTarget) => {
    handleSelectSession(target.projectId, target.sessionId, target.worktreeId);
  }, []);

  /**
   * Open a session referenced by a schedule run. The Schedules section
   * passes the run's `projectId` (the cross-project view can show schedules
   * from any project, not just the active one — issue #303 P2 review), and
   * we prefer that over `activeProjectId` so deep-links land in the right
   * project. `activeProjectId` is the fallback for callers that don't pass
   * it. Mirrors `handleOpenConversation` but tolerates a missing `worktreeId`.
   */
  const handleOpenSessionFromSchedule = useCallback(
    (params: {
      sessionId: string;
      worktreeId?: string;
      projectId?: string;
    }) => {
      const projectId = params.projectId ?? activeProjectId;
      if (!projectId) return;
      handleSelectSession(projectId, params.sessionId, params.worktreeId);
    },
    [activeProjectId]
  );

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

  // Clear the mobile diff summary whenever the active session changes
  // (or closes). SessionView re-syncs it via `onDiffSummary` once the
  // new session's diffs finish loading, so we just need to wipe the
  // stale value immediately on navigation.
  useEffect(() => {
    setMobileDiffSummary(null);
  }, [activeView.page === "session" ? activeView.sessionId : null]);

  // When handled timestamps change, re-sort the queue so handled items
  // sink below the unvisited triage pile. Avoid an infinite loop
  // by checking that the timestamps are actually different before
  // triggering the sort.
  useEffect(() => {
    setFocusQueue((current) => {
      const withVisits = current.map((item) => {
        const visited = visitedAt[item.session.id];
        if (visited === item.lastVisitedAt) return item;
        return { ...item, lastVisitedAt: visited };
      });
      const sorted = sortFocusQueue(withVisits);
      // Bail if nothing actually changed (same array reference,
      // same item references). `sortFocusQueue` returns a fresh
      // array even when order is unchanged, so we compare items.
      if (
        sorted.length === current.length &&
        sorted.every((item, i) => item === current[i])
      ) {
        focusQueueRef.current = current;
        return current;
      }
      focusQueueRef.current = sorted;
      return sorted;
    });
  }, [visitedAt]);

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
      toast.info("Focus queue is empty");
      return;
    }
    const sentFromId =
      currentFocusItem?.session.id ?? activeView.sessionId ?? "";
    advancePastFocusItem(sentFromId);
  };

  // Toggle the post-reply auto-advance countdown. Persists to
  // localStorage so the choice survives reloads. Next, Stay, and Mark
  // Done are unaffected — they always work regardless of this
  // setting (Next is the manual escape hatch).
  //
  // Toggling OFF also cancels any in-flight countdown: the user has
  // just said "I want to stay on this session," so honoring a
  // 4-second-old auto-advance schedule contradicts that intent.
  const handleToggleAutoAdvance = useCallback(() => {
    const nextValue = !autoAdvance;
    setAutoAdvance(nextValue);
    try {
      window.localStorage.setItem(
        "controller.focus.autoAdvance",
        nextValue ? "true" : "false",
      );
    } catch {
      // localStorage can throw in private-mode browsers; the
      // in-memory state still flips for the rest of the session.
    }
    if (!nextValue) cancelPendingAdvance();
  }, [autoAdvance, cancelPendingAdvance]);

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
      focusQueueRef.current = nextQueue;
      setFocusQueue(nextQueue);
      setFocusRefreshKey((key) => key + 1);

      if (nextQueue.length === 0) {
        toast.success("Focus queue complete");
        return;
      }

      openFocusItem(nextQueue[0]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update focus queue");
    }
  };

  // After the user sends a message, schedule an advance to the next
  // focus item rather than navigating immediately. The user just
  // committed a message, and bouncing them away from the originating
  // session before the in-flight user bubble can render is what made
  // the message look "lost" (issue #104). The countdown gives them
  // FOCUS_ADVANCE_COUNTDOWN_MS to see the bubble, with the **Stay**
  // chord (default ⌃S / Ctrl+S) or Esc for cancelling.
  //
  // The "sent from" session id is passed in so we can apply the
  // stay-put rule when the only pinned item is the one the user
  // just replied to (queue-of-one, no-op).
  //
  // When `autoAdvance` is off, replies stay on the current session —
  // the user has to hit Next (manual skip), Mark Done (removes from
  // queue), or re-enable the toggle. Staying does not reorder it.
  const handleFocusAdvanceAfterSend = useCallback(
    (sentFromSessionId: string) => {
      if (!autoAdvance) return;
      // Only schedule when another row exists, but deliberately do not
      // cache which row it is. The commit resolves the new first item
      // after demoting the current session and applying any live queue
      // updates that arrived during the countdown.
      if (!pickFirstFocusItem(focusQueueRef.current, sentFromSessionId)) return;
      // Replace any existing pending advance (the user sent again
      // before the previous countdown finished). The new origin
      // session is what matters; we restart the clock.
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
      const pendingAdvance = {
        sentFromSessionId,
        scheduledAt: Date.now(),
      };
      pendingFocusAdvanceRef.current = pendingAdvance;
      setPendingFocusAdvance(pendingAdvance);
      advanceTimerRef.current = window.setTimeout(() => {
        commitPendingAdvance();
      }, FOCUS_ADVANCE_COUNTDOWN_MS);
    },
    [
      autoAdvance,
      commitPendingAdvance,
      cancelPendingAdvance,
      shortcutBindings.bindings,
    ],
  );

  // Sidebar resizing
  const sidebarResize = useResizablePanel({
    storageKey: "sidebarWidth",
    defaultWidth: 256, // w-64
    minWidth: 180,
    maxWidth: 480,
  });

  // Focus-queue keyboard shortcuts (defaults: ⌃N next, ⌃D done, ⌃S
  // stay, ⌃T toggle auto-advance; ⌃ on macOS, Ctrl off-mac). We
  // default to Ctrl rather than Cmd because Cmd collides with too
  // many macOS system shortcuts (Cmd+W, Cmd+Q, Cmd+R, …). The chord
  // for each action is read from `useShortcutBindings`, so users can
  // rebind them in Settings (issue #235). The matcher is strict
  // per-platform: a stored "ctrl-n" only fires on ⌃N on macOS, never
  // on ⌘N. Esc still blurs and (when not in an editable) cancels a
  // pending advance.
  useFocusShortcuts({
    bindings: shortcutBindings.bindings,
    onSkip: handleFocusSkip,
    onDone: handleFocusDone,
    onToggleAutoAdvance: handleToggleAutoAdvance,
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
          focusQueue={focusQueue}
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
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="shrink-0 rounded-md border-l border-border p-2 pl-3 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
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
          {mobileDiffSummary && (
            <span className="shrink-0 font-mono text-xs">
              <span className="text-green-400/90">+{mobileDiffSummary.added}</span>{" "}
              <span className="text-red-400/90">-{mobileDiffSummary.deleted}</span>
            </span>
          )}
          {activeView.page === "session" && activeView.sessionId && (
            <button
              onClick={handleArchiveCurrentSession}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
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
              key={project.id}
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
              loadProjects();
            }}
            onOpenConversation={handleOpenConversation}
            shortcutBindings={shortcutBindings.bindings}
            autoAdvance={autoAdvance}
            onToggleAutoAdvance={handleToggleAutoAdvance}
            onFocusDone={handleFocusDone}
            onFocusSkip={handleFocusSkip}
            onFocusPinnedChange={() => setFocusRefreshKey((key) => key + 1)}
            onTitleChange={() => setFocusRefreshKey((key) => key + 1)}
            onArchive={handleArchiveCurrentSession}
            onDiffSummary={setMobileDiffSummary}
            onFocusAdvanceAfterSend={handleFocusAdvanceAfterSend}
            focusAdvanceCountdown={
              pendingFocusAdvance
                ? {
                    sentFromSessionId: pendingFocusAdvance.sentFromSessionId,
                    scheduledAt: pendingFocusAdvance.scheduledAt,
                    durationMs: FOCUS_ADVANCE_COUNTDOWN_MS,
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
            projectId={activeProjectId ?? undefined}
            onOpenSession={handleOpenSessionFromSchedule}
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
