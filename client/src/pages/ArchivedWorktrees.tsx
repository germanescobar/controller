import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ChevronLeft, GitBranch, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  fetchWorktrees,
  purgeWorktree,
  restoreWorktree,
  subscribeProjectEvents,
  type ProjectEvent,
  type Worktree,
} from "../api.ts";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";

/**
 * Dedicated archive view for a single project. Lists every
 * worktree currently in the `removed` state (i.e. soft-archived)
 * with enough metadata to act on it: branch, last archive time,
 * setup status. Two actions per row:
 *
 *   • Unarchive — flips the registry row back to `active` so the
 *     worktree reappears in the normal sidebar. The directory on
 *     disk is untouched; sessions and terminal tabs stay wired up.
 *   • Delete forever — irreversibly purges the row, the per-worktree
 *     session history, and the terminal tabs. Surfaces a typed
 *     confirmation that names the worktree and reminds the user that
 *     session transcripts will be destroyed (issue UX spec).
 *
 * The list is the source of truth for the page; we always fetch
 * fresh on mount and re-fetch when a `worktree_added` /
 * `worktree_updated` / `worktree_removed` event arrives for this
 * project. The events stream is the same one the sidebar uses, so a
 * restore in another tab lands here without polling.
 */
export function ArchivedWorktrees({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  /** Display name only; falls back to "project" when missing. */
  projectName?: string;
  onClose: () => void;
}) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track which worktree id has an action in flight so the row can
  // show a spinner and disable the buttons during the request.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<Worktree | null>(null);
  // Two-step purge gate (issue UX spec): the destructive dialog is
  // only armed after the user types the literal worktree name. We
  // hold the typed value in state so the button stays disabled until
  // it matches exactly.
  const [purgeConfirmText, setPurgeConfirmText] = useState("");

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const rows = await fetchWorktrees(projectId, { includeRemoved: true });
      setWorktrees(rows.filter((row) => row.presence === "removed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load archived worktrees");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Live-refresh on worktree lifecycle events. A restore done in
  // another window re-archives here without polling; a fresh archive
  // appears within the 50 ms debounce.
  useEffect(() => {
    const source = subscribeProjectEvents(projectId, (event: ProjectEvent) => {
      if (
        event.type === "worktree_added" ||
        event.type === "worktree_updated" ||
        event.type === "worktree_removed"
      ) {
        void refresh();
      }
    });
    return () => source.close();
  }, [projectId, refresh]);

  const handleRestore = useCallback(
    async (worktree: Worktree) => {
      setBusyId(worktree.id);
      try {
        await restoreWorktree(projectId, worktree.id);
        toast.success(`Restored ${worktree.name}`);
        // Optimistic local update so the row disappears immediately;
        // the events stream will refetch shortly to confirm.
        setWorktrees((rows) => rows.filter((row) => row.id !== worktree.id));
        void refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to restore worktree");
      } finally {
        setBusyId(null);
      }
    },
    [projectId, refresh]
  );

  const handlePurge = useCallback(
    async (worktree: Worktree) => {
      setBusyId(worktree.id);
      try {
        await purgeWorktree(projectId, worktree.id);
        toast.success(`Deleted ${worktree.name} forever`);
        setWorktrees((rows) => rows.filter((row) => row.id !== worktree.id));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete worktree");
      } finally {
        setBusyId(null);
        setConfirmPurge(null);
        setPurgeConfirmText("");
      }
    },
    [projectId]
  );

  const sortedRows = useMemo(
    () =>
      [...worktrees].sort((a, b) => {
        // Newest archive first. `createdAt` is the registry creation
        // time, not the archive time — for an archived row that's
        // good enough as a stable secondary sort by name.
        return a.name.localeCompare(b.name);
      }),
    [worktrees]
  );

  const heading = projectName ? `Archived worktrees — ${projectName}` : "Archived worktrees";
  const purgeArmed = confirmPurge !== null && purgeConfirmText === confirmPurge.name;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Mobile header with back control. Mirrors SettingsPage so the
          navigation shape is consistent across full-page views. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 md:hidden">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          title="Back"
          aria-label="Back to project"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {heading}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:flex-row md:gap-6 md:p-6">
        {/* Left rail with the heading + description (desktop only;
            the mobile header above already shows the title). */}
        <aside className="hidden shrink-0 md:flex md:w-64 md:flex-col md:gap-2">
          <h1 className="text-lg font-semibold">{heading}</h1>
          <p className="text-sm text-muted-foreground">
            Archived worktrees are hidden from the normal sidebar. Restoring
            puts a worktree back exactly where it was. Deleting forever
            permanently removes its session history.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="mt-2 self-start"
          >
            <ChevronLeft className="mr-1.5 h-4 w-4" />
            Back to project
          </Button>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading archived worktrees…
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No archived worktrees for this project. Archiving a worktree
              from the sidebar will list it here.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedRows.map((worktree) => (
                <ArchivedWorktreeRow
                  key={worktree.id}
                  worktree={worktree}
                  busy={busyId === worktree.id}
                  onRestore={() => void handleRestore(worktree)}
                  onRequestPurge={() => {
                    setPurgeConfirmText("");
                    setConfirmPurge(worktree);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog
        open={confirmPurge !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmPurge(null);
            setPurgeConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete{" "}
              <span className="break-all font-mono text-base text-foreground">
                {confirmPurge?.name}
              </span>{" "}
              forever?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the worktree&apos;s record, every
              conversation stored on disk, and its terminal tabs. The
              worktree can&apos;t be restored afterwards — re-create it
              with{" "}
              <code className="rounded bg-muted px-1 text-xs">
                controller worktrees create
              </code>{" "}
              if you need it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="min-w-0 space-y-2">
            <label
              htmlFor="archived-worktree-purge-confirm"
              className="block text-xs text-muted-foreground"
            >
              Type{" "}
              <span className="font-mono text-foreground">
                {confirmPurge?.name}
              </span>{" "}
              to confirm:
            </label>
            <input
              id="archived-worktree-purge-confirm"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={purgeConfirmText}
              onChange={(e) => setPurgeConfirmText(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!purgeArmed}
              onClick={() => {
                if (confirmPurge) void handlePurge(confirmPurge);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busyId === confirmPurge?.id ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete forever"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ArchivedWorktreeRow({
  worktree,
  busy,
  onRestore,
  onRequestPurge,
}: {
  worktree: Worktree;
  busy: boolean;
  onRestore: () => void;
  onRequestPurge: () => void;
}) {
  // Useful for "what was it called when I archived it". The registry
  // doesn't currently store an explicit `archivedAt` timestamp; the
  // creation date is shown as a stable fallback so the user has at
  // least one chronological signal when scanning the list.
  const created = useMemo(() => formatDate(worktree.createdAt), [worktree.createdAt]);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Archive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm" title={worktree.name}>
              {worktree.name}
            </span>
            {worktree.branch && (
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                <GitBranch className="mr-1 h-3 w-3" />
                {worktree.branch}
              </Badge>
            )}
            {worktree.setupExitCode != null && worktree.setupExitCode !== 0 && (
              <Badge variant="outline" className="shrink-0 border-destructive/40 text-destructive text-[10px]">
                setup failed
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span title={worktree.path}>{worktree.path}</span>
            <span>archived · created {created}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:flex-row">
        <Button
          variant="outline"
          size="sm"
          onClick={onRestore}
          disabled={busy}
          title={`Restore ${worktree.name} to the sidebar`}
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
          )}
          Unarchive
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onRequestPurge}
          disabled={busy}
          title={`Permanently delete ${worktree.name}`}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete forever
        </Button>
      </div>
    </li>
  );
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
