/*
 * Settings → Skills: import per-agent skills into the unified catalog (issue #145).
 *
 * The server scans every provider's user/system skill homes plus the repo
 * skill directories of every registered project. We present the result as a
 * checkbox list; the user picks what to promote and we POST the selections
 * to `/unified-skills/import`. Skills already in the unified catalog (by name)
 * are hidden by default behind a "Show already imported" toggle; an "Overwrite
 * existing" toggle lets the user re-import them to update from source.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Download,
  Loader2,
  Check,
  Minus,
  X,
  Folder,
  ChevronDown,
  ChevronRight,
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
  fetchImportableSkills,
  importUnifiedSkills,
  type ImportableSkill,
  type SkillImportResult,
  type SkillImportStatus,
} from "../api.ts";
import {
  buildCollisionMap,
  buildImportRequest,
  clearImportSelection,
  importSkillKey,
  selectAllImportable,
  setImportOverwrite,
  summarizeImportResults,
  toggleImportSelection,
} from "../lib/import-skills-helpers.ts";

interface ImportSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names of unified skills already in the catalog (case-insensitive). */
  existingNames: string[];
  /** Called after a successful import so the parent can refresh. */
  onImported?: () => void;
}

interface SelectionState {
  selected: Set<string>;
  overwrite: boolean;
}

const STATUS_LABEL: Record<SkillImportStatus, string> = {
  imported: "Imported",
  skipped: "Already imported",
  error: "Error",
};

const STATUS_BADGE: Record<SkillImportStatus, string> = {
  imported: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  skipped: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/10 text-destructive border-destructive/30",
};

