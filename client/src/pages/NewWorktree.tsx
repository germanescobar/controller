import { useState, useEffect } from "react";
import { GitBranchPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createWorktree, fetchBranches, type Project, type Worktree, type WorktreeCreateEvent } from "../api.ts";

interface NewWorktreeProps {
  project: Project;
  onCreated: (worktree: Worktree) => void;
  onCancel: () => void;
}

export function NewWorktree({ project, onCreated, onCancel }: NewWorktreeProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchBranches(project.id).then(({ branches, defaultBranch }) => {
      setBranches(branches);
      setDefaultBranch(defaultBranch);
      if (defaultBranch && branches.includes(defaultBranch)) {
        setBaseBranch(defaultBranch);
      }
    }).catch(() => {});
  }, [project.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    setLogLines([]);
    setDone(false);

    const { events, result } = createWorktree(project.id, {
      name: name.trim(),
      branch: branch.trim() || undefined,
      baseBranch: baseBranch || undefined,
    });

    (async () => {
      for await (const event of events as AsyncIterable<WorktreeCreateEvent>) {
        if (event.type === "log") {
          setLogLines((prev) => [...prev, event.text.replace(/\n$/, "")]);
        } else if (event.type === "error") {
          setError(event.text);
        } else if (event.type === "done") {
          setDone(true);
        }
      }
    })().catch(() => {});

    try {
      const worktree = await result;
      onCreated(worktree);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worktree");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary">
            <GitBranchPlus className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">New worktree</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a new worktree in{" "}
            <span className="font-medium text-foreground">{project.name}</span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              placeholder="feature-x"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Branch <span className="text-xs">(defaults to name)</span>
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={submitting}
              placeholder="optional"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Base branch
            </label>
            {branches.length > 0 ? (
              <select
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={submitting}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === defaultBranch ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={submitting}
                placeholder="defaults to current HEAD"
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>

          {logLines.length > 0 && (
            <pre className="w-full max-h-48 overflow-auto rounded-lg border border-border bg-black/30 p-3 text-xs text-muted-foreground">
              {logLines.join("\n")}
            </pre>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2 pt-2">
            {done ? (
              <Button type="button" onClick={onCancel} className="flex-1">
                Done
              </Button>
            ) : (
              <>
                <Button type="submit" disabled={submitting || !name.trim()} className="flex-1">
                  {submitting ? "Creating..." : "Create worktree"}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
