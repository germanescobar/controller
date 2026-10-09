import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  RotateCw,
  AlertTriangle,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchSessions,
  fetchActiveRuntimes,
  fetchWorktrees,
  deleteProject,
  deleteWorktree,
  archiveSession,
  fetchArchiveBlockers,
  markSessionFocusDone,
  updateSessionTitle,
  fetchWorktreeSetupLog,
  runWorktreeSetup,
  type Project,
  type SessionSummary,
  type Worktree,
  type WorktreeSetupEvent,
  type ArchiveBlocker,
} from "../api.ts";
import {
  groupSessionsByParent,
  isSubtreeExpandedByDefault,
} from "../lib/parent-child.ts";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { canonicalProviderId } from "@/lib/provider-id";
import { DOCS_URL } from "@/lib/links";

const SESSION_BATCH_SIZE = 5;

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeWorktreeId?: string;
  activeSessionId?: string;
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
  /**
   * The canonical sorted focus queue, owned by App (which overlays
   * per-session handled timestamps and runs `sortFocusQueue`). The
   * sidebar uses this for rendering and App uses its first row for
   * navigation. The sidebar still emits a *raw* version
   * of this via `onFocusQueueChange` so App can apply its visit
   * overlay in one place.
   */
  focusQueue?: FocusQueueItem[];
  onFocusQueueChange?: (queue: FocusQueueItem[]) => void;
  focusRefreshKey?: number;
  // The scopes that need re-fetching, accumulated by App.tsx across
  // the 50 ms debounce window. The sidebar fans out into one
  // targeted refresh per scope instead of re-walking every worktree
  // in every project on every event. With many worktrees the old
  // "always reload everything" behavior saturated the server with
  // parallel `GET /sessions?worktreeId=…` requests.
  //
  // Publishing every scope (not just the last event) matters because
  // a burst that lands within the debounce window can touch multiple
  // distinct targets — e.g. a focus pin in worktree A and a session
  // update in worktree B. Publishing only the last event would drop
  // A's update; the accumulated list preserves it. `counter` is
  // monotonic so the sidebar effect re-fires on identical payloads.
  // `null` before the first event.
  pendingProjectRefreshes?: {
    counter: number;
    sessions: Array<{ projectId: string; worktreeId: string }>;
    worktrees: string[];
    hasProjectEvent: boolean;
  } | null;
}

interface WorktreeWithSessions extends Worktree {
  sessions: SessionSummary[];
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
  session: SessionSummary;
  active: boolean;
  /**
   * True when the agent has paused on a user-input request or has
   * a pending tool approval. Drives the highest-priority bucket in
   * `sortFocusQueue` and the priority preference in
   * `pickNextFocusItem`. Independent of `active`: Claude's
   * structured-input pause kills the child so the session shows as
   * inactive but still owes the user a reply.
   */
  awaitingInput?: boolean;
  /**
   * ISO timestamp of the last time the user explicitly advanced past
   * this session with Next or auto-advance. Drives the
   * visited/unvisited split in `sortFocusQueue` — finished sessions
   * the user has not handled since their latest completion sit at the top
   * ("triage pile"), and advancing past one sinks it below the unvisited
   * pile so the user isn't bounced back to them on every cycle.
   * Independent of `lastActiveAt`, which still tracks agent
   * activity and ordering within the unfinished queue.
   */
  lastVisitedAt?: string;
}

/**
 * Order radar (focus-pinned) sessions into priority buckets so the
 * most urgent items float to the top:
 *
 *   1. **Awaiting input** — items whose agent has paused on a
 *      `user.input_requested` prompt or has at least one pending
 *      tool approval. The user owes a reply to these; they sit at
 *      the very top, oldest-arrival first (`lastActiveAt` asc).
 *      The `active` flag doesn't matter here — Claude's
 *      structured-input pause kills the child so a session can be
 *      inactive and still awaiting.
 *   2. **Finished, unvisited** — the triage pile. Items whose agent
 *      finished and the user has not yet explicitly advanced past that
 *      completion. A new completion after a prior visit returns here.
 *      Merely opening one does not change its position. Oldest-arrival first
 *      (`lastActiveAt` asc) so the user walks the pile in the
 *      order the agents finished. Advancing past a session sinks it
 *      into the next bucket so the user isn't bounced back to it
 *      on every cycle.
 *   3. **Finished, visited** — items the user has already handled.
 *      Most-recently-handled at the very bottom of this
 *      sub-bucket (`lastVisitedAt` asc, ties on array order) so
 *      the freshest look sits closest to the running pile below.
 *   4. **Running (active)** — sessions where the agent is still
 *      working. Oldest-running first, so the most recently
 *      started running session lands at the very bottom of the
 *      queue (`lastActiveAt` asc).
 *
 * Within each bucket, ties on the sort key fall back to the
 * caller's array order (Array#sort is stable).
 *
 * Pure: does not mutate the input.
 */
export function sortFocusQueue(items: FocusQueueItem[]): FocusQueueItem[] {
  const hasUnseenCompletion = (item: FocusQueueItem) => {
    if (!item.lastVisitedAt) return true;
    return (
      new Date(item.session.lastActiveAt).getTime() >
      new Date(item.lastVisitedAt).getTime()
    );
  };

  const awaiting = items
    .filter((item) => item.awaitingInput)
    .sort(
      (a, b) =>
        new Date(a.session.lastActiveAt).getTime() -
        new Date(b.session.lastActiveAt).getTime(),
    );

  const finishedUnvisited = items
    .filter(
      (item) =>
        !item.awaitingInput && !item.active && hasUnseenCompletion(item),
    )
    .sort(
      (a, b) =>
        new Date(a.session.lastActiveAt).getTime() -
        new Date(b.session.lastActiveAt).getTime(),
    );

  const finishedVisited = items
    .filter(
      (item) =>
        !item.awaitingInput && !item.active && !hasUnseenCompletion(item),
    )
    .sort(
      (a, b) =>
        new Date(a.lastVisitedAt!).getTime() -
        new Date(b.lastVisitedAt!).getTime(),
    );

  const running = items
    .filter((item) => !item.awaitingInput && item.active)
    .sort(
      (a, b) =>
        new Date(a.session.lastActiveAt).getTime() -
        new Date(b.session.lastActiveAt).getTime(),
    );

  return [...awaiting, ...finishedUnvisited, ...finishedVisited, ...running];
}

/**
 * Mark one queue item as handled, then return the queue in its new
 * canonical order. Navigation intentionally happens after this step
 * so Next and auto-advance always open the new first row.
 */
