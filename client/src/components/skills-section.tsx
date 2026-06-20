import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Check,
  X,
  Loader2,
  Search,
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
import {
  fetchUnifiedSkills,
  createUnifiedSkill,
  updateUnifiedSkill,
  deleteUnifiedSkill,
  type UnifiedSkill,
  type UnifiedSkillInput,
} from "../api.ts";

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
  }, []);

  const openCreate = useCallback(() => {
    resetForm();
    setDialogOpen(true);
  }, [resetForm]);

  const openEdit = useCallback((skill: UnifiedSkill) => {
    // Pre-fill with a small default body so the editor is never empty.
    setForm({
      name: skill.name,
      description: skill.description,
      body: skill.path ? "" : "",
    });
    setEditingSkill(skill);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!dialogOpen || !editingSkill) return;
    // Fetch the full body when editing; metadata alone doesn't include it.
    let cancelled = false;
    void (async () => {
      try {
        const full = await fetchUnifiedSkill(editingSkill.name);
        if (!cancelled) {
          setForm((current) => ({
            ...current,
            body: full.body,
          }));
        }
      } catch {
        // Keep the placeholder body and let the user decide.
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
        <Button size="sm" onClick={openCreate} className="shrink-0 gap-1">
          <Plus className="h-3.5 w-3.5" />
          New skill
        </Button>
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
            <div className="min-w-0 flex-1">
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
            </div>
            <div className="flex shrink-0 items-center gap-1">
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
        <DialogContent className="max-w-2xl">
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
            <div className="grid grid-cols-2 gap-3">
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
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Short description shown in the picker"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Skill body
              </label>
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
    </div>
  );
}
