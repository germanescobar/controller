import { Router, type Request, type Response } from "express";
import {
  createUnifiedSkill,
  deleteUnifiedSkill,
  listUnifiedSkills,
  readUnifiedSkill,
  updateUnifiedSkill,
  type UnifiedSkillInput,
} from "../lib/unified-skills.js";
import {
  discoverImportableSkills,
  importSkills,
  type SkillImportRequest,
} from "../lib/skill-import.js";

export const unifiedSkillsRouter = Router();

unifiedSkillsRouter.get("/unified-skills", async (_req: Request, res: Response) => {
  const skills = await listUnifiedSkills();
  res.json({ skills });
});

unifiedSkillsRouter.get("/unified-skills/:name", async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const body = await readUnifiedSkill(name);
  if (!body) {
    res.status(404).json({ error: `Unified skill "${name}" not found.` });
    return;
  }
  res.json(body);
});

unifiedSkillsRouter.post("/unified-skills", async (req: Request, res: Response) => {
  const input = req.body as UnifiedSkillInput;
  const result = await createUnifiedSkill(input);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result);
});

unifiedSkillsRouter.put("/unified-skills/:name", async (req: Request, res: Response) => {
  const originalName = String(req.params.name);
  const input = req.body as UnifiedSkillInput;
  const result = await updateUnifiedSkill(originalName, input);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

unifiedSkillsRouter.delete("/unified-skills/:name", async (req: Request, res: Response) => {
  const name = String(req.params.name);
  await deleteUnifiedSkill(name);
  res.status(204).send();
});

/**
 * Discover per-agent skills that are eligible for import into the unified
 * catalog (issue #145). Scans user/system skill homes for every provider and
 * the repo skill directories of every registered project.
 */
unifiedSkillsRouter.get(
  "/unified-skills/import/discover",
  async (_req: Request, res: Response) => {
    const skills = await discoverImportableSkills();
    res.json({ skills });
  }
);

/**
 * Import the selected per-agent skills into the unified catalog. Each
 * selection either imports a new unified skill, is skipped because a
 * unified skill with the same name already exists, or errored. Pass
 * `overwrite: true` per-selection to replace an existing unified skill.
 */
unifiedSkillsRouter.post(
  "/unified-skills/import",
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<SkillImportRequest>;
    if (!Array.isArray(body.selections)) {
      res
        .status(400)
        .json({ error: "Request body must include a `selections` array." });
      return;
    }
    const result = await importSkills({ selections: body.selections });
    res.json(result);
  }
);

unifiedSkillsRouter.post("/skills/list", async (_req: Request, res: Response) => {
  const skills = await listUnifiedSkills();
  res.json({ skills });
});

unifiedSkillsRouter.post("/skills/search", async (req: Request, res: Response) => {
  const query = String(req.body.query ?? "").trim().toLowerCase();
  if (!query) {
    res.status(400).json({ error: "Query is required." });
    return;
  }
  const skills = await listUnifiedSkills();
  const matches = skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query)
  );
  res.json({ skills: matches });
});

unifiedSkillsRouter.post("/skills/describe", async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Skill name is required." });
    return;
  }
  const body = await readUnifiedSkill(name);
  if (!body) {
    res.status(404).json({ error: `Unified skill "${name}" not found.` });
    return;
  }
  res.json({ name: body.metadata.name, description: body.metadata.description, body: body.body });
});

unifiedSkillsRouter.post("/skills/activate", async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Skill name is required." });
    return;
  }
  const body = await readUnifiedSkill(name);
  if (!body) {
    res.status(404).json({ error: `Unified skill "${name}" not found.` });
    return;
  }
  res.json({
    ok: true,
    name: body.metadata.name,
    message: `Activated "${body.metadata.name}" for the next turn.`,
  });
});

/**
 * CLI/gateway counterpart of `GET /unified-skills/import/discover`. Mirrors
 * the same response shape so the `controller skills import-discover` command
 * can use the shared `/api/skills/*` gateway.
 */
unifiedSkillsRouter.post("/skills/import-discover", async (_req: Request, res: Response) => {
  const skills = await discoverImportableSkills();
  res.json({ skills });
});

/**
 * CLI/gateway counterpart of `POST /unified-skills/import`.
 */
unifiedSkillsRouter.post("/skills/import", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<SkillImportRequest>;
  if (!Array.isArray(body.selections)) {
    res
      .status(400)
      .json({ error: "Request body must include a `selections` array." });
    return;
  }
  const result = await importSkills({ selections: body.selections });
  res.json(result);
});
