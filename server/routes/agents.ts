import { Router } from "express";
import { getAgentProvider, getAgentStatuses } from "../lib/agents.js";
import { setAgentSetting } from "../lib/agent-settings.js";
import { fetchAnitaModels, fetchCodexModels, getClaudeModels } from "../lib/models.js";

export const agentsRouter = Router();

async function fetchModelsForAgent(agentId: string) {
  if (agentId === "codex") return fetchCodexModels();
  if (agentId === "claude") return getClaudeModels();
  return fetchAnitaModels();
}

/** Install + enable status for every agent (Anita, Codex, Claude Code). */
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

  const { enabled, path, defaultModel, autoApprove } = req.body as {
    enabled?: unknown;
    path?: unknown;
    defaultModel?: unknown;
    autoApprove?: unknown;
  };

  if (enabled !== undefined && typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  if (autoApprove !== undefined && typeof autoApprove !== "boolean") {
    res.status(400).json({ error: "autoApprove must be a boolean" });
    return;
  }
  if (path !== undefined && path !== null && typeof path !== "string") {
    res.status(400).json({ error: "path must be a string or null" });
    return;
  }
  if (
    defaultModel !== undefined &&
    defaultModel !== null &&
    typeof defaultModel !== "string"
  ) {
    res.status(400).json({ error: "defaultModel must be a string or null" });
    return;
  }

  if (defaultModel) {
    const models = await fetchModelsForAgent(agentId);
    if (!models.some((model) => model.id === defaultModel)) {
      res.status(400).json({
        error: `defaultModel "${defaultModel}" is not available for ${agentId}`,
      });
      return;
    }
  }

  await setAgentSetting(agentId, {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(path !== undefined ? { path: path as string | null } : {}),
    ...(defaultModel !== undefined
      ? { defaultModel: defaultModel as string | null }
      : {}),
    ...(autoApprove !== undefined ? { autoApprove: autoApprove as boolean } : {}),
  });

  const statuses = await getAgentStatuses();
  const status = statuses.find((entry) => entry.id === agentId);
  res.json(status);
});