export function ImportSkillsDialog({
  open,
  onOpenChange,
  existingNames,
  onImported,
}: ImportSkillsDialogProps) {
  const [skills, setSkills] = useState<ImportableSkill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>({
    selected: new Set(),
    overwrite: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SkillImportResult[] | null>(null);
  // Skills already in the unified catalog are hidden by default; this reveals
  // them so the user can re-import (update) one with the overwrite toggle.
  const [showImported, setShowImported] = useState(false);

  // Reset transient state whenever the dialog re-opens so a previous run
  // doesn't leak into a fresh discovery.
  useEffect(() => {
    if (!open) return;
    setResults(null);
    setLoadError(null);
    setSubmitting(false);
  }, [open]);

  // Fetch the importable list when the dialog opens. We only depend on
  // `open` so the user can dismiss + reopen to re-scan.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSkills(null);
    setLoadError(null);
    setSelection({ selected: new Set(), overwrite: false });
    setShowImported(false);
    (async () => {
      try {
        const list = await fetchImportableSkills();
        if (!cancelled) setSkills(list);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to discover skills"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // A skill is "already imported" when a unified skill of the same name
  // exists. These are hidden by default (issue #145 feedback) so the list
  // focuses on what's new; the `showImported` toggle reveals them.
  const collisionByName = useMemo(
    () => (skills ? buildCollisionMap(skills, existingNames) : new Map()),
    [skills, existingNames]
  );
  const importedCount = useMemo(
    () => (skills ? skills.filter((s) => collisionByName.has(s.name)).length : 0),
    [skills, collisionByName]
  );
  const visibleSkills = useMemo(() => {
    if (!skills) return [];
    if (showImported) return skills;
    return skills.filter((s) => !collisionByName.has(s.name));
  }, [skills, showImported, collisionByName]);
  const grouped = useMemo(() => {
    const byProvider = new Map<string, ImportableSkill[]>();
    for (const s of visibleSkills) {
      const list = byProvider.get(s.providerId) ?? [];
      list.push(s);
      byProvider.set(s.providerId, list);
    }
    return Array.from(byProvider.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
  }, [visibleSkills]);

  const toggle = useCallback(
    (skill: ImportableSkill) => {
      setSelection((prev) => toggleImportSelection(prev, skill));
    },
    []
  );

  const selectAll = useCallback(() => {
    setSelection((prev) => selectAllImportable(prev, visibleSkills));
  }, [visibleSkills]);

  const clearAll = useCallback(() => {
    setSelection((prev) => clearImportSelection(prev));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!skills || selection.selected.size === 0) return;
    setSubmitting(true);
    setLoadError(null);
    try {
      const { selections } = buildImportRequest(selection, skills);
      const response = await importUnifiedSkills({ selections });
      setResults(response.results);
      const hasImported = response.results.some(
        (r) => r.status === "imported"
      );
      if (hasImported) onImported?.();
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to import skills"
      );
    } finally {
      setSubmitting(false);
    }
  }, [skills, selection, onImported]);

  const handleClose = useCallback(() => {
    if (submitting) return;
    onOpenChange(false);
  }, [submitting, onOpenChange]);

  const showResults = results !== null;
  const summary = useMemo(
    () => (results ? summarizeImportResults(results) : null),
    [results]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import per-agent skills</DialogTitle>
          <DialogDescription>
            Skills installed under Anita, Codex, and Claude (user, system, or
            project repo locations) can be promoted into the unified catalog
            so they win by name for every agent.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        )}

        {!showResults && (
          <>
            {skills === null ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Scanning per-agent skill homes...
              </div>
            ) : skills.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No importable skills found. Install skills under
                <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                  ~/.anita/skills
                </code>
                ,
                <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                  ~/.codex/skills
                </code>
                , or
                <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                  ~/.claude/skills
                </code>
                , or under a project&apos;s
                <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                  ./.anita/skills
                </code>
                directory.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    {importedCount > 0 && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={showImported}
                          onChange={(e) => setShowImported(e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-border"
                        />
                        Show already imported ({importedCount})
                      </label>
                    )}
                    {showImported && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={selection.overwrite}
                          onChange={(e) =>
                            setSelection((prev) =>
                              setImportOverwrite(prev, e.target.checked)
                            )
                          }
                          className="h-3.5 w-3.5 rounded border-border"
                        />
                        Re-import and overwrite
                      </label>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={selectAll}
                      className="h-7 px-2"
                    >
                      <Check className="mr-1 h-3 w-3" />
                      Select all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={clearAll}
                      className="h-7 px-2"
                    >
                      <X className="mr-1 h-3 w-3" />
                      Clear
                    </Button>
                  </div>
                </div>

                {visibleSkills.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    All discovered skills are already in the unified catalog.
                    Enable &ldquo;Show already imported&rdquo; to re-import one.
                  </div>
                ) : (
                  <>
                    <DiscoverList
                      grouped={grouped}
                      selected={selection.selected}
                      collisionByName={collisionByName}
                      onToggle={toggle}
                    />

                    <p className="text-xs text-muted-foreground">
                      {selection.selected.size} of {visibleSkills.length}{" "}
                      selected
                    </p>
                  </>
                )}
              </>
            )}
          </>
        )}

        {showResults && summary && (
          <ResultsView results={results ?? []} summary={summary} />
        )}

        <DialogFooter>
          {showResults ? (
            <Button onClick={handleClose}>Done</Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={
                  submitting ||
                  skills === null ||
                  selection.selected.size === 0
                }
              >
                {submitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                )}
                {selection.selected.size > 0
                  ? `Import (${selection.selected.size})`
                  : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DiscoverListProps {
  grouped: Array<[string, ImportableSkill[]]>;
  selected: Set<string>;
  collisionByName: Map<string, ImportableSkill[]>;
  onToggle: (skill: ImportableSkill) => void;
}

function DiscoverList({
  grouped,
  selected,
  collisionByName,
  onToggle,
}: DiscoverListProps) {
  // Start with all groups expanded — the list is small and collisions are
  // easier to spot when nothing is collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = (provider: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  return (
    <div className="max-h-80 space-y-2 overflow-y-auto rounded-md border border-border p-2">
      {grouped.map(([provider, items]) => {
        const isCollapsed = collapsed.has(provider);
        return (
          <div key={provider}>
            <button
              type="button"
              onClick={() => toggleGroup(provider)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/40"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {provider}
              <span className="font-normal text-muted-foreground/70">
                ({items.length})
              </span>
            </button>
            {!isCollapsed && (
              <div className="mt-1 space-y-1">
                {items.map((skill) => (
                  <DiscoverRow
                    key={importSkillKey(skill)}
                    skill={skill}
                    checked={selected.has(importSkillKey(skill))}
                    alreadyImported={collisionByName.has(skill.name)}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface DiscoverRowProps {
  skill: ImportableSkill;
  checked: boolean;
  alreadyImported: boolean;
  onToggle: (skill: ImportableSkill) => void;
}

function DiscoverRow({
  skill,
  checked,
  alreadyImported,
  onToggle,
}: DiscoverRowProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
        checked
          ? "border-primary/40 bg-primary/5"
          : "border-border hover:border-border/60 hover:bg-accent/30"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(skill)}
        className="mt-0.5 h-3.5 w-3.5 rounded border-border"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">/{skill.name}</span>
          <Badge variant="outline" className="text-[10px]">
            {skill.providerId}/{skill.scope}
          </Badge>
          {alreadyImported && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] text-muted-foreground"
              title="A unified skill with this name already exists. Enable “Re-import and overwrite” to update it."
            >
              <Check className="h-2.5 w-2.5" />
              Already imported
            </Badge>
          )}
        </div>
        {skill.description && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {skill.description}
          </p>
        )}
        {skill.projectPath && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/80">
            <Folder className="h-2.5 w-2.5" />
            {skill.projectPath}
          </p>
        )}
      </div>
    </label>
  );
}

interface ResultsViewProps {
  results: SkillImportResult[];
  summary: Record<SkillImportStatus, number>;
}

function ResultsView({ results, summary }: ResultsViewProps) {
  const imported = summary.imported;
  const skipped = summary.skipped;
  const errored = summary.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {imported > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
            <Check className="h-3 w-3" />
            {imported} imported
          </span>
        )}
        {skipped > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <Minus className="h-3 w-3" />
            {skipped} already imported
          </span>
        )}
        {errored > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
            <X className="h-3 w-3" />
            {errored} failed
          </span>
        )}
      </div>
      <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
        {results.map((r, i) => (
          <ResultRow key={`${r.providerId}-${r.scope}-${r.name}-${i}`} result={r} />
        ))}
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: SkillImportResult }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[result.status]}`}
        >
          {STATUS_LABEL[result.status]}
        </span>
        <span className="text-xs text-muted-foreground">
          {result.providerId}/{result.scope}
        </span>
        <span className="text-sm font-medium">
          {result.name || "(unknown)"}
        </span>
      </div>
      {result.reason && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {result.reason}
        </p>
      )}
    </div>
  );
}
