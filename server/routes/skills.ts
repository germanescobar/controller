import { Router, type Request, type Response } from "express";
import { getSkillProvider } from "../lib/skills.js";

export const skillsRouter = Router({ mergeParams: true });

/**
 * Enumerate the skills available to the given agent provider for the given
 * working directory. The body of each skill is read on demand at send time
 * so the client never has to hold the full text of every SKILL.md.
 */
skillsRouter.get("/:providerId/skills", async (req: Request, res: Response) => {
  const providerId = String(req.params.providerId);
  const provider = getSkillProvider(providerId);
  if (!provider) {
    res.status(404).json({ error: `Unknown agent provider: ${providerId}` });
    return;
  }

  const cwdParam = req.query.cwd;
  const cwdRaw = Array.isArray(cwdParam) ? cwdParam[0] : cwdParam;
  const cwd = typeof cwdRaw === "string" && cwdRaw.trim() ? cwdRaw.trim() : process.cwd();

  const skills = await provider.listMetadata(cwd);
  res.json({ skills });
});
