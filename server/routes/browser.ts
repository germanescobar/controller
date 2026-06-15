/*
 * HTTP surface for the `controller-browser` CLI (issue #109).
 *
 * The CLI POSTs a browser command here; the route resolves the target pane,
 * enforces the navigation policy for `open`, and forwards the command to the
 * renderer that owns the visible `<webview>` via the preview browser bridge.
 */

import { Router, type Request, type Response } from "express";
import { findWorktreeByPath } from "../lib/worktrees.js";
import { validateBrowserUrl } from "../lib/browser-policy.js";
import { previewBrowserBridge } from "../lib/preview-browser.js";

export const browserRouter = Router();

const KNOWN_ACTIONS = new Set(["open", "snapshot", "click", "type"]);

browserRouter.post("/command", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The CLI runs in the agent's shell, whose cwd is the worktree. We map that
  // path back to the project/worktree so a single constant server URL is the
  // only thing the agent needs in its environment.
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const action = typeof body.action === "string" ? body.action : "";
  const params =
    body.params && typeof body.params === "object"
      ? ({ ...(body.params as Record<string, unknown>) })
      : {};

  if (!cwd) {
    res.status(400).json({ ok: false, error: "Missing cwd" });
    return;
  }
  if (!KNOWN_ACTIONS.has(action)) {
    res.status(400).json({ ok: false, error: `Unknown browser action: ${action}` });
    return;
  }

  const worktree = await findWorktreeByPath(cwd);
  if (!worktree) {
    res.status(404).json({
      ok: false,
      error: "Could not match the current directory to a known project worktree",
    });
    return;
  }

  // Validate + canonicalize navigation targets before handing them to the
  // renderer. The Electron main process re-checks on actual navigation.
  if (action === "open") {
    const url = typeof params.url === "string" ? params.url : "";
    const check = validateBrowserUrl(url, worktree.path);
    if (!check.allowed || !check.url) {
      res.status(400).json({ ok: false, error: check.error ?? "URL not allowed" });
      return;
    }
    params.url = check.url;
  }

  const key = `${worktree.projectId}:${worktree.id}`;
  try {
    const result = await previewBrowserBridge.execute(key, action, params);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(409).json({ ok: false, error: message });
  }
});
