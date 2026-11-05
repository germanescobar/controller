import { useState } from "react";

export function SourceImagePreview({ projectId, worktreeId, path }: {
  projectId: string;
  worktreeId?: string;
  path: string;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const params = new URLSearchParams({ path, format: "image" });
  if (worktreeId) params.set("worktreeId", worktreeId);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-4">
      {status === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading image…</p>}
      {status === "error" ? <p role="alert" className="text-sm text-muted-foreground">Unable to load image preview.</p> : (
        <img
          src={`/api/projects/${encodeURIComponent(projectId)}/source?${params}`}
          alt={path.split("/").pop() || path}
          className={`min-h-0 max-h-full max-w-full object-contain ${status === "loading" ? "hidden" : ""}`}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
        />
      )}
    </div>
  );
}
