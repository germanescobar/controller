import { Router } from "express";
import { getProject } from "../lib/projects.js";
import { resolveWorktree } from "../lib/worktrees.js";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  listScheduleRuns,
  removeSchedule,
  setScheduleEnabled,
  type ScheduleInput,
} from "../lib/schedules.js";

/*
 * REST surface for schedules (issue #243), mirroring the `controller
 * schedules ...` CLI so a future UI can manage schedules over HTTP.
 * Mounted under `/api/projects`.
 */
export const schedulesRouter = Router();

schedulesRouter.get("/:projectId/schedules", async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const includeDisabled = req.query.includeDisabled !== "false";
    const schedules = await listSchedules(project.path, { includeDisabled });
    res.json(schedules);
  } catch (err) {
    console.error("GET /schedules error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

schedulesRouter.post("/:projectId/schedules", async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const body = (req.body ?? {}) as Partial<ScheduleInput>;
    if (typeof body.worktreeId !== "string" || !body.worktreeId) {
      res.status(400).json({ error: "worktreeId is required" });
      return;
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    if (!body.cron && !body.runAt) {
      res.status(400).json({ error: "either cron or runAt is required" });
      return;
    }

    const worktree = await resolveWorktree(project.id, body.worktreeId);
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    const schedule = await createSchedule(project.path, project.id, {
      worktreeId: worktree.id,
      prompt: body.prompt,
      provider: body.provider,
      model: body.model,
      mode: body.mode,
      cron: body.cron ?? null,
      timezone: body.timezone,
      runAt: body.runAt ?? null,
      enabled: body.enabled,
      source: body.source,
      createdBy: body.createdBy ?? "ui",
    });
    res.status(201).json(schedule);
  } catch (err) {
    // Validation failures (bad cron/timezone/timestamp) surface as 400s.
    res.status(400).json({ error: (err as Error).message });
  }
});

schedulesRouter.get("/:projectId/schedules/:scheduleId", async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const schedule = await getSchedule(project.path, req.params.scheduleId);
    if (!schedule) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    res.json(schedule);
  } catch (err) {
    console.error("GET /schedules/:id error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

schedulesRouter.get("/:projectId/schedules/:scheduleId/runs", async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const schedule = await getSchedule(project.path, req.params.scheduleId);
    if (!schedule) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    const runs = await listScheduleRuns(project.path, req.params.scheduleId);
    res.json(runs);
  } catch (err) {
    console.error("GET /schedules/:id/runs error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

schedulesRouter.post("/:projectId/schedules/:scheduleId/enable", (req, res) =>
  setEnabled(req, res, true)
);
schedulesRouter.post("/:projectId/schedules/:scheduleId/disable", (req, res) =>
  setEnabled(req, res, false)
);

schedulesRouter.delete("/:projectId/schedules/:scheduleId", async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const removed = await removeSchedule(project.path, req.params.scheduleId);
    if (!removed) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /schedules/:id error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

async function setEnabled(
  req: { params: { projectId: string; scheduleId: string } },
  res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void },
  enabled: boolean
): Promise<void> {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const schedule = await setScheduleEnabled(
      project.path,
      req.params.scheduleId,
      enabled
    );
    if (!schedule) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    res.json(schedule);
  } catch (err) {
    console.error("POST /schedules/:id/(enable|disable) error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
}
