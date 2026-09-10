import fs from "node:fs/promises";
import { shortcutBindingsFile, ensureOrchestratorHome } from "./paths.js";
// IMPORTANT: keep the types and constants below in sync with
// `shared/shortcuts.ts`. They are duplicated (rather than imported)
// because the server's `tsc` build has `rootDir: "."` so it cannot
// resolve across the `server/` boundary at emit time. The Electron
// launcher imports `dist/server/index.js` (issue #235) and we don't
// want the build layout to drift.

type ShortcutActionId =
  | "focusAdvanceNext"
  | "focusStay"
  | "focusDone"
  | "focusAutoAdvance"
  | "filesPanelToggle"
  | "filesPanelSearch";

type ShortcutBindings = Record<ShortcutActionId, string>;

const ACTION_IDS: ReadonlySet<ShortcutActionId> = new Set([
  "focusAdvanceNext",
  "focusStay",
  "focusDone",
  "focusAutoAdvance",
  "filesPanelToggle",
  "filesPanelSearch",
]);

const DEFAULT_BINDINGS: Readonly<Record<ShortcutActionId, string>> = {
  focusAdvanceNext: "ctrl-n",
  focusStay: "ctrl-s",
  focusDone: "ctrl-d",
  focusAutoAdvance: "ctrl-t",
  filesPanelToggle: "cmd-b",
  filesPanelSearch: "cmd-p",
};

/**
 * Persisted user overrides for focus-queue keyboard shortcuts.
 *
 * The file lives in the Controller home directory (see `paths.ts` and
 * issue #235) so overrides survive across browsers on the same machine
 * but don't need to be synced to a server.
 *
 * We only persist *overrides* — if an action is missing from the file
 * we fall back to `DEFAULT_BINDINGS`. That keeps the on-disk
 * shape minimal and means future default changes are picked up
 * automatically for users who haven't rebinding anything yet.
 */

type StoredOverrides = Partial<Record<ShortcutActionId, string>>;

/**
 * One-shot migration: action ids renamed when Controller Mode was
 * dropped in favour of the always-on focus-queue triage loop (issue
 * #333 follow-up). The user-facing chord the user picked is
 * preserved — we only translate the key. `controllerModeToggle` is
 * not mapped because the action was removed entirely; any saved
 * override for it is silently dropped.
 */
const LEGACY_ACTION_ALIASES: Record<string, ShortcutActionId> = {
  controllerModeNext: "focusAdvanceNext",
  controllerModeStay: "focusStay",
  controllerModeDone: "focusDone",
};

async function readStore(): Promise<StoredOverrides> {
  try {
    const content = await fs.readFile(shortcutBindingsFile(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    const [store, migrated] = normalizeStore(parsed);
    if (migrated) {
      // Self-heal: rewrite the file in the new shape so a future
      // upgrade doesn't have to re-apply the migration. Best-effort —
      // if the disk write fails (e.g. read-only home), the in-memory
      // translation still holds for the rest of this process.
      try {
        await writeStore(store);
      } catch {
        // Ignore — the translated overrides are still in effect for
        // this request. The file will be retried on the next read.
      }
    }
    return store;
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

/**
 * Returns the cleaned overrides map and a flag indicating whether any
 * legacy `controllerMode*` keys were translated. When the flag is set
 * the caller should write the cleaned map back to disk so the file
 * doesn't carry orphaned ids forever.
 *
 * Translation rules:
 *   - Known current ids pass through unchanged.
 *   - Legacy ids are mapped to their new equivalents **only when** the
 *     user hasn't already set the new id — otherwise the existing
 *     new-id value wins (no clobbering).
 *   - Anything else is dropped.
 */
function normalizeStore(
  parsed: unknown,
): [StoredOverrides, boolean] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{}, false];
  }
  const store: StoredOverrides = {};
  let migrated = false;
  for (const [rawId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeChord(value);
    if (!normalized) continue;
    if (ACTION_IDS.has(rawId as ShortcutActionId)) {
      store[rawId as ShortcutActionId] = normalized;
      continue;
    }
    const aliased = LEGACY_ACTION_ALIASES[rawId];
    if (aliased) {
      // Don't clobber an existing new-id override with an older one
      // — the user's most recent choice wins.
      if (store[aliased] === undefined) {
        store[aliased] = normalized;
      }
    }
    // Any unknown / legacy id (mapped or removed) is a signal that
    // the file is stale. Mark for rewrite so future reads start from
    // the cleaned shape. The cleaned shape won't include this id.
    migrated = true;
  }
  return [store, migrated];
}

async function writeStore(store: StoredOverrides): Promise<void> {
  await ensureOrchestratorHome();
  await fs.writeFile(shortcutBindingsFile(), JSON.stringify(store, null, 2));
}

/** Bundled defaults — re-exported for tests so they don't depend on shared/. */
export const DEFAULT_SHORTCUT_BINDINGS = DEFAULT_BINDINGS;

// Re-exported so tests can write directly to the on-disk file when
// simulating a legacy or corrupted overrides shape (e.g. the
// Controller-Mode → focus-queue migration in #333 follow-up).
export { shortcutBindingsFile };

export type { ShortcutActionId, ShortcutBindings };

/**
 * Returns the effective bindings for every action: persisted overrides
 * merged on top of the bundled defaults. Stable order matching
 * `DEFAULT_BINDINGS`.
 */
export async function getShortcutBindings(): Promise<ShortcutBindings> {
  const overrides = await readStore();
  return { ...DEFAULT_BINDINGS, ...overrides };
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
  return { ...DEFAULT_BINDINGS, ...clean };
}

/** Remove all overrides, restoring bundled defaults on next read. */
export async function clearShortcutBindings(): Promise<ShortcutBindings> {
  await writeStore({});
  return { ...DEFAULT_BINDINGS };
}