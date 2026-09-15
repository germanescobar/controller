/*
 * HTTP surface for the `controller-browser` CLI (issue #109).
 *
 * The CLI POSTs a browser command here; the route resolves the target pane,
 * enforces the navigation policy for `open`, and forwards the command to the
 * renderer that owns the visible `<webview>` via the preview browser bridge.
 *
 * Issue #170 added a `--a11y` flag for `snapshot` (returns an accessibility
 * tree with stable element refs the agent can target by id via `ref=<id>`).
 * The CLI forwards the flag as a boolean `a11y` param; everything else is
 * passed through unchanged.
 *
 * Issue #356 added `setFiles`: the agent can drive a `<input type="file">`
 * (single or multiple) and a drag-and-drop dropzone from the CLI without
 * the user touching the OS picker. The route runs the path policy before
 * forwarding — the Electron main process re-checks on actual read.
 */

import { Router, type Request, type Response } from "express";
import { findWorktreeByPath } from "../lib/worktrees.js";
import { validateBrowserUrl, validateBrowserFilePath } from "../lib/browser-policy.js";
import { previewBrowserBridge } from "../lib/preview-browser.js";

export const browserRouter = Router();

const KNOWN_ACTIONS = new Set(["open", "snapshot", "click", "type", "setFiles"]);

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
    const insecure = params.insecure === true;
    const check = validateBrowserUrl(url, worktree.path, { insecure });
    if (!check.allowed || !check.url) {
      res.status(400).json({ ok: false, error: check.error ?? "URL not allowed" });
      return;
    }
    params.url = check.url;
    // Keep the flag on the wire so the renderer can flip the cert-verify
    // bypass on the preview session before navigating.
    params.insecure = insecure;
  } else if (action === "setFiles") {
    // Resolve the selector and the list of paths up front so the renderer
    // (and the Electron main process on read) only see the canonical,
    // policy-approved shape. The renderer still owns the final file
    // assignment against the input element — this gate is just the
    // server-side pre-check the URL side already has.
    const selector = typeof params.selector === "string" ? params.selector : "";
    if (!selector) {
      res.status(400).json({ ok: false, error: "Missing selector" });
      return;
    }
    const rawPaths: unknown[] = Array.isArray(params.paths) ? params.paths : [];
    if (rawPaths.length === 0) {
      res.status(400).json({ ok: false, error: "setFiles requires at least one --path" });
      return;
    }
    const allowOutside = params.allowOutside === true;
    const canonical: string[] = [];
    for (const candidate of rawPaths) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        res.status(400).json({ ok: false, error: "Each --path must be a non-empty string" });
        return;
      }
      const check = validateBrowserFilePath(candidate, worktree.path, { allowOutside });
      if (!check.allowed || !check.path) {
        res.status(400).json({ ok: false, error: check.error ?? "Path not allowed" });
        return;
      }
      canonical.push(check.path);
    }
    params.selector = selector;
    params.paths = canonical;
    params.allowOutside = allowOutside;
  }

  const key = `${worktree.projectId}:${worktree.id}`;
  try {
    const result = await previewBrowserBridge.execute(key, action, params, {
      ensureHost: { projectRoot: worktree.path },
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(409).json({ ok: false, error: message });
  }
});
