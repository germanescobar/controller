import { useCallback, useEffect, useState } from "react";
import {
  fetchShortcutBindings,
  resetShortcutBindings,
  saveShortcutBindings,
} from "../api.ts";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";

/**
 * Loads the effective shortcut bindings once, exposes them, and gives the
 * Settings UI a way to update them. Other components should subscribe via
 * the same hook (or read from the shared `bindings` state) so the keyboard
 * listener, `<Kbd>` chips, and tooltips all see the latest chord after a
 * rebind.
 *
 * Returns the merged bindings (defaults + persisted overrides) — never the
 * raw override map — so callers don't have to remember to fall back when
 * the user hasn't customised an action yet.
 *
 * Issue #235.
 */
export interface UseShortcutBindingsApi {
  /** Merged bindings (defaults + overrides). `null` until the first fetch resolves. */
  bindings: ShortcutBindings | null;
  /** Reload from the server. */
  refresh: () => Promise<void>;
  /** Persist a partial override map; the server returns the new effective bindings. */
  save: (overrides: Partial<ShortcutBindings>) => Promise<ShortcutBindings>;
  /** Wipe persisted overrides and return to defaults. */
  reset: () => Promise<ShortcutBindings>;
}

export function useShortcutBindings(): UseShortcutBindingsApi {
  const [bindings, setBindings] = useState<ShortcutBindings | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchShortcutBindings();
    setBindings(next);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      // On fetch failure we still surface defaults so the rest of the app
      // can render chips/tooltips instead of `null`.
      setBindings({ ...DEFAULT_SHORTCUT_BINDINGS });
    });
  }, [refresh]);

  const save = useCallback(
    async (overrides: Partial<ShortcutBindings>) => {
      const next = await saveShortcutBindings(overrides);
      setBindings(next);
      return next;
    },
    [],
  );

  const reset = useCallback(async () => {
    const next = await resetShortcutBindings();
    setBindings(next);
    return next;
  }, []);

  return { bindings, refresh, save, reset };
}

/**
 * Convenience accessor that returns the chord for a single action, falling
 * back to the bundled default while the bindings are still loading.
 */
export function bindingFor(
  bindings: ShortcutBindings | null,
  action: ShortcutActionId,
): string {
  return bindings?.[action] ?? DEFAULT_SHORTCUT_BINDINGS[action];
}