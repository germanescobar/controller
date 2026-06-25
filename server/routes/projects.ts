import { Router } from "express";
import { getProjects, addProject, updateProject, deleteProject } from "../lib/projects.js";
import { ensureMainWorktree } from "../lib/worktrees.js";
import { emitProjectEvent } from "../lib/events.js";

export const projectsRouter = Router();

projectsRouter.get("/", async (_req, res) => {
  try {
    const projects = await getProjects();
    res.json(projects);
  } catch (err) {
    console.error("GET /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

projectsRouter.post("/", async (req, res) => {
  try {
    const { name, path, setupCommands, runCommands } = req.body as {
      name: string;
      path: string;
      setupCommands?: string;
      runCommands?: string;
    };
    if (!name || !path) {
      res.status(400).json({ error: "name and path are required" });
      return;
    }
    const project = await addProject(name, path, setupCommands, runCommands);
    await ensureMainWorktree(project);
    // Sidebar in other windows refreshes the project list when it sees
    // this (issue #210).
    emitProjectEvent({ type: "project_added", project });
    res.status(201).json(project);
  } catch (err) {
    console.error("POST /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

projectsRouter.put("/:id", async (req, res) => {
  try {
    const { name, setupCommands, runCommands } = req.body as {
      name?: string;
      setupCommands?: string;
      runCommands?: string;
    };
    const updated = await updateProject(req.params.id, { name, setupCommands, runCommands });
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    emitProjectEvent({ type: "project_updated", project: updated });
    res.json(updated);
  } catch (err) {
    console.error("PUT /projects/:id error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

projectsRouter.delete("/:id", async (req, res) => {
  try {
    const deleted = await deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    emitProjectEvent({ type: "project_removed", projectId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
