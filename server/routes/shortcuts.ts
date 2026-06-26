import { Router } from "express";
import {
  clearShortcutBindings,
  getShortcutBindings,
  setShortcutBindings,
} from "../lib/shortcut-settings.js";
import type { ShortcutActionId } from "../../shared/shortcuts.js";

/**
 * Controller Mode keyboard shortcut bindings.
 *
 * GET  /api/shortcuts       → effective bindings (defaults merged with overrides)
 * PUT  /api/shortcuts       → replace override map
 * DELETE /api/shortcuts     → clear all overrides (restore defaults)
 *
 * See issue #235.
 */

export const shortcutsRouter = Router();

shortcutsRouter.get("/", async (_req, res) => {
  res.json(await getShortcutBindings());
});

shortcutsRouter.put("/", async (req, res) => {
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "Body must be an object of action overrides" });
    return;
  }
  const overrides: Partial<Record<ShortcutActionId, string>> = {};
  for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      overrides[id as ShortcutActionId] = value;
    }
  }
  res.json(await setShortcutBindings(overrides));
});

shortcutsRouter.delete("/", async (_req, res) => {
  res.json(await clearShortcutBindings());
});