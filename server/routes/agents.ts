import { Router } from "express";
import { getAgentProvider, getAgentStatuses } from "../lib/agents.js";
import { setAgentSetting } from "../lib/agent-settings.js";

export const agentsRouter = Router();

/** Install + enable status for every agent (Ada, Codex, Claude Code). */
agentsRouter.get("/", async (_req, res) => {
  res.json(await getAgentStatuses());
});

/** Update an agent's enabled flag and/or explicit CLI path. */
agentsRouter.put("/:agentId", async (req, res) => {
  const { agentId } = req.params;
  if (!getAgentProvider(agentId)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }

  const { enabled, path } = req.body as {
    enabled?: unknown;
    path?: unknown;
  };

  if (enabled !== undefined && typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  if (path !== undefined && path !== null && typeof path !== "string") {
    res.status(400).json({ error: "path must be a string or null" });
    return;
  }

  await setAgentSetting(agentId, {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(path !== undefined ? { path: path as string | null } : {}),
  });

  const statuses = await getAgentStatuses();
  const status = statuses.find((entry) => entry.id === agentId);
  res.json(status);
});