export function markFocusItemHandled(
  items: FocusQueueItem[],
  sessionId: string,
  handledAt: string,
): FocusQueueItem[] {
  return sortFocusQueue(
    items.map((item) =>
      item.session.id === sessionId
        ? { ...item, lastVisitedAt: handledAt }
        : item,
    ),
  );
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

function AnitaLogo({ className }: { className?: string }) {
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
  // Anita is the default provider — sessions created by the Anita CLI don't
  // persist a `provider` field, so a missing/empty value means "anita".
  // The legacy "ada" id resolves to "anita" too.
  if (canonicalProviderId(provider) === "anita") {
    return <AnitaLogo className={className} />;
  }
  if (provider === "codex") {
    return <CodexLogo className={className} />;
  }
  if (provider === "claude") {
    return <ClaudeLogo className={className} />;
  }
  return <MessageSquare className={className} />;
}

export interface PendingRefreshDrainPlan {
  // Session scopes (`projectId\u0000worktreeId`) to remove from the
  // queue and replay now.
  dispatchSessions: Array<{ key: string; projectId: string; worktreeId: string }>;
  // Project ids whose worktree list should be removed from the queue
  // and replayed now.
  dispatchProjects: string[];
  // Scopes to drop without replaying (their project is gone).
  evictSessions: string[];
  evictProjects: string[];
}

/**
 * Decide what the sidebar's queued-refresh drain should do. Pure so
 * the ordering rules can be unit-tested without a DOM.
 *
 * While any `loadAll` is in flight the plan is empty: a replay would
 * only see the same in-flight load, defer, re-queue and re-drain on
 * the next microtask — a request loop that lasts as long as the
 * load. The `loadAll` state transition at completion re-runs the
 * drain, so nothing queued here is lost.
 *
 * A scope whose project is missing from the snapshot is evicted only
 * once a `loadAll` has succeeded, so a failed or not-yet-run initial
 * load doesn't discard refreshes for projects that haven't painted.
 */
export function planPendingRefreshDrain(input: {
  inFlightLoadAlls: number;
  lastSuccessToken: number;
  pendingSessionKeys: Iterable<string>;
  pendingProjectIds: Iterable<string>;
  projects: Array<{ id: string; worktrees: Array<{ id: string }> }>;
}): PendingRefreshDrainPlan {
  const plan: PendingRefreshDrainPlan = {
    dispatchSessions: [],
    dispatchProjects: [],
    evictSessions: [],
    evictProjects: [],
  };
  if (input.inFlightLoadAlls > 0) return plan;
  const canEvictMissingProject = input.lastSuccessToken > 0;
  const projectsById = new Map(input.projects.map((p) => [p.id, p]));
  for (const key of input.pendingSessionKeys) {
    const idx = key.indexOf("\u0000");
    const projectId = key.slice(0, idx);
    const worktreeId = key.slice(idx + 1);
    const project = projectsById.get(projectId);
    if (!project) {
      if (canEvictMissingProject) plan.evictSessions.push(key);
      continue;
    }
    // Worktree not loaded yet: keep it queued.
    if (!project.worktrees.some((w) => w.id === worktreeId)) continue;
    plan.dispatchSessions.push({ key, projectId, worktreeId });
  }
  for (const projectId of input.pendingProjectIds) {
    if (!projectsById.has(projectId)) {
      if (canEvictMissingProject) plan.evictProjects.push(projectId);
      continue;
    }
    plan.dispatchProjects.push(projectId);
  }
  return plan;
}

function worktreeVisibilityKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

// The destructive confirm button used by the project and worktree delete
// dialogs. When `loading` is true the label is swapped for a spinner and
// the button is disabled so the user can't double-click while the
// destructive request is in flight. `label` lets the caller swap the
// default "Delete" text (e.g. "Force delete" when the worktree has
// uncommitted changes — issue #332). Exported for unit testing.
export function DestructiveConfirmButton({
  loading,
  onClick,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button variant="destructive" onClick={onClick} disabled={loading}>
      {loading ? (
        <>
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          Deleting…
        </>
      ) : (
        label ?? "Delete"
      )}
    </Button>
  );
}

// Footer row of the sidebar: Settings button on the left, a help link
// to the public docs site on the right. Extracted from the main
// Sidebar so the link can be unit-tested without rendering the whole
// tree (which fans out to the projects API).
export function SidebarBottomBar({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="flex items-center p-3">
      <button
        data-testid="sidebar-settings"
        onClick={onSettings}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
      >
        <Settings className="h-4 w-4" />
        <span>Settings</span>
      </button>
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="sidebar-help"
        aria-label="Open Controller docs in browser"
        className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
      >
        <HelpCircle className="h-4 w-4" />
      </a>
    </div>
  );
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
  focusQueue: focusQueueProp,
  onFocusQueueChange,
  focusRefreshKey,
  pendingProjectRefreshes,
}: SidebarProps) {
  const [projectData, setProjectData] = useState<ProjectWithWorktrees[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(
    new Set(),
  );
  // Sessions whose agent has paused on a user-input request or has
  // at least one pending tool approval. The runtime map reports this
  // independently of `active` (Claude's structured-input pause kills
  // the child process, so the session is `active: false` but still
  // needs the user's attention). Surfaced at the very top of the
  // focus queue.
  const [awaitingInputSessionIds, setAwaitingInputSessionIds] = useState<
    Set<string>
  >(new Set());
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<
    Record<string, number>
  >({});
  // Issue #351: parents whose children-subtree is currently
  // expanded. The set is keyed by parent id; a parent with no
  // entry is collapsed (or auto-expanded on first render via
  // `isSubtreeExpandedByDefault`). The state is per-component
  // instance — the sidebar starts fresh on every mount, which
  // matches the existing focus-queue behavior.
  const [expandedSubtreeIds, setExpandedSubtreeIds] = useState<
    Set<string>
  >(new Set());
  const toggleSubtree = (parentId: string, currentlyExpanded: boolean) => {
    setExpandedSubtreeIds((prev) => {
      const next = new Set(prev);
      const collapsedKey = `__collapsed__${parentId}`;
      next.delete(parentId);
      next.delete(collapsedKey);
      if (currentlyExpanded) next.add(collapsedKey);
      else next.add(parentId);
      return next;
    });
  };
  const [confirmArchiveSession, setConfirmArchiveSession] = useState<{
    projectId: string;
    sessionId: string;
    worktreeId: string;
  } | null>(null);
  const [archiveBlockersBySession, setArchiveBlockersBySession] = useState<
    Record<string, ArchiveBlocker[]>
  >({});
  const [checkingArchiveIds, setCheckingArchiveIds] = useState<Set<string>>(
    new Set(),
  );
  const [archivingSession, setArchivingSession] = useState(false);

  const describeArchiveBlockers = (blockers: ArchiveBlocker[]): string =>
    blockers
      .map((blocker) => {
        switch (blocker.kind) {
          case "live-agent":
            return blocker.message || "agent is running";
          case "awaiting-input":
            return blocker.message || "session is waiting for input";
          case "queued-messages":
            return `${blocker.count} queued message${blocker.count === 1 ? "" : "s"}`;
          case "active-monitors":
            return `${blocker.count} active monitor${blocker.count === 1 ? "" : "s"}`;
          case "live-children":
            return `${blocker.count} child session${blocker.count === 1 ? " has" : "s have"} unfinished work`;
        }
      })
      .join(", ");

  const loadArchiveBlockers = async (
    projectId: string,
    sessionId: string,
    worktreeId: string,
  ): Promise<ArchiveBlocker[]> => {
    setCheckingArchiveIds((prev) => new Set(prev).add(sessionId));
    try {
      const blockers = await fetchArchiveBlockers(
        projectId,
        sessionId,
        worktreeId,
      );
      setArchiveBlockersBySession((prev) => ({
        ...prev,
        [sessionId]: blockers,
      }));
      return blockers;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to check archive status",
      );
      return [{ kind: "live-agent", message: "Archive status is unknown" }];
    } finally {
      setCheckingArchiveIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const requestArchive = async (
    projectId: string,
    sessionId: string,
    worktreeId: string,
  ) => {
    const blockers = await loadArchiveBlockers(
      projectId,
      sessionId,
      worktreeId,
    );
    if (blockers.length > 0) {
      toast.error(`Cannot archive: ${describeArchiveBlockers(blockers)}`);
      return;
    }
    setConfirmArchiveSession({ projectId, sessionId, worktreeId });
  };
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<
    string | null
  >(null);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] = useState<{
    projectId: string;
    worktreeId: string;
    name: string;
    // Issue #332: when the orchestrator refuses a delete because the
    // worktree has uncommitted changes, we keep the offending file
    // list on the confirm state so the dialog can show it and offer
    // a force-retry. `null` until the first delete attempt returns
    // 409 with `dirtyFiles`.
    dirtyFiles: string[] | null;
  } | null>(null);
  const [renameSession, setRenameSession] = useState<{
    projectId: string;
    worktreeId: string;
    sessionId: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  // Tracks destructive delete requests in flight so the matching confirm
  // dialog can disable both buttons, swap the label for a spinner, and
  // block dismissal until the request resolves. Mirrors `savingRename`.
  const [deletingProject, setDeletingProject] = useState(false);
  const [deletingWorktree, setDeletingWorktree] = useState(false);
  // Setup log dialog: shown when the user clicks the red `!` next to a
  // worktree. `running` is true while a re-run is in flight; `lines`
  // accumulates the live stream so the dialog becomes a small terminal.
  const [setupLog, setSetupLog] = useState<{
    projectId: string;
    projectName: string;
    worktreeId: string;
    worktreeName: string;
    loading: boolean;
    error: string | null;
    log: string | null;
    exitCode: number | null;
    ranAt: string | null;
    running: boolean;
    lines: string[];
    streamError: string | null;
  } | null>(null);
  const setupRunCancelRef = useRef<(() => void) | null>(null);

  // Raw focus items: project/worktree/session metadata plus the
  // runtime flags (active, awaitingInput). Computed here because
  // the sidebar owns the projectData / runtime fetches. App applies
  // the visit-timestamp overlay and runs the canonical sort; the
  // sorted queue comes back via `focusQueueProp` and is what we
  // render.
  const rawFocusItems = useMemo<FocusQueueItem[]>(() => {
    return projectData.flatMap((project) =>
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
            awaitingInput: awaitingInputSessionIds.has(session.id) || undefined,
          })),
      ),
    );
  }, [activeSessionIds, awaitingInputSessionIds, projectData]);

  // The canonical, sorted queue lives in App (it has the visit
  // overlay + final sort). On the very first paint (before App has
  // emitted its first sorted value) fall back to a local sort using
  // the raw items so the sidebar has something to render.
  const fallbackQueue = useMemo(
    () => sortFocusQueue(rawFocusItems),
    [rawFocusItems],
  );
  const focusQueue = focusQueueProp ?? fallbackQueue;

  useEffect(() => {
    onFocusQueueChange?.(rawFocusItems);
  }, [rawFocusItems, onFocusQueueChange]);

  const refreshActiveSessions = useCallback(async () => {
    // One bulk request replaces the previous per-session /runtime polling loop
    // (which issued N requests every 2s for every non-archived session).
    const entries = await fetchActiveRuntimes().catch(() => []);
    setActiveSessionIds(
      new Set(entries.filter((entry) => entry.active).map((entry) => entry.sessionId)),
    );
    setAwaitingInputSessionIds(
      new Set(
        entries
          .filter((entry) => entry.awaitingInput)
          .map((entry) => entry.sessionId),
      ),
    );
  }, []);

  // Latest `projectData` mirror, kept in a ref so the targeted
  // refresh callbacks can read the current state at call time
  // without taking `projectData` as a dependency (which would
  // re-trigger the event effect on every state update). The ref
  // is updated synchronously after every render.
  const projectDataRef = useRef<ProjectWithWorktrees[]>(projectData);
  useEffect(() => {
    projectDataRef.current = projectData;
  }, [projectData]);

  // ---------------------------------------------------------------------------
  // LoadAllCoordinator
  //
  // Replaces four pieces of bookkeeping that grew across the first four
  // codex rounds: `loadAllTokenRef`, `inFlightLoadAllsRef`,
  // `inFlightLoadAllsVersion`, and an ad-hoc "did the last loadAll
  // succeed" check. The original problem the targeted refresh path has to
  // answer is: "given that a `loadAll` *might* be painting a fresh
  // snapshot right now, is it safe for me to write the data I just
  // fetched, or should I keep my scope queued and let the next drain
  // decide?" That's a single ordering question, and it deserves a single
  // state machine.
  //
  // Invariants:
  //
  //   - `inFlightTokens`    =  the set of tokens for every `loadAll`
  //     currently in flight. Empty ⇔ no loadAll in flight. A
  //     single-token "current token" was insufficient because two
  //     loadAlls can overlap (e.g. rapid project selection or
  //     React StrictMode's development effect replay) and the first
  //     to finish would otherwise clear the slot out from under the
  //     second.
  //   - `lastSuccessToken`  =  max over all successful `loadAll`
  //     tokens (a failed loadAll does not bump it; an older successful
  //     loadAll completing after a newer one does not regress it).
  //   - `version`           =  monotonic counter bumped on every
  //     transition. The drain effect depends on it so the drain re-fires
  //     after any loadAll transition.
  //
  // The targeted refresh's deferral rule (single comparison, no chained
  // gates):
  //
  //     tokenAtStart := max token in `inFlightTokens` at fetch start
  //                    (0 if no loadAll in flight at start)
  //     after fetch resolves:
  //       safe to apply ⇔ lastSuccessToken ≥ tokenAtStart
  //
  // The logic: a successful loadAll that *started* at or after our
  // snapshot means we have authoritative data and no pending loadAll
  // is about to clobber us. Conversely, if `lastSuccessToken <
  // tokenAtStart`, either (a) a loadAll is still in flight at our
  // token, (b) a loadAll is in flight at a *newer* token, or (c) the
  // loadAll at our token failed — all three cases defer. The next
  // drain trigger (a transition on `version`) re-evaluates.
  //
  // Why this is the right shape: the prior four rounds were all variants
  // of "did a loadAll start/succeed/fail since I sampled?". Folding that
  // into one state + one comparison replaces ~70 lines of layered refs,
  // double-bookkeeping (ref + state mirror), and chained gates with a
  // single source of truth that any future reviewer can verify in one
  // place.
  // ---------------------------------------------------------------------------
  const loadAllStateRef = useRef<{
    inFlightTokens: Set<number>;
    lastSuccessToken: number;
    version: number;
  }>({ inFlightTokens: new Set(), lastSuccessToken: 0, version: 0 });
  const [loadAllVersion, setLoadAllVersion] = useState(0);
  const bumpLoadAllState = useCallback((updater: () => void) => {
    updater();
    loadAllStateRef.current.version += 1;
    setLoadAllVersion(loadAllStateRef.current.version);
  }, []);

  // Snapshot the loadAll state into a single comparison token. The
  // targeted refresh uses this as `tokenAtStart`; the deferral
  // rule is then `lastSuccessToken >= tokenAtStart`. Returns 0
  // when no loadAll is in flight, which the rule treats as
  // "always apply once the fetch returns" (every successful
  // loadAll is at least token 1).
  const snapshotLoadAllToken = (
    state: { inFlightTokens: Set<number> }
  ): number => {
    if (state.inFlightTokens.size === 0) return 0;
    let max = 0;
    for (const t of state.inFlightTokens) {
      if (t > max) max = t;
    }
    return max;
  };

  const loadAll = useCallback(async () => {
    // Allocate a fresh token, claim an in-flight slot, bump version so
    // the drain effect re-runs.
    const myToken = loadAllStateRef.current.version + 1;
    bumpLoadAllState(() => {
      loadAllStateRef.current.inFlightTokens.add(myToken);
    });
    let succeeded = false;
    try {
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
      succeeded = true;
    } finally {
      // Release this run's in-flight slot. With concurrent loadAlls
      // the slot set is the source of truth — we only remove our
      // own token, not the whole set. `lastSuccessToken` advances
      // via max (not assignment) so a stale older loadAll
      // completing after a newer one does not regress the
      // authoritative marker.
      bumpLoadAllState(() => {
        loadAllStateRef.current.inFlightTokens.delete(myToken);
        if (succeeded) {
          loadAllStateRef.current.lastSuccessToken = Math.max(
            loadAllStateRef.current.lastSuccessToken,
            myToken,
          );
        }
      });
    }
  }, [projects, activeProjectId, activeWorktreeId, archivedIds]);

  /**
   * Refresh a single worktree's session list. Used by the targeted
   * event handler below so a `session_added` / `session_removed` /
   * `session_updated` event only re-fetches the affected worktree's
   * sessions instead of every worktree in every project.
   *
   * Defers (queues + returns) when:
   *   - a `loadAll` was in flight when the fetch started and no
   *     `loadAll` at least that new has succeeded since (it is still
   *     running, or it failed), or
   *   - the project/worktree isn't in `projectDataRef.current` yet
   *     (might appear once the in-flight/queued loadAll paints).
   *
   * A `loadAll` that starts *after* the fetch began doesn't defer it:
   * that load issues its own requests later, so whichever write lands
   * last is at least as fresh as the event that triggered us.
   *
   * Queued scopes are replayed by the drain once no `loadAll` is in
   * flight (see `planPendingRefreshDrain`).
   */
  const refreshWorktreeSessions = useCallback(
    async (projectId: string, worktreeId: string): Promise<void> => {
      const tokenAtStart = snapshotLoadAllToken(loadAllStateRef.current);
      let sessions: SessionSummary[];
      try {
        sessions = await fetchSessions(projectId, worktreeId);
      } catch {
        return;
      }
      // Single deferral rule. `lastSuccessToken >= tokenAtStart`
      // means a successful loadAll that started at or after our
      // snapshot has landed. If not, either a loadAll is still in
      // flight, a newer loadAll started, or the loadAll at our
      // snapshot failed — all three cases defer.
      if (loadAllStateRef.current.lastSuccessToken < tokenAtStart) {
        queueSessionRefresh(projectId, worktreeId);
        return;
      }
      const filtered = sessions.filter((s) => !archivedIds.has(s.id));
      // Read the latest state via the ref to decide whether the
      // scope is ready to apply. The ref is updated synchronously
      // after every render, so this reflects the freshest snapshot
      // we have *before* the awaited fetch — close enough for the
      // decision; the setProjectData updater below re-checks the
      // same condition on the live `prev` to avoid races.
      const project = projectDataRef.current.find(
        (p) => p.id === projectId,
      );
      if (!project || !project.worktrees.some((w) => w.id === worktreeId)) {
        queueSessionRefresh(projectId, worktreeId);
        return;
      }
      setProjectData((prev) => {
        if (!prev.some((p) => p.id === projectId)) {
          return prev;
        }
        return prev.map((p) => {
          if (p.id !== projectId) return p;
          if (!p.worktrees.some((w) => w.id === worktreeId)) return p;
          return {
            ...p,
            worktrees: p.worktrees.map((w) =>
              w.id === worktreeId
                ? { ...w, sessions: filtered }
                : w,
            ),
          };
        });
      });
      // Refresh runtimes alongside the targeted refetch so a
      // session that just spawned or finished picks up its
      // active/awaiting flags without waiting for the next 2s
      // poll.
      refreshActiveSessions().catch(() => {});
    },
    [archivedIds, refreshActiveSessions],
  );

  /**
   * Refresh a single project's worktree list. Used when a
   * `worktree_added` / `worktree_removed` / `worktree_updated` event
   * lands. Preserves each surviving worktree's `isExpanded` and
   * `sessions` so the user doesn't lose their expansion state on
   * every refresh, and so we only pay the sessions cost for worktrees
   * the event actually changed.
   *
   * Defers (queues + returns) on the same `loadAllStateRef` condition
   * as `refreshWorktreeSessions`: a loadAll is racing us, or the
   * project isn't in `projectDataRef.current` yet.
   */
  const refreshProjectWorktrees = useCallback(
    async (projectId: string): Promise<void> => {
      const tokenAtStart = snapshotLoadAllToken(loadAllStateRef.current);
      let worktrees: Worktree[];
      try {
        worktrees = await fetchWorktrees(projectId);
      } catch {
        return;
      }
      if (loadAllStateRef.current.lastSuccessToken < tokenAtStart) {
        queueProjectWorktreesRefresh(projectId);
        return;
      }
      const existingProject = projectDataRef.current.find(
        (p) => p.id === projectId,
      );
      if (!existingProject) {
        queueProjectWorktreesRefresh(projectId);
        return;
      }
      const existingIds = new Set(
        existingProject.worktrees.map((w) => w.id),
      );
      const newWorktreeIds = worktrees
        .filter((w) => !existingIds.has(w.id))
        .map((w) => w.id);
      setProjectData((prev) => {
        if (!prev.some((p) => p.id === projectId)) return prev;
        return prev.map((p) => {
          if (p.id !== projectId) return p;
          const existingById = new Map(p.worktrees.map((w) => [w.id, w]));
          const merged = worktrees.map((wt) => {
            const existing = existingById.get(wt.id);
            const isActiveWt =
              wt.id === activeWorktreeId ||
              (!activeWorktreeId && wt.isMain && projectId === activeProjectId);
            return {
              ...wt,
              sessions: existing?.sessions ?? [],
              isExpanded: existing?.isExpanded ?? isActiveWt,
            } satisfies WorktreeWithSessions;
          });
          return { ...p, worktrees: merged };
        });
      });
      // New worktrees won't have session lists yet — fetch them so
      // the sidebar can render a fresh tree. Removed worktrees drop
      // out naturally because we trust the server's worktree list.
      await Promise.all(
        newWorktreeIds.map((wtId) =>
          refreshWorktreeSessions(projectId, wtId).catch(() => {}),
        ),
      );
    },
    [
      activeProjectId,
      activeWorktreeId,
      refreshWorktreeSessions,
    ],
  );

  // Queued scopes that arrived before their project/worktree was in
  // `projectData`, or while a `loadAll` was racing them. The targeted
  // refresh drops the data and records the scope here; the drain
  // replays every entry once the loadAll bookkeeping says it's safe.
  //
  // Two parallel sets keyed by the same string key: one for session
  // scopes (`projectId\u0000worktreeId`) and one for worktree scopes
  // (`projectId`). Keeping them separate means a queued session
  // refresh and a queued worktree refresh don't accidentally
  // collapse into one and skip half the work.
  const pendingSessionScopesRef = useRef<Set<string>>(new Set());
  const pendingProjectScopesRef = useRef<Set<string>>(new Set());
  // The drain is defined later in the file, so we keep a ref to its
  // latest instance. The queue helpers schedule a microtask drain
  // after adding to the set so a scope that arrives after a loadAll
  // transition has already fired its drain still gets a chance to
  // apply: a plain ref mutation doesn't trigger React effects.
  const drainPendingRefreshesRef = useRef<() => void>(() => {});
  const drainScheduledRef = useRef<boolean>(false);
  const scheduleDrain = useCallback(() => {
    if (drainScheduledRef.current) return;
    drainScheduledRef.current = true;
    queueMicrotask(() => {
      drainScheduledRef.current = false;
      drainPendingRefreshesRef.current();
    });
  }, []);
  const queueSessionRefresh = useCallback(
    (projectId: string, worktreeId: string) => {
      pendingSessionScopesRef.current.add(`${projectId}\u0000${worktreeId}`);
      scheduleDrain();
    },
    [scheduleDrain],
  );
  const queueProjectWorktreesRefresh = useCallback(
    (projectId: string) => {
      pendingProjectScopesRef.current.add(projectId);
      scheduleDrain();
    },
    [scheduleDrain],
  );

  /**
   * Replay every queued targeted refresh that has a now-loaded
   * target. Called whenever `projectData` changes (a loadAll
   * painted a new snapshot), `loadAllVersion` bumps (a loadAll
   * started, succeeded, or failed), or a scope is queued. The
   * decision rules — hold everything while a loadAll is in flight,
   * evict only after a successful load — live in
   * `planPendingRefreshDrain`; this just applies the plan.
   */
  const drainPendingRefreshes = useCallback(() => {
    if (
      pendingSessionScopesRef.current.size === 0 &&
      pendingProjectScopesRef.current.size === 0
    ) {
      return;
    }
    const plan = planPendingRefreshDrain({
      inFlightLoadAlls: loadAllStateRef.current.inFlightTokens.size,
      lastSuccessToken: loadAllStateRef.current.lastSuccessToken,
      pendingSessionKeys: pendingSessionScopesRef.current,
      pendingProjectIds: pendingProjectScopesRef.current,
      projects: projectDataRef.current,
    });
    plan.evictSessions.forEach((key) =>
      pendingSessionScopesRef.current.delete(key),
    );
    plan.evictProjects.forEach((projectId) =>
      pendingProjectScopesRef.current.delete(projectId),
    );
    plan.dispatchSessions.forEach(({ key, projectId, worktreeId }) => {
      pendingSessionScopesRef.current.delete(key);
      refreshWorktreeSessions(projectId, worktreeId).catch(() => {});
    });
    plan.dispatchProjects.forEach((projectId) => {
      pendingProjectScopesRef.current.delete(projectId);
      refreshProjectWorktrees(projectId).catch(() => {});
    });
  }, [refreshWorktreeSessions, refreshProjectWorktrees]);

  // Keep the queue-helpers' ref mirror current so they can
  // schedule a microtask drain after adding to the set. The
  // microtask is the only way to fire a drain from inside the
  // queue helper without coupling the helpers' definition to
  // the drain's order in the file (forward reference).
  useEffect(() => {
    drainPendingRefreshesRef.current = drainPendingRefreshes;
  }, [drainPendingRefreshes]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll, focusRefreshKey]);

  // Last `pendingProjectRefreshes.counter` we already dispatched.
  // App.tsx bumps the counter on every event burst and never
  // clears the payload; without this, any callback-dep change
  // (notably `activeProjectId`/`activeWorktreeId` recreating
  // `refreshProjectWorktrees`) re-fires the same burst and
  // re-issues the last lifecycle's session/worktree requests —
  // which is exactly the request storm this whole change was
  // supposed to prevent.
  const lastConsumedRefreshesCounterRef = useRef<number>(-1);

  /**
   * Targeted refresh on lifecycle events. The old behavior re-ran
   * `loadAll` for *every* event, which under many worktrees saturated
   * the server with parallel `GET /sessions?worktreeId=…` requests
   * (each request walks a worktree's session directory and parses
   * every JSON file). With 15+ worktrees the N+1 walk dominated the
   * 50ms debounce window and the UI was stuck on `(pending)` rows.
   *
   * App.tsx accumulates every scope touched during the debounce
   * window into `pendingProjectRefreshes`, so this effect can fan
   * out into one targeted refresh per scope:
   *   - `sessions`  → re-fetch each affected worktree's sessions
   *   - `worktrees` → re-fetch each affected project's worktree list
   *   - `hasProjectEvent` → no-op here; App already refreshed the
   *                         projects list and `loadAll`'s `projects`
   *                         dep re-runs the full walk.
   *
   * Consume-once: ignore a payload whose `counter` matches the last
   * one we dispatched. New bursts get a fresh counter from App.tsx.
   */
  useEffect(() => {
    if (!pendingProjectRefreshes) return;
    if (pendingProjectRefreshes.counter === lastConsumedRefreshesCounterRef.current) {
      return;
    }
    lastConsumedRefreshesCounterRef.current = pendingProjectRefreshes.counter;
    pendingProjectRefreshes.sessions.forEach((scope) => {
      refreshWorktreeSessions(scope.projectId, scope.worktreeId).catch(
        () => {},
      );
    });
    pendingProjectRefreshes.worktrees.forEach((projectId) => {
      refreshProjectWorktrees(projectId).catch(() => {});
    });
    drainPendingRefreshes();
  }, [
    pendingProjectRefreshes,
    refreshWorktreeSessions,
    refreshProjectWorktrees,
    drainPendingRefreshes,
  ]);

  /**
   * Drain queued targeted refreshes after every `projectData` update
   * (a loadAll painted a new snapshot) and after every
   * `loadAllVersion` bump (a loadAll started, succeeded, or failed).
   * The two deps together ensure the drain re-evaluates whenever the
   * loadAll state machine transitions: scope deferrals that were
   * waiting on a loadAll outcome get replayed against the fresh
   * snapshot.
   *
   * The lifecycle dispatch lives in the consume-once effect above.
   * An earlier draft of this refactor had a second unguarded effect
   * here that re-dispatched the same payload on every callback-dep
   * change, bypassing `lastConsumedRefreshesCounterRef` and
   * resurrecting the original request-storm problem the consume-once
   * check was meant to prevent.
   */
  useEffect(() => {
    drainPendingRefreshes();
  }, [projectData, loadAllVersion, drainPendingRefreshes]);

  useEffect(() => {
    if (activeSessionIds.size === 0 && awaitingInputSessionIds.size === 0) return;
    const interval = window.setInterval(() => {
      refreshActiveSessions().catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [activeSessionIds, awaitingInputSessionIds, refreshActiveSessions]);

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
    if (deletingProject) return;
    setDeletingProject(true);
    try {
      await deleteProject(confirmDeleteProjectId);
      setConfirmDeleteProjectId(null);
      onProjectsChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete project",
      );
    } finally {
      setDeletingProject(false);
    }
  };

  const confirmDeleteWorktreeAction = async () => {
    if (!confirmDeleteWorktree) return;
    if (deletingWorktree) return;
    const { projectId, worktreeId, dirtyFiles } = confirmDeleteWorktree;
    // Issue #332: when the orchestrator already returned the dirty
    // file list for this worktree, the user has seen the warning and
    // clicked through to retry — pass `?force=1` so we don't loop on
    // the same 409. A first-time attempt (dirtyFiles === null) uses
    // the safe-by-default path so the user gets the chance to abort.
    const force = dirtyFiles !== null;
    setDeletingWorktree(true);
    try {
      await deleteWorktree(projectId, worktreeId, { force });
      setConfirmDeleteWorktree(null);
      await loadAll();
      toast.success("Worktree deleted");
    } catch (err) {
      // The orchestrator's safe-by-default gate (issue #332) returns
      // 409 with `dirtyFiles` when the worktree has uncommitted
      // changes, and 409 with the same field when `?force=1` was sent
      // but no archive script is configured. Capture the file list
      // and keep the dialog open so the user can see what changed
      // and decide whether to retry with force (only when an archive
      // is configured).
      const dirty = (err as Error & { dirtyFiles?: unknown }).dirtyFiles;
      if (
        Array.isArray(dirty) &&
        dirty.length > 0 &&
        !force
      ) {
        setConfirmDeleteWorktree({
          projectId,
          worktreeId,
          name: confirmDeleteWorktree.name,
          dirtyFiles: dirty,
        });
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Failed to delete worktree",
      );
    } finally {
      setDeletingWorktree(false);
    }
  };

  const openRenameDialog = (
    projectId: string,
    worktreeId: string,
    session: SessionSummary,
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

  const openSetupLog = async (
    projectId: string,
    projectName: string,
    worktreeId: string,
    worktreeName: string,
  ) => {
    setSetupLog({
      projectId,
      projectName,
      worktreeId,
      worktreeName,
      loading: true,
      error: null,
      log: null,
      exitCode: null,
      ranAt: null,
      running: false,
      lines: [],
      streamError: null,
    });
    try {
      const data = await fetchWorktreeSetupLog(projectId, worktreeId);
      setSetupLog((prev) =>
        prev && prev.worktreeId === worktreeId
          ? {
              ...prev,
              loading: false,
              log: data.log,
              exitCode: data.exitCode,
              ranAt: data.ranAt,
              error: data.log
                ? null
                : "No setup log is available for this worktree yet.",
            }
          : prev,
      );
    } catch (err) {
      setSetupLog((prev) =>
        prev && prev.worktreeId === worktreeId
          ? {
              ...prev,
              loading: false,
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to load setup log",
            }
          : prev,
      );
    }
  };

  const closeSetupLog = () => {
    setupRunCancelRef.current?.();
    setupRunCancelRef.current = null;
    setSetupLog(null);
  };

  const rerunSetup = async () => {
    if (!setupLog || setupLog.running) return;
    setSetupLog((prev) =>
      prev
        ? { ...prev, running: true, lines: [], streamError: null, error: null }
        : prev,
    );

    const { events, cancel, result } = runWorktreeSetup(
      setupLog.projectId,
      setupLog.worktreeId,
    );
    setupRunCancelRef.current = cancel;

    (async () => {
      try {
        for await (const event of events as AsyncIterable<WorktreeSetupEvent>) {
          if (event.type === "log") {
            const text = event.text.endsWith("\n")
              ? event.text.slice(0, -1)
              : event.text;
            setSetupLog((prev) =>
              prev && prev.worktreeId === setupLog.worktreeId
                ? { ...prev, lines: [...prev.lines, text] }
                : prev,
            );
          } else if (event.type === "error") {
            setSetupLog((prev) =>
              prev && prev.worktreeId === setupLog.worktreeId
                ? { ...prev, streamError: event.text }
                : prev,
            );
          }
        }
        const updated = await result;
        // Refresh the cached log so the dialog shows the freshly written
        // setup.log plus the new exit code/timestamp.
        const data = await fetchWorktreeSetupLog(
          setupLog.projectId,
          setupLog.worktreeId,
        );
        setSetupLog((prev) =>
          prev && prev.worktreeId === setupLog.worktreeId
            ? {
                ...prev,
                running: false,
                log: data.log,
                exitCode: data.exitCode ?? updated.setupExitCode ?? null,
                ranAt: data.ranAt ?? updated.setupRanAt ?? null,
                error: data.log
                  ? null
                  : "Setup finished without producing a log file.",
              }
            : prev,
        );
        // Mirror the new exit code into the sidebar's worktree list so the `!`
        // indicator clears as soon as a retry succeeds.
        setProjectData((prev) =>
          prev.map((p) =>
            p.id === setupLog.projectId
              ? {
                  ...p,
                  worktrees: p.worktrees.map((w) =>
                    w.id === updated.id
                      ? {
                          ...w,
                          setupExitCode: updated.setupExitCode,
                          setupRanAt: updated.setupRanAt,
                          setupLogPath: updated.setupLogPath,
                        }
                      : w,
                  ),
                }
              : p,
          ),
        );
        if (updated.setupExitCode === 0) {
          toast.success("Setup completed");
        } else if (updated.setupExitCode != null) {
          toast.error(`Setup exited with code ${updated.setupExitCode}`);
        }
      } catch (err) {
        setSetupLog((prev) =>
          prev && prev.worktreeId === setupLog.worktreeId
            ? {
                ...prev,
                running: false,
                streamError:
                  err instanceof Error
                    ? err.message
                    : "Failed to run setup script",
              }
            : prev,
        );
      } finally {
        setupRunCancelRef.current = null;
      }
    })();
  };

  // Make sure an in-flight run is cancelled if the component unmounts.
  useEffect(() => {
    return () => {
      setupRunCancelRef.current?.();
    };
  }, []);

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
      <ScrollArea className="flex-1 overflow-hidden px-3">
        <div className="flex items-center justify-between gap-2 py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            On radar
          </span>
        </div>

        <div className="flex flex-col gap-1 pb-3">
          {focusQueue.length === 0 ? (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              No sessions on radar
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
          <button
            type="button"
            onClick={onNewProject}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            title="New project"
            aria-label="New project"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span>New</span>
          </button>
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
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void openSetupLog(
                                            project.id,
                                            project.name,
                                            worktree.id,
                                            worktree.name,
                                          );
                                        }}
                                        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-destructive/15 align-middle text-destructive transition-colors hover:bg-destructive/25 focus:outline-none focus:ring-1 focus:ring-destructive"
                                        title="Setup failed — click to view log"
                                        aria-label={`View setup log for ${worktree.name}`}
                                      >
                                        <AlertTriangle className="h-3 w-3" />
                                      </button>
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
                                      dirtyFiles: null,
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
                                    {/* Issue #351: parent / child
                                        subtree. Group the visible
                                        sessions by `parentId` so a
                                        parent can render its children
                                        inline below, indented one
                                        level. Parents whose children
                                        include at least one `active`
                                        child are auto-expanded on
                                        first render; the user can
                                        collapse / re-expand via a
                                        chevron on the parent row.
                                        Cross-worktree children (a
                                        parent on the main worktree
                                        with a child on a feature
                                        worktree) are NOT rendered
                                        here — `visibleSessions` is
                                        already worktree-scoped, and
                                        issue #351's "Decisions"
                                        section explicitly excludes
                                        cross-worktree recursion in
                                        v1. */}
                                    {(() => {
                                      const parentGroups =
                                        groupSessionsByParent(
                                          visibleSessions,
                                        );
                                      const expandedSet =
                                        expandedSubtreeIds;
                                      return parentGroups.roots.map(
                                        (session) => {
                                          const children =
                                            parentGroups.childrenByParent.get(
                                              session.id,
                                            );
                                          const hasChildren =
                                            !!children &&
                                            children.length > 0;
                                          // Auto-expand on first
                                          // render when the helper
                                          // says so. The check uses
                                          // `expandedSet.has(...)` as
                                          // a proxy for "the user has
                                          // explicitly toggled this
                                          // parent" so an explicit
                                          // collapse sticks.
                                          const isExpanded =
                                            hasChildren &&
                                            (expandedSet.has(session.id) ||
                                              (isSubtreeExpandedByDefault(
                                                children ?? [],
                                              ) &&
                                                !expandedSet.has(
                                                  `__collapsed__${session.id}`,
                                                )));
                                          return (
                                            <div
                                              key={session.id}
                                              className="flex flex-col"
                                            >
                                              <div className="group/session flex items-center">
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
                                                    session.id ===
                                                      activeSessionId
                                                      ? "bg-sidebar-accent text-sidebar-foreground"
                                                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                                                  )}
                                                >
                                                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate pr-2">
                                                    {hasChildren ? (
                                                      <button
                                                        type="button"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          toggleSubtree(
                                                            session.id,
                                                            isExpanded,
                                                          );
                                                        }}
                                                        aria-label={
                                                          isExpanded
                                                            ? "Collapse children"
                                                            : "Expand children"
                                                        }
                                                        aria-expanded={
                                                          isExpanded
                                                        }
                                                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground"
                                                      >
                                                        {isExpanded ? (
                                                          <ChevronDown className="h-3 w-3" />
                                                        ) : (
                                                          <ChevronRight className="h-3 w-3" />
                                                        )}
                                                      </button>
                                                    ) : null}
                                                    <SessionProviderIcon
                                                      provider={
                                                        session.provider
                                                      }
                                                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                                    />
                                                    {awaitingInputSessionIds.has(
                                                      session.id,
                                                    ) ? (
                                                      <span
                                                        className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
                                                        title="Awaiting your input"
                                                        aria-label="Awaiting your input"
                                                      />
                                                    ) : null}
                                                    <span className="truncate">
                                                      {session.title ||
                                                        session.id.slice(0, 8)}
                                                    </span>
                                                    {hasChildren ? (
                                                      <span
                                                        className="ml-1 shrink-0 rounded-full bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                                                        title={`${children.length} child session${children.length === 1 ? "" : "s"}`}
                                                      >
                                                        {children.length}
                                                      </span>
                                                    ) : null}
                                                  </span>
                                                  {activeSessionIds.has(
                                                    session.id,
                                                  ) ? (
                                                    <Loader2 className="hidden h-3 w-3 shrink-0 animate-spin text-muted-foreground md:inline md:group-hover/session:hidden" />
                                                  ) : (
                                                    <span className="hidden shrink-0 text-xs text-muted-foreground md:inline md:group-hover/session:hidden">
                                                      {formatTime(
                                                        session.lastActiveAt,
                                                      )}
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
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      void requestArchive(
                                                        project.id,
                                                        session.id,
                                                        worktree.id,
                                                      );
                                                    }}
                                                    onMouseEnter={() => {
                                                      void loadArchiveBlockers(
                                                        project.id,
                                                        session.id,
                                                        worktree.id,
                                                      );
                                                    }}
                                                    aria-disabled={
                                                      checkingArchiveIds.has(
                                                        session.id,
                                                      ) ||
                                                      (archiveBlockersBySession[
                                                        session.id
                                                      ]?.length ?? 0) > 0
                                                    }
                                                    className={cn(
                                                      "inline-flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors md:hidden md:group-hover/session:inline-flex",
                                                      (checkingArchiveIds.has(
                                                        session.id,
                                                      ) ||
                                                        (archiveBlockersBySession[
                                                          session.id
                                                        ]?.length ?? 0) > 0) &&
                                                        "cursor-not-allowed opacity-50",
                                                    )}
                                                    title={
                                                      checkingArchiveIds.has(
                                                        session.id,
                                                      )
                                                        ? "Checking archive status…"
                                                        : archiveBlockersBySession[
                                                              session.id
                                                            ]?.length
                                                          ? `Cannot archive: ${describeArchiveBlockers(archiveBlockersBySession[session.id])}`
                                                          : "Archive session"
                                                    }
                                                  >
                                                    <Archive className="h-3.5 w-3.5" />
                                                  </span>
                                                </button>
                                              </div>
                                              {hasChildren && isExpanded ? (
                                                <div
                                                  className="ml-6 flex flex-col border-l border-sidebar-border pl-2"
                                                  data-testid={`subtree-${session.id}`}
                                                >
                                                  {children.map((child) => (
                                                    <div
                                                      key={child.id}
                                                      className="group/child flex items-center"
                                                    >
                                                      <button
                                                        onClick={() =>
                                                          onSelectSession(
                                                            project.id,
                                                            child.id,
                                                            worktree.id,
                                                          )
                                                        }
                                                        className={cn(
                                                          "flex flex-1 items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm transition-colors min-w-0",
                                                          child.id ===
                                                            activeSessionId
                                                            ? "bg-sidebar-accent text-sidebar-foreground"
                                                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                                                        )}
                                                      >
                                                        <span className="flex min-w-0 flex-1 items-center gap-2 truncate pr-2">
                                                          <SessionProviderIcon
                                                            provider={
                                                              child.provider
                                                            }
                                                            className="h-3 w-3 shrink-0 text-muted-foreground"
                                                          />
                                                          {awaitingInputSessionIds.has(
                                                            child.id,
                                                          ) ? (
                                                            <span
                                                              className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
                                                              title="Awaiting your input"
                                                              aria-label="Awaiting your input"
                                                            />
                                                          ) : null}
                                                          <span className="truncate text-xs">
                                                            {child.title ||
                                                              child.id.slice(
                                                                0,
                                                                8,
                                                              )}
                                                          </span>
                                                        </span>
                                                        {activeSessionIds.has(
                                                          child.id,
                                                        ) ? (
                                                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                                                        ) : (
                                                          <span className="text-xs text-muted-foreground">
                                                            {formatTime(
                                                              child.lastActiveAt,
                                                            )}
                                                          </span>
                                                        )}
                                                        <span
                                                          role="button"
                                                          tabIndex={0}
                                                          onClick={(e) => {
                                                            e.stopPropagation();
                                                            void requestArchive(
                                                              project.id,
                                                              child.id,
                                                              worktree.id,
                                                            );
                                                          }}
                                                          onMouseEnter={() => {
                                                            void loadArchiveBlockers(
                                                              project.id,
                                                              child.id,
                                                              worktree.id,
                                                            );
                                                          }}
                                                          aria-disabled={
                                                            checkingArchiveIds.has(
                                                              child.id,
                                                            ) ||
                                                            (archiveBlockersBySession[
                                                              child.id
                                                            ]?.length ?? 0) >
                                                              0
                                                          }
                                                          className={cn(
                                                            "inline-flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors md:hidden md:group-hover/child:inline-flex",
                                                            (checkingArchiveIds.has(
                                                              child.id,
                                                            ) ||
                                                              (archiveBlockersBySession[
                                                                child.id
                                                              ]?.length ?? 0) >
                                                                0) &&
                                                              "cursor-not-allowed opacity-50",
                                                          )}
                                                          title={
                                                            checkingArchiveIds.has(
                                                              child.id,
                                                            )
                                                              ? "Checking archive status…"
                                                              : archiveBlockersBySession[
                                                                    child.id
                                                                  ]?.length
                                                                ? `Cannot archive: ${describeArchiveBlockers(archiveBlockersBySession[child.id])}`
                                                                : "Archive session"
                                                          }
                                                        >
                                                          <Archive className="h-3 w-3" />
                                                        </span>
                                                      </button>
                                                    </div>
                                                  ))}
                                                </div>
                                              ) : null}
                                            </div>
                                          );
                                        },
                                      );
                                    })()}
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
      <SidebarBottomBar onSettings={onSettings} />

      <Dialog
        open={!!confirmDeleteProjectId}
        onOpenChange={(open) => {
          if (!open && !deletingProject) setConfirmDeleteProjectId(null);
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
            <DialogClose
              render={<Button variant="outline" disabled={deletingProject} />}
            >
              Cancel
            </DialogClose>
            <DestructiveConfirmButton
              loading={deletingProject}
              onClick={confirmDeleteProject}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmDeleteWorktree}
        onOpenChange={(open) => {
          if (!open && !deletingWorktree) setConfirmDeleteWorktree(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {confirmDeleteWorktree?.dirtyFiles
                ? "Force delete worktree"
                : "Delete worktree"}
            </DialogTitle>
            <DialogDescription>
              {confirmDeleteWorktree?.dirtyFiles ? (
                <>
                  Worktree{" "}
                  <span className="font-medium text-foreground">
                    {confirmDeleteWorktree.name}
                  </span>{" "}
                  has uncommitted changes. Force-deleting will discard
                  them permanently (the orchestrator runs the
                  project&apos;s <code>archive.sh</code> first, when
                  one is configured, and refuses otherwise).
                </>
              ) : (
                <>
                  Delete worktree{" "}
                  <span className="font-medium text-foreground">
                    {confirmDeleteWorktree?.name}
                  </span>
                  ? This removes the directory from disk. The git
                  branch is kept.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {confirmDeleteWorktree?.dirtyFiles && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
              <p className="mb-1 font-medium text-destructive">
                Uncommitted changes:
              </p>
              <ul className="list-disc space-y-0.5 pl-5 font-mono text-foreground/80">
                {confirmDeleteWorktree.dirtyFiles
                  .slice(0, 10)
                  .map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                {confirmDeleteWorktree.dirtyFiles.length > 10 && (
                  <li>
                    … and {confirmDeleteWorktree.dirtyFiles.length - 10}{" "}
                    more
                  </li>
                )}
              </ul>
            </div>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={deletingWorktree} />}
            >
              Cancel
            </DialogClose>
            <DestructiveConfirmButton
              loading={deletingWorktree}
              onClick={confirmDeleteWorktreeAction}
              label={
                confirmDeleteWorktree?.dirtyFiles ? "Force delete" : undefined
              }
            />
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

      <Dialog
        open={!!setupLog}
        onOpenChange={(open) => {
          if (!open) closeSetupLog();
        }}
      >
        <DialogContent
          showCloseButton={!setupLog?.running}
          className="sm:max-w-2xl"
        >
          {setupLog && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  Setup failed
                </DialogTitle>
                <DialogDescription>
                  {setupLog.projectName} /{" "}
                  <span className="font-medium text-foreground">
                    {setupLog.worktreeName}
                  </span>
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Exit code:{" "}
                  <span className="font-mono text-foreground">
                    {setupLog.exitCode == null ? "—" : setupLog.exitCode}
                  </span>
                </span>
                <span>
                  Last run:{" "}
                  <span className="font-mono text-foreground">
                    {setupLog.ranAt
                      ? new Date(setupLog.ranAt).toLocaleString()
                      : "—"}
                  </span>
                </span>
              </div>

              <div className="rounded-md border border-border bg-zinc-950">
                <ScrollArea className="h-72 w-full">
                  <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-zinc-100">
                    {setupLog.loading
                      ? "Loading setup log…"
                      : setupLog.running
                        ? setupLog.lines.join("\n") +
                          (setupLog.lines.length === 0
                            ? "Waiting for output…"
                            : "")
                        : setupLog.log ?? "(no log content)"}
                  </pre>
                </ScrollArea>
              </div>

              {(setupLog.error || setupLog.streamError) && (
                <p className="text-xs text-destructive">
                  {setupLog.error ?? setupLog.streamError}
                </p>
              )}

              <DialogFooter>
                <DialogClose
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={setupLog.running}
                    />
                  }
                >
                  Close
                </DialogClose>
                <Button
                  type="button"
                  onClick={() => void rerunSetup()}
                  disabled={setupLog.running}
                >
                  {setupLog.running ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Running…
                    </>
                  ) : (
                    <>
                      <RotateCw className="h-3.5 w-3.5" />
                      Re-run setup
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!confirmArchiveSession}
        onOpenChange={(open) => {
          if (!open) setConfirmArchiveSession(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this session?</AlertDialogTitle>
            <AlertDialogDescription>
              You can find it later in the archived sessions view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archivingSession}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archivingSession}
              onClick={async (event) => {
                event.preventDefault();
                if (!confirmArchiveSession) return;
                const { projectId, sessionId, worktreeId } = confirmArchiveSession;
                setArchivingSession(true);
                try {
                  await archiveSession(projectId, sessionId, worktreeId);
                  setArchivedIds((prev) => new Set(prev).add(sessionId));
                  setProjectData((prev) =>
                    prev.map((p) =>
                      p.id === projectId
                        ? {
                            ...p,
                            worktrees: p.worktrees.map((w) =>
                              w.id === worktreeId
                                ? {
                                    ...w,
                                    sessions: w.sessions.filter(
                                      (s) => s.id !== sessionId,
                                    ),
                                  }
                                : w,
                            ),
                          }
                        : p,
                    ),
                  );
                  setConfirmArchiveSession(null);
                  toast.success("Session archived");
                } catch (error) {
                  // The server re-checks blockers atomically at archive time;
                  // a monitor or queued message can appear after preflight.
                  // Keep the row/dialog intact and surface that rejection.
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Failed to archive session",
                  );
                  await loadArchiveBlockers(projectId, sessionId, worktreeId);
                } finally {
                  setArchivingSession(false);
                }
              }}
            >
              {archivingSession ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
