import { Router, type Request, type Response } from "express";
import { getAgentProvider, getAgentStatuses } from "../lib/agents.js";
import { setAgentSetting } from "../lib/agent-settings.js";
import { fetchAnitaModels, fetchCodexModels, getClaudeModels } from "../lib/models.js";
import { resolveWorktree } from "../lib/worktrees.js";
import { codexAppServerManager } from "../lib/codex-app-server.js";
import {
  listSessionRuntimes,
  stopSessionRuntime,
} from "../lib/session-runtime.js";
import {
  markClaudeSessionPermissionsRevoked,
} from "../lib/session-permissions.js";

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

/**
 * Reset the per-agent "always allow" decisions for the given worktree.
 * See issue #259.
 *
 * - Codex: tears down the live `codex app-server` child and clears all
 *   thread runtimes. The next turn spawns a fresh app-server.
 * - Claude: terminates every active Claude child for the worktree and
 *   marks the worktree so the next turn skips `--resume`, forcing a
 *   fresh session id (Claude's only mechanism for revoking session
 *   permissions without keeping the conversation history — there's no
 *   public "remove rules" message in the control protocol).
 * - Anita: no permission prompts to revoke; returns a 200 with zeroes.
 */
agentsRouter.post(
  "/:agentId/session-permissions/reset",
  async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const agent = getAgentProvider(agentId as string);
    if (!agent) {
      res.status(404).json({ error: "Unknown agent" });
      return;
    }
    const { projectId, worktreeId } = req.body as {
      projectId?: unknown;
      worktreeId?: unknown;
    };
    if (typeof projectId !== "string" || typeof worktreeId !== "string") {
      res.status(400).json({
        error: "projectId and worktreeId are required strings",
      });
      return;
    }
    const worktree = await resolveWorktree(
      projectId,
      worktreeId as string | undefined
    );
    if (!worktree) {
      res.status(404).json({ error: "Worktree not found" });
      return;
    }

    let droppedRuntimes = 0;
    let killedRuntimes = 0;

    if (agentId === "codex") {
      droppedRuntimes = codexAppServerManager.resetAllSessions();
    } else if (agentId === "claude") {
      const claudeRuntimes = listSessionRuntimes().filter(
        (entry) =>
          entry.active &&
          entry.provider === "claude" &&
          entry.worktreeId === worktree.id
      );
      for (const runtime of claudeRuntimes) {
        try {
          await stopSessionRuntime(runtime.sessionId);
          killedRuntimes += 1;
        } catch {
          /* best-effort: a runtime that already exited races the reset */
        }
      }
      // Mark the worktree so the next turn skips `--resume`. The
      // session-start route consumes this flag exactly once.
      markClaudeSessionPermissionsRevoked(worktree.id);
    } else {
      // Anita (and any other provider without permission prompts):
      // nothing to revoke, but acknowledge the call so the UI doesn't
      // surface a confusing error.
    }

    res.json({ ok: true, droppedRuntimes, killedRuntimes });
  }
);
