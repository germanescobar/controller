import { Router, type Request, type Response } from "express";
import {
  deleteMemory,
  getMemoryBackend,
  listMemory,
  readMemory,
  readPinnedMemory,
  writeMemory,
  writePinnedMemory,
  type MemoryScope,
} from "../lib/memory.js";
import { getProject } from "../lib/projects.js";

export const memoryRouter = Router();

/**
 * Resolve the `scope` and optional `projectId` query params into a
 * normalized `{ scope, projectId }` shape. Returns an error string when
 * the params are invalid; the route handler turns that into a 400.
 */
function resolveScopeArgs(req: Request):
  | { scope: MemoryScope; projectId?: string }
  | { error: string } {
  const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : "global";
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    return { error: `Unknown memory scope "${scopeRaw}". Use "global" or "project".` };
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    return { error: "Memory scope \"project\" requires a projectId query param." };
  }
  return { scope, projectId };
}

memoryRouter.get("/memory", async (req: Request, res: Response) => {
  const resolved = resolveScopeArgs(req);
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  if (resolved.scope === "project" && resolved.projectId) {
    const project = await getProject(resolved.projectId);
    if (!project) {
      res.status(404).json({ error: `Project "${resolved.projectId}" not found.` });
      return;
    }
  }
  const includePinned = req.query.includePinned === "1" || req.query.includePinned === "true";
  const [entries, pinned] = await Promise.all([
    listMemory({ scope: resolved.scope, projectId: resolved.projectId }),
    includePinned
      ? readPinnedMemory({ scope: resolved.scope, projectId: resolved.projectId })
      : Promise.resolve(undefined),
  ]);
  res.json({
    entries,
    ...(includePinned ? { pinned: pinned ?? "" } : {}),
  });
});

memoryRouter.get("/memory/:scope/:slug", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId query param." });
    return;
  }
  if (scope === "project" && projectId) {
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `Project "${projectId}" not found.` });
      return;
    }
  }
  const slug = String(req.params.slug);
  const note = await readMemory({ scope, slug, projectId });
  if (!note) {
    res.status(404).json({ error: `Memory note "${slug}" not found.` });
    return;
  }
  res.json({ entry: { slug: note.slug, scope: note.scope, projectId: note.projectId, preview: note.preview, mtimeMs: note.mtimeMs }, content: note.content });
});

memoryRouter.put("/memory/:scope/:slug", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.body?.projectId === "string" && req.body.projectId.trim()
      ? req.body.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId in the body." });
    return;
  }
  if (scope === "project" && projectId) {
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `Project "${projectId}" not found.` });
      return;
    }
  }
  const slug = String(req.params.slug);
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  const result = await writeMemory({ scope, slug, content, projectId });
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

memoryRouter.delete("/memory/:scope/:slug", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId query param." });
    return;
  }
  await deleteMemory({ scope, slug: String(req.params.slug), projectId });
  res.status(204).send();
});

memoryRouter.get("/memory/:scope/pinned", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId query param." });
    return;
  }
  const pinned = await readPinnedMemory({ scope, projectId });
  res.json({ content: pinned });
});

memoryRouter.put("/memory/:scope/pinned", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.body?.projectId === "string" && req.body.projectId.trim()
      ? req.body.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId in the body." });
    return;
  }
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  const result = await writePinnedMemory({ scope, content, projectId });
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/**
 * Search a memory scope via the configured backend. The agent uses this
 * to find notes whose slugs don't lexically match a query (e.g. when
 * the user says "what did we decide about deploys" and the matching
 * note is named `2026-01-15-deploy-rollback`).
 */
memoryRouter.get("/memory/:scope/search", async (req: Request, res: Response) => {
  const scopeRaw = String(req.params.scope);
  if (scopeRaw !== "global" && scopeRaw !== "project") {
    res.status(400).json({ error: `Unknown memory scope "${scopeRaw}".` });
    return;
  }
  const scope = scopeRaw;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    res.status(400).json({ error: "Memory scope \"project\" requires a projectId query param." });
    return;
  }
  const query = typeof req.query.query === "string" ? req.query.query : "";
  if (!query.trim()) {
    res.status(400).json({ error: "Memory search requires a non-empty query." });
    return;
  }
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;
  const backend = getMemoryBackend();
  const results = await backend.search({ scope, projectId, query, limit });
  res.json({ results });
});
