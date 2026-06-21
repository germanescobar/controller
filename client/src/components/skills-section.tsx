import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Check,
  Loader2,
  Search,
  Download,
  Eye,
} from "lucide-react";
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchUnifiedSkills,
  fetchUnifiedSkill,
  createUnifiedSkill,
  updateUnifiedSkill,
  deleteUnifiedSkill,
  type UnifiedSkill,
  type UnifiedSkillInput,
} from "../api.ts";
import { ImportSkillsDialog } from "./import-skills-dialog.tsx";

export function SkillsSection() {
  const [skills, setSkills] = useState<UnifiedSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<UnifiedSkill | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [form, setForm] = useState<UnifiedSkillInput>({
    name: "",
    description: "",
    body: "",
  });
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [viewingSkill, setViewingSkill] = useState<UnifiedSkill | null>(null);
  const [viewBody, setViewBody] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewRaw, setViewRaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchUnifiedSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = useCallback(() => {
    setForm({ name: "", description: "", body: "" });
    setEditingSkill(null);
    setBodyError(null);
    setBodyLoading(false);
  }, []);

  const openCreate = useCallback(() => {
    resetForm();
    setDialogOpen(true);
  }, [resetForm]);

  const openEdit = useCallback((skill: UnifiedSkill) => {
    // Body is loaded asynchronously below; start empty until the fetch resolves.
    setForm({
      name: skill.name,
      description: skill.description,
      body: "",
    });
    setEditingSkill(skill);
    setDialogOpen(true);
  }, []);

  const openView = useCallback((skill: UnifiedSkill) => {
    setViewBody("");
    setViewRaw(false);
    setViewingSkill(skill);
  }, []);

  useEffect(() => {
    if (!viewingSkill) return;
    // Fetch the full body when viewing; the list only carries metadata.
    let cancelled = false;
    setViewLoading(true);
    setViewError(null);
    void (async () => {
      try {
        const full = await fetchUnifiedSkill(viewingSkill.name);
        if (!cancelled) setViewBody(full.body);
      } catch (err) {
        if (!cancelled) {
          setViewError(
            err instanceof Error ? err.message : "Failed to load skill body"
          );
        }
      } finally {
        if (!cancelled) setViewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewingSkill]);

  useEffect(() => {
    if (!dialogOpen || !editingSkill) return;
    // Fetch the full body when editing; metadata alone doesn't include it.
    let cancelled = false;
    setBodyLoading(true);
    setBodyError(null);
    void (async () => {
      try {
        const full = await fetchUnifiedSkill(editingSkill.name);
        if (!cancelled) {
          setForm((current) => ({
            ...current,
            body: full.body,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setBodyError(
            err instanceof Error ? err.message : "Failed to load skill body"
          );
        }
      } finally {
        if (!cancelled) setBodyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, editingSkill]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editingSkill) {
        await updateUnifiedSkill(editingSkill.name, form);
      } else {
        await createUnifiedSkill(form);
      }
      setDialogOpen(false);
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save skill");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeletingName(name);
    try {
      await deleteUnifiedSkill(name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete skill");
    } finally {
      setDeletingName(null);
    }
  };

  const filteredSkills = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle)
    );
  }, [skills, searchQuery]);

  const canSave =
    form.name.trim() && form.description.trim() && form.body.trim();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search unified skills..."
            className="w-full rounded-md border border-border bg-transparent py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImportDialogOpen(true)}
            className="gap-1"
            title="Import skills from per-agent locations"
          >
            <Download className="h-3.5 w-3.5" />
            Import
          </Button>
          <Button size="sm" onClick={openCreate} className="shrink-0 gap-1">
            <Plus className="h-3.5 w-3.5" />
            New skill
          </Button>
        </div>
      </div>

      {loading && skills.length === 0 && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading skills...
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {filteredSkills.map((skill) => (
          <div
            key={skill.name}
            className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
          >
            <button
              type="button"
              onClick={() => openView(skill)}
              className="min-w-0 flex-1 text-left"
              title="View skill"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm font-medium">/{skill.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  unified
                </Badge>
              </div>
              {skill.description && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {skill.description}
                </p>
              )}
            </button>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => openView(skill)}
                title="View skill"
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => openEdit(skill)}
                title="Edit skill"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void handleDelete(skill.name)}
                disabled={deletingName === skill.name}
                className="text-muted-foreground hover:text-destructive"
                title="Delete skill"
              >
                {deletingName === skill.name ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        ))}

        {!loading && filteredSkills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {searchQuery
                ? "No unified skills match your search."
                : "No unified skills yet. Create one to make it available across all agents."}
            </p>
          </div>
        )}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-2xl lg:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {editingSkill ? "Edit unified skill" : "Create unified skill"}
            </DialogTitle>
            <DialogDescription>
              Unified skills are available to every agent. They take precedence
              over per-agent skills with the same name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="e.g. github-issues"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                rows={3}
                placeholder="Short description shown in the picker"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                Skill body
                {bodyLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              </label>
              {bodyError && (
                <div className="mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {bodyError}
                </div>
              )}
              <textarea
                value={form.body}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, body: e.target.value }))
                }
                rows={12}
                placeholder={`# Skill instructions\n\nWrite the markdown body that will be prepended to the user message when this skill is active.`}
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                resetForm();
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={!canSave || saving}>
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              )}
              {editingSkill ? "Save changes" : "Create skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={viewingSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingSkill(null);
            setViewBody("");
            setViewError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl lg:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />/
              {viewingSkill?.name}
            </DialogTitle>
            {viewingSkill?.description && (
              <DialogDescription>{viewingSkill.description}</DialogDescription>
            )}
          </DialogHeader>
          {viewLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading skill...
            </div>
          ) : viewError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {viewError}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewRaw((prev) => !prev)}
                  className="h-7 text-xs text-muted-foreground"
                >
                  {viewRaw ? "Preview" : "View source"}
                </Button>
              </div>
              {viewRaw ? (
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
                  {viewBody}
                </pre>
              ) : (
                <div className="prose prose-invert prose-sm max-h-[60vh] max-w-none overflow-auto break-words rounded-md border border-border bg-muted/30 px-3 py-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {viewBody}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {viewingSkill && (
              <Button
                variant="outline"
                onClick={() => {
                  const skill = viewingSkill;
                  setViewingSkill(null);
                  openEdit(skill);
                }}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            <Button onClick={() => setViewingSkill(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportSkillsDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        existingNames={skills.map((s) => s.name)}
        onImported={() => void load()}
      />
    </div>
  );
}
