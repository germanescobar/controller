import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Pencil, Trash2, Loader2, Save, X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  fetchMemoryNotes,
  fetchMemoryNote,
  writeMemoryNote,
  deleteMemoryNote,
  fetchPinnedMemory,
  writePinnedMemory,
  type MemoryEntry,
  type MemoryScope,
} from "../api.ts";
import { fetchProjects, type Project } from "../api.ts";

/**
 * Settings → Memory panel (issue #350). Lists, edits, and deletes
 * notes for both the global and per-project scopes, with a working
 * `pinned.md` editor at the top of each scope. The user can switch
 * between projects when more than one is onboarded.
 *
 * Notes are plain Markdown under
 * `<controllerHome>/memory/<scope>/notes/<slug>.md`. The CLI does the
 * actual file work; this panel just calls the same REST endpoints the
 * CLI uses.
 */
export function MemorySection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [activeScope, setActiveScope] = useState<MemoryScope>("global");

  const [globalEntries, setGlobalEntries] = useState<MemoryEntry[]>([]);
  const [projectEntries, setProjectEntries] = useState<MemoryEntry[]>([]);
  const [globalPinned, setGlobalPinned] = useState("");
  const [projectPinned, setProjectPinned] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinnedDirty, setPinnedDirty] = useState(false);
  const [savingPinned, setSavingPinned] = useState(false);

  const [editingEntry, setEditingEntry] = useState<MemoryEntry | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBody, setEditorBody] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createSlug, setCreateSlug] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");

  const loadProjects = useCallback(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
      if (list.length > 0 && !selectedProjectId) {
        setSelectedProjectId(list[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    }
  }, [selectedProjectId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [globalRes, projectRes] = await Promise.all([
        fetchMemoryNotes({ scope: "global", includePinned: true }),
        selectedProjectId
          ? fetchMemoryNotes({
              scope: "project",
              projectId: selectedProjectId,
              includePinned: true,
            })
          : Promise.resolve({ entries: [] as MemoryEntry[], pinned: "" }),
      ]);
      setGlobalEntries(globalRes.entries);
      setGlobalPinned(globalRes.pinned ?? "");
      setProjectEntries(projectRes.entries);
      setProjectPinned(projectRes.pinned ?? "");
      setPinnedDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memory");
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeScopeEntries = activeScope === "global" ? globalEntries : projectEntries;
  const activeScopePinned = activeScope === "global" ? globalPinned : projectPinned;
  const activeProjectId = activeScope === "project" ? selectedProjectId || undefined : undefined;

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return activeScopeEntries;
    const q = searchQuery.toLowerCase();
    return activeScopeEntries.filter(
      (e) => e.slug.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q)
    );
  }, [activeScopeEntries, searchQuery]);

  const openEditor = useCallback(
    async (entry: MemoryEntry) => {
      setEditingEntry(entry);
      setEditorOpen(true);
      setEditorBody("");
      setEditorError(null);
      setEditorLoading(true);
      try {
        const full = await fetchMemoryNote({
          scope: entry.scope,
          slug: entry.slug,
          projectId: entry.projectId,
        });
        setEditorBody(full.content);
      } catch (err) {
        setEditorError(
          err instanceof Error ? err.message : "Failed to load note"
        );
      } finally {
        setEditorLoading(false);
      }
    },
    []
  );

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingEntry(null);
    setEditorBody("");
    setEditorError(null);
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editingEntry) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      await writeMemoryNote({
        scope: editingEntry.scope,
        slug: editingEntry.slug,
        content: editorBody,
        projectId: editingEntry.projectId,
      });
      await loadAll();
      closeEditor();
    } catch (err) {
      setEditorError(
        err instanceof Error ? err.message : "Failed to save note"
      );
    } finally {
      setEditorSaving(false);
    }
  }, [editingEntry, editorBody, loadAll, closeEditor]);

  const submitCreate = useCallback(async () => {
    if (!createSlug.trim() || !selectedProjectId && activeScope === "project") return;
    setCreateSaving(true);
    setCreateError(null);
    try {
      await writeMemoryNote({
        scope: activeScope,
        slug: createSlug.trim(),
        content: createBody,
        projectId: activeProjectId,
      });
      setCreateOpen(false);
      setCreateSlug("");
      setCreateBody("");
      await loadAll();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create note"
      );
    } finally {
      setCreateSaving(false);
    }
  }, [activeScope, activeProjectId, createSlug, createBody, loadAll, selectedProjectId]);

  const handleDelete = useCallback(
    async (entry: MemoryEntry) => {
      const ok = window.confirm(
        `Delete memory note "${entry.slug}" from ${entry.scope === "global" ? "global" : `project ${entry.projectId}`}? This cannot be undone.`
      );
      if (!ok) return;
      setDeletingSlug(entry.slug);
      try {
        await deleteMemoryNote({
          scope: entry.scope,
          slug: entry.slug,
          projectId: entry.projectId,
        });
        await loadAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete note");
      } finally {
        setDeletingSlug(null);
      }
    },
    [loadAll]
  );

  const savePinned = useCallback(async () => {
    setSavingPinned(true);
    setError(null);
    try {
      await writePinnedMemory({
        scope: activeScope,
        content: activeScopePinned,
        projectId: activeProjectId,
      });
      setPinnedDirty(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save pinned");
    } finally {
      setSavingPinned(false);
    }
  }, [activeScope, activeScopePinned, activeProjectId, loadAll]);

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <p>
          Memory is the Controller-owned layer that survives across sessions.
          The agent sees the <code className="rounded bg-muted px-1">&lt;memory_index&gt;</code>{" "}
          block in its preamble and reads full bodies on demand.
        </p>
        <p className="mt-1">
          Notes are plain Markdown under{" "}
          <code className="rounded bg-muted px-1">memory/&lt;scope&gt;/notes/&lt;slug&gt;.md</code>{" "}
          and <code className="rounded bg-muted px-1">pinned.md</code> is injected
          into every turn.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
          <button
            type="button"
            data-testid="memory-scope-global"
            onClick={() => setActiveScope("global")}
            className={`rounded px-3 py-1.5 transition-colors ${
              activeScope === "global"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Global
          </button>
          <button
            type="button"
            data-testid="memory-scope-project"
            onClick={() => setActiveScope("project")}
            disabled={projects.length === 0}
            className={`rounded px-3 py-1.5 transition-colors disabled:opacity-50 ${
              activeScope === "project"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Project
          </button>
        </div>

        {activeScope === "project" && projects.length > 0 && (
          <select
            data-testid="memory-project-select"
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter notes"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-md border border-border bg-background pl-7 pr-2 py-1.5 text-sm"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCreateOpen(true);
              setCreateSlug("");
              setCreateBody("");
              setCreateError(null);
            }}
            data-testid="memory-new-note"
          >
            <Plus className="h-3.5 w-3.5" />
            New note
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">pinned.md</div>
            <div className="text-xs text-muted-foreground">
              Always injected into the preamble for this scope.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={savePinned}
            disabled={!pinnedDirty || savingPinned}
          >
            {savingPinned ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
        <textarea
          data-testid="memory-pinned-editor"
          value={activeScopePinned}
          onChange={(e) => {
            setPinnedDirty(true);
            if (activeScope === "global") {
              setGlobalPinned(e.target.value);
            } else {
              setProjectPinned(e.target.value);
            }
          }}
          rows={6}
          placeholder={
            activeScope === "global"
              ? "Cross-project preferences, conventions, deploy notes…"
              : "Notes that only apply to this project…"
          }
          className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">Notes</div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        {filteredEntries.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            {searchQuery.trim()
              ? "No notes match the current filter."
              : "No notes yet. Use \"/controller-memory <text>\" in a session, or click \"New note\"."}
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {filteredEntries.map((entry) => (
              <li
                key={`${entry.scope}:${entry.projectId ?? "global"}:${entry.slug}`}
                className="flex items-start gap-3 p-3"
                data-testid="memory-entry"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{entry.slug}</span>
                    {entry.scope === "project" && (
                      <Badge variant="secondary" className="text-xs">
                        project
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {entry.preview || <em>(empty)</em>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => openEditor(entry)}
                    aria-label="Edit note"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => handleDelete(entry)}
                    disabled={deletingSlug === entry.slug}
                    aria-label="Delete note"
                  >
                    {deletingSlug === entry.slug ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingEntry?.slug}</DialogTitle>
            <DialogDescription>
              {editingEntry?.scope === "global"
                ? "Global memory note"
                : `Project memory note (${editingEntry?.projectId})`}
            </DialogDescription>
          </DialogHeader>
          {editorLoading ? (
            <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <textarea
              data-testid="memory-editor-body"
              value={editorBody}
              onChange={(e) => setEditorBody(e.target.value)}
              rows={16}
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
            />
          )}
          {editorError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              {editorError}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeEditor}>
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              onClick={saveEditor}
              disabled={editorLoading || editorSaving}
            >
              {editorSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New memory note</DialogTitle>
            <DialogDescription>
              {activeScope === "global"
                ? "Global note (visible to every session)"
                : `Project note (${selectedProjectId})`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="block text-sm font-medium">Slug</label>
            <input
              data-testid="memory-create-slug"
              type="text"
              value={createSlug}
              onChange={(e) => setCreateSlug(e.target.value)}
              placeholder="e.g. deploy-via-github-action"
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
            />
            <label className="block pt-2 text-sm font-medium">Body</label>
            <textarea
              data-testid="memory-create-body"
              value={createBody}
              onChange={(e) => setCreateBody(e.target.value)}
              rows={10}
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
            />
          </div>
          {createError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              {createError}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              disabled={createSaving || !createSlug.trim() || (activeScope === "project" && !selectedProjectId)}
            >
              {createSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
