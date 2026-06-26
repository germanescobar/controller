import fs from "node:fs/promises";
import { shortcutBindingsFile, ensureOrchestratorHome } from "./paths.js";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../shared/shortcuts.js";

/**
 * Persisted user overrides for Controller Mode keyboard shortcuts.
 *
 * The file lives in the Controller home directory (see `paths.ts` and
 * issue #235) so overrides survive across browsers on the same machine
 * but don't need to be synced to a server.
 *
 * We only persist *overrides* — if an action is missing from the file
 * we fall back to `DEFAULT_SHORTCUT_BINDINGS`. That keeps the on-disk
 * shape minimal and means future default changes are picked up
 * automatically for users who haven't rebinding anything yet.
 */

type StoredOverrides = Partial<Record<ShortcutActionId, string>>;

const ACTION_IDS = new Set(SHORTCUT_ACTIONS.map((a) => a.id));

async function readStore(): Promise<StoredOverrides> {
  try {
    const content = await fs.readFile(shortcutBindingsFile(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return normalizeStore(parsed);
  } catch {
    return {};
  }
}

function normalizeChord(value: string): string {
  // Lower-case, trim, and split on any non-alphanumeric run so "+" and
  // "-" are interchangeable. Join with "-" to match the canonical form
  // produced by the client's `serialiseEvent`.
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}

function normalizeStore(parsed: unknown): StoredOverrides {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: StoredOverrides = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id as ShortcutActionId)) continue;
    if (typeof value !== "string") continue;
    const normalized = normalizeChord(value);
    if (!normalized) continue;
    store[id as ShortcutActionId] = normalized;
  }
  return store;
}

async function writeStore(store: StoredOverrides): Promise<void> {
  await ensureOrchestratorHome();
  await fs.writeFile(shortcutBindingsFile(), JSON.stringify(store, null, 2));
}

/**
 * Returns the effective bindings for every action: persisted overrides
 * merged on top of the bundled defaults. Stable order matching
 * `DEFAULT_SHORTCUT_BINDINGS`.
 */
export async function getShortcutBindings(): Promise<ShortcutBindings> {
  const overrides = await readStore();
  return { ...DEFAULT_SHORTCUT_BINDINGS, ...overrides };
}

/**
 * Replace the persisted overrides wholesale. Unknown action ids are
 * ignored; empty / non-string values are dropped.
 */
export async function setShortcutBindings(
  overrides: Partial<Record<ShortcutActionId, string>>,
): Promise<ShortcutBindings> {
  const clean: StoredOverrides = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (!ACTION_IDS.has(id as ShortcutActionId)) continue;
    if (typeof value !== "string") continue;
    const normalized = normalizeChord(value);
    if (!normalized) continue;
    clean[id as ShortcutActionId] = normalized;
  }
  await writeStore(clean);
  return { ...DEFAULT_SHORTCUT_BINDINGS, ...clean };
}

/** Remove all overrides, restoring bundled defaults on next read. */
export async function clearShortcutBindings(): Promise<ShortcutBindings> {
  await writeStore({});
  return { ...DEFAULT_SHORTCUT_BINDINGS };
}