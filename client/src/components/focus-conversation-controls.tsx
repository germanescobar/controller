import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Pause, Plus, StepForward } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatChord, isMacPlatform } from "@/lib/shortcut-match";
import type { ShortcutBindings } from "../../../shared/shortcuts.ts";
import type {
  SessionChildSummary,
  SessionSummary,
} from "../api.ts";

interface FocusConversationControlsProps {
  variant: "mobile" | "desktop";
  bindings: ShortcutBindings | null;
  isOnRadar: boolean;
  autoAdvance: boolean;
  onNext: () => void;
  onDone: () => void;
  onAddToRadar: () => void;
  onToggleAutoAdvance: () => void;
  countdown?: {
    scheduledAt: number;
    durationMs: number;
    onStay: () => void;
  } | null;
  /**
   * The current session's parent, or `null`/undefined when this
   * session has no parent (issue #384). When set, the panel
   * renders a single `Parent` row with the parent's clickable
   * truncated title.
   */
  parent?: SessionSummary | null;
  /**
   * The current session's children. When non-empty, the panel
   * renders a `Children` row with one clickable truncated title
   * per child.
   */
  children?: SessionChildSummary[];
  /**
   * Project id of the current session. Required to build the
   * `controller://` anchor for the parent; children summaries
   * already carry their own projectId so the child's anchor is
   * always self-sufficient.
   */
  currentProjectId?: string;
  /**
   * Navigates to another conversation referenced by a
   * `controller://` link. Wires the parent/children clicks to
   * the existing session-switch plumbing (no extra IPC).
   */
  onOpenConversation?: (target: {
    projectId: string;
    worktreeId: string;
    sessionId: string;
  }) => void;
}

const MAX_RELATIONSHIP_TITLE_LENGTH = 40;

/**
 * Truncate a session title for the panel rows. Long titles would
 * otherwise wrap inside the narrow floating panel and steal space
 * from the Next/Done buttons. The "Untitled conversation" fallback
 * mirrors the rest of the client when a session has no `title`.
 */
function truncateTitle(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Untitled conversation";
  if (text.length <= MAX_RELATIONSHIP_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_RELATIONSHIP_TITLE_LENGTH)}…`;
}

function buildControllerUri(
  projectId: string,
  worktreeId: string,
  sessionId: string
): string {
  return `controller://project/${projectId}/worktree/${worktreeId}/session/${sessionId}`;
}

export function FocusConversationControls({
  variant,
  bindings,
  isOnRadar,
  autoAdvance,
  onNext,
  onDone,
  onAddToRadar,
  onToggleAutoAdvance,
  countdown = null,
  parent = null,
  children = [],
  currentProjectId,
  onOpenConversation,
}: FocusConversationControlsProps) {
  const nextChord = formatChord(
    bindings?.focusAdvanceNext ?? "ctrl-n",
    isMacPlatform(),
  );
  const doneChord = formatChord(
    bindings?.focusDone ?? "ctrl-d",
    isMacPlatform(),
  );
  const autoAdvanceChord = formatChord(
    bindings?.focusAutoAdvance ?? "ctrl-t",
    isMacPlatform(),
  );
  const stayChord = formatChord(
    bindings?.focusStay ?? "ctrl-s",
    isMacPlatform(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!countdown) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [countdown?.scheduledAt]);

  const elapsedMs = countdown
    ? Math.max(0, now - countdown.scheduledAt)
    : 0;
  const remainingProgress = countdown
    ? Math.max(0, 1 - elapsedMs / countdown.durationMs)
    : 0;
  const secondsRemaining = countdown
    ? Math.max(0, Math.ceil((countdown.durationMs - elapsedMs) / 1000))
    : 0;

  // The parent row needs the current session's project id; the
  // children summaries already carry projectId so they're
  // self-sufficient. The parent row is hidden if the project id
  // isn't known yet (e.g. the very first render before
  // SessionView has hydrated) — the URI would be malformed
  // otherwise.
  //
  // Issue #384 explicit out-of-scope: the mobile header carries
  // this component in a tight horizontal strip, so the multi-line
  // rows stay desktop-only. The mobile variant still receives
  // the props (the same component is mounted twice), but the
  // rows are not rendered there. A future "expandable drawer"
  // refactor will own the mobile surface.
  const isDesktop = variant === "desktop";
  const parentTargetProjectId =
    currentProjectId && parent?.id ? currentProjectId : null;
  const parentWorktreeId = parent?.worktreeId ?? "";
  const showParentRow =
    isDesktop &&
    Boolean(parent && parent.id) &&
    Boolean(parentTargetProjectId);
  const showChildrenRow =
    isDesktop && Array.isArray(children) && children.length > 0;
  const showRelationships = showParentRow || showChildrenRow;

  const handleOpenTarget = (
    event: React.MouseEvent<HTMLAnchorElement>,
    target: {
      projectId: string;
      worktreeId: string;
      sessionId: string;
    }
  ) => {
    event.preventDefault();
    onOpenConversation?.(target);
  };

  return (
    <div
      data-testid={`focus-conversation-controls-${variant}`}
      className={cn(
        "gap-2 overflow-hidden border-blue-500/20 bg-background/95 backdrop-blur",
        variant === "mobile"
          ? "relative flex shrink-0 items-center justify-between border-b px-2 py-2 md:hidden"
          : "absolute right-4 top-4 z-20 hidden flex-col items-stretch rounded-lg border px-3 py-2 shadow-lg md:flex",
      )}
    >
      {countdown ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-blue-500" />
          <span className="truncate">Advancing in {secondsRemaining}s</span>
        </div>
      ) : (
        <label
          className={cn(
            "flex shrink-0 items-center gap-2 px-1 text-xs text-muted-foreground",
            variant === "desktop" && "w-full justify-between",
          )}
          title={
            variant === "desktop"
              ? `Toggle auto-advance (${autoAdvanceChord})`
              : undefined
          }
        >
          <span className="flex items-center gap-1.5">
            Auto-advance
            {variant === "desktop" ? <Kbd>{autoAdvanceChord}</Kbd> : null}
          </span>
          <Switch
            checked={autoAdvance}
            onCheckedChange={onToggleAutoAdvance}
            aria-label="Auto advance"
            className="scale-90"
          />
        </label>
      )}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1",
          variant === "desktop" && "w-full justify-end",
        )}
      >
        {countdown ? (
          <button
            type="button"
            onClick={countdown.onStay}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Stay (${stayChord})` : undefined}
          >
            <Pause className="h-3.5 w-3.5" />
            Stay
            {variant === "desktop" ? <Kbd>{stayChord}</Kbd> : null}
          </button>
        ) : isOnRadar ? (
          <button
            type="button"
            onClick={onDone}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Mark done (${doneChord})` : undefined}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done
            {variant === "desktop" ? <Kbd>{doneChord}</Kbd> : null}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddToRadar}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
          >
            <Plus className="h-3.5 w-3.5" />
            Add to radar
          </button>
        )}
        {!countdown || variant === "desktop" ? (
          <button
            type="button"
            onClick={onNext}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Next (${nextChord})` : undefined}
          >
            <StepForward className="h-3.5 w-3.5" />
            Next
            {variant === "desktop" ? <Kbd>{nextChord}</Kbd> : null}
          </button>
        ) : null}
      </div>
      {showRelationships ? (
        <div
          data-testid={`focus-conversation-relationships-${variant}`}
          className="flex min-w-0 flex-col gap-1 border-t border-blue-500/20 pt-1.5 text-xs text-muted-foreground"
        >
          {showParentRow ? (
            <div
              data-testid="focus-conversation-relationship-parent"
              className="flex min-w-0 flex-col"
            >
              <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground/80">
                Parent
              </span>
              <a
                href={buildControllerUri(
                  parentTargetProjectId!,
                  parentWorktreeId,
                  parent!.id
                )}
                onClick={(event) =>
                  handleOpenTarget(event, {
                    projectId: parentTargetProjectId!,
                    worktreeId: parentWorktreeId,
                    sessionId: parent!.id,
                  })
                }
                title={parent?.title ?? "Parent conversation"}
                className="min-w-0 truncate text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
              >
                {truncateTitle(parent?.title)}
              </a>
            </div>
          ) : null}
          {showChildrenRow ? (
            <div
              data-testid="focus-conversation-relationship-children"
              className="flex min-w-0 flex-col gap-0.5"
            >
              <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground/80">
                Children
              </span>
              {children!.map((child) => {
                const childProjectId = child.projectId;
                // Empty projectId on a child means the server's
                // two walks found no project for it (archived
                // between walks — see `server/routes/sessions.ts`).
                // Render the title as plain text so the panel is
                // not missing a row, but don't wire it up as a link.
                if (!childProjectId) {
                  return (
                    <span
                      key={child.id}
                      title={child.title ?? "Child conversation"}
                      className="min-w-0 truncate text-xs text-muted-foreground"
                    >
                      {truncateTitle(child.title)}
                    </span>
                  );
                }
                const childWorktreeId = child.worktreeId ?? "";
                return (
                  <a
                    key={child.id}
                    href={buildControllerUri(
                      childProjectId,
                      childWorktreeId,
                      child.id
                    )}
                    onClick={(event) =>
                      handleOpenTarget(event, {
                        projectId: childProjectId,
                        worktreeId: childWorktreeId,
                        sessionId: child.id,
                      })
                    }
                    title={child.title ?? "Child conversation"}
                    className="min-w-0 truncate text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {truncateTitle(child.title)}
                  </a>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {countdown ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div
            className="h-full bg-blue-500 transition-[width] duration-200 ease-linear"
            style={{ width: `${remainingProgress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
