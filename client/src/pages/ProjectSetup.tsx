import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createProject } from "../api.ts";

interface ProjectSetupProps {
  onCreated: () => void;
  onCancel: () => void;
}

export function ProjectSetup({ onCreated, onCancel }: ProjectSetupProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [setupCommands, setSetupCommands] = useState("");
  const [runCommands, setRunCommands] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    setLoading(true);
    await createProject(
      name.trim(),
      path.trim(),
      setupCommands.trim() || undefined,
      runCommands.trim() || undefined,
    );
    setLoading(false);
    onCreated();
  };

  const handleBrowse = async () => {
    // Only available when running inside the Electron wrapper; in a
    // plain browser the bridge isn't exposed and the button isn't
    // rendered (see the `controllerBridge` check below).
    const bridge = (window as { controller?: { pickDirectory?: () => Promise<string | null> } })
      .controller;
    if (!bridge?.pickDirectory) return;
    const picked = await bridge.pickDirectory();
    if (picked) setPath(picked);
  };

  const showBrowseButton = Boolean(
    (window as { controller?: { pickDirectory?: () => Promise<string | null> } }).controller
      ?.pickDirectory,
  );

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary">
            <FolderOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">Add a project</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Point to a local directory where the coding agent will work
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
              placeholder="my-project"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Directory path
            </label>
            <div className="flex gap-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/me/projects/my-project"
                className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
              {showBrowseButton && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleBrowse}
                  title="Pick a folder"
                >
                  Browse…
                </Button>
              )}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Setup commands <span className="text-xs">(optional)</span>
            </label>
            <textarea
              value={setupCommands}
              onChange={(e) => setSetupCommands(e.target.value)}
              placeholder={"npm install\nnpm run build"}
              rows={4}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y"
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
              rows={3}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Starts the dev server for a worktree on demand. Same env vars as
              setup commands.
            </p>
          </div>
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={loading || !name.trim() || !path.trim()} className="flex-1">
              {loading ? "Creating..." : "Create project"}
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
