import { Router } from "express";
import { fetchAnitaModels, fetchCodexModels, getClaudeModels, type Model } from "../lib/models.js";

export const modelsRouter = Router();

export type { Model, ModelCapabilities } from "../lib/models.js";

modelsRouter.get("/", async (req, res) => {
  const agent = (req.query.agent as string) || "anita";

  if (agent === "codex") {
    res.json(await fetchCodexModels());
    return;
  }

  if (agent === "claude") {
    res.json(getClaudeModels());
    return;
  }

  res.json(await fetchAnitaModels());
});
