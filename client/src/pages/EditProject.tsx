import { useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateProject, type Project } from "../api.ts";

interface EditProjectProps {
  project: Project;
  onSaved: (project: Project) => void;
  onCancel: () => void;
}

export function EditProject({ project, onSaved, onCancel }: EditProjectProps) {
  const [name, setName] = useState(project.name);
  const [setupCommands, setSetupCommands] = useState(project.setupCommands ?? "");
  const [runCommands, setRunCommands] = useState(project.runCommands ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProject(project.id, {
        name: name.trim(),
        setupCommands: setupCommands.trim() || "",
        runCommands: runCommands.trim() || "",
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save project");
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary">
            <Settings className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">Edit project</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Update the project name, setup commands, or run commands
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Project name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Directory path
            </label>
            <input
              value={project.path}
              disabled
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground font-mono"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Setup commands <span className="text-xs">(optional)</span>
            </label>
            <textarea
              value={setupCommands}
              onChange={(e) => setSetupCommands(e.target.value)}
              placeholder={"npm install\nnpm run build"}
              rows={5}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Runs once when a worktree is created (e.g. install dependencies).
              Available env vars: <code>$WORKTREE_PATH</code>,{" "}
              <code>$SOURCE_PATH</code> (project root), <code>$WORKTREE_NAME</code>,{" "}
              <code>$BRANCH</code>, <code>$PORT_OFFSET</code>.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Run commands <span className="text-xs">(optional)</span>
            </label>
            <textarea
              value={runCommands}
              onChange={(e) => setRunCommands(e.target.value)}
              placeholder={"npm run dev"}
              rows={4}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Starts the dev server for a worktree on demand. Same env vars as
              setup commands.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={saving || !name.trim()} className="flex-1">
              {saving ? "Saving..." : "Save changes"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
