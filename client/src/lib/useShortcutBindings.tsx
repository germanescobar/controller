import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
 * Single source of truth for Controller Mode shortcut bindings.
 *
 * The provider lives near the root of the app (in `App.tsx`); every
 * consumer — the global keyboard listener, the `<Kbd>` chips in the
 * Controller Mode bar, the sidebar tooltip, and the Settings panel —
 * reads from the same shared state via `useShortcutBindingsContext()`.
 * That way a rebind in Settings is visible everywhere immediately
 * (issue #235 P2 review: previously Settings had its own `useState`,
 * so saved changes only took effect after a full reload).
 *
 * Until the first fetch resolves, `bindings` is `null`; consumers
 * fall back to the bundled defaults.
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

const ShortcutBindingsContext = createContext<UseShortcutBindingsApi | null>(null);

export function ShortcutBindingsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState<ShortcutBindings | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchShortcutBindings();
    setBindings(next);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      // On fetch failure we still surface defaults so the rest of the
      // app can render chips/tooltips instead of `null`.
      setBindings({ ...DEFAULT_SHORTCUT_BINDINGS });
    });
  }, [refresh]);

  const save = useCallback(async (overrides: Partial<ShortcutBindings>) => {
    const next = await saveShortcutBindings(overrides);
    setBindings(next);
    return next;
  }, []);

  const reset = useCallback(async () => {
    const next = await resetShortcutBindings();
    setBindings(next);
    return next;
  }, []);

  const value = useMemo<UseShortcutBindingsApi>(
    () => ({ bindings, refresh, save, reset }),
    [bindings, refresh, save, reset],
  );

  return (
    <ShortcutBindingsContext.Provider value={value}>
      {children}
    </ShortcutBindingsContext.Provider>
  );
}

/**
 * Read the shared bindings state. Throws if used outside the provider
 * — that's a programmer error, not a runtime condition we want to
 * paper over with a fallback.
 */
export function useShortcutBindingsContext(): UseShortcutBindingsApi {
  const ctx = useContext(ShortcutBindingsContext);
  if (!ctx) {
    throw new Error(
      "useShortcutBindingsContext must be used inside <ShortcutBindingsProvider>",
    );
  }
  return ctx;
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

/**
 * Module-level flag the App-level keyboard listener checks before
 * handling a chord. The Settings recorder sets this while the user is
 * mid-recording so a Ctrl+T / Ctrl+N / Ctrl+D / Ctrl+S press
 * captured by the recorder doesn't also fire the global handler and
 * toggle controller mode / navigate / mark done (issue #235 P2
 * review).
 *
 * Using a module variable rather than context because the recorder
 * and the listener live in completely separate component trees and
 * need a synchronous, side-effect-free read on every keydown.
 */
let recordingChord = false;

export function setRecordingChord(active: boolean): void {
  recordingChord = active;
}

export function isRecordingChord(): boolean {
  return recordingChord;
}