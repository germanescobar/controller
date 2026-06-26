import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";
import { formatChord, isMacPlatform } from "../lib/shortcut-match.ts";

/**
 * Toast that counts down a pending focus-queue advance (issue #104)
 * and surfaces the user's actual stay / continue chord chips so the
 * visible shortcut matches the binding the listener fires.
 *
 * Background: the original copy read "Press S to stay · N to
 * continue" and worked when Controller Mode used single-letter
 * shortcuts. Issue #235 moved every shortcut to a modifier-based
 * chord (default `Ctrl+S` / `Ctrl+N`) so it fires regardless of
 * focus — but the toast copy was never updated, leaving the chips
 * misleading. This component reads the live `bindings` map so the
 * chips always reflect what the listener actually accepts, including
 * any user rebind from Settings.
 *
 * Kept in its own file (rather than inside `App.tsx`) so the
 * regression test in `client/src/components/__tests__/focus-advance-toast.test.tsx`
 * can render it without pulling in the xterm CSS that `App.tsx`
 * transitively imports.
 */
export function FocusAdvanceToast({
  scheduledAt,
  durationMs,
  bindings,
  onCancel,
}: {
  scheduledAt: number;
  durationMs: number;
  /**
   * Live shortcut bindings. Used to render the actual stay / continue
   * chord chips so the toast matches the keys the user has bound in
   * Settings (default `Ctrl+S` / `Ctrl+N`). Falls back to the bundled
   * defaults while the bindings fetch is still in flight so the
   * chips are never the stale single-letter "S" / "N".
   */
  bindings: ShortcutBindings | null;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  const elapsedMs = Math.max(0, now - scheduledAt);
  const progress = Math.min(1, elapsedMs / durationMs);
  const remainingProgress = Math.max(0, 1 - progress);
  const secondsRemaining = Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));

  // Render the user's actual stay / continue chord. We fall back to
  // the bundled defaults if bindings haven't loaded yet so the chips
  // never read "Press S to stay" — that string is misleading because
  // the listener only fires on the modifier-based chord. `isMacPlatform`
  // matches the rest of the Controller Mode UI.
  const stayChord =
    bindings?.controllerModeStay ??
    DEFAULT_SHORTCUT_BINDINGS.controllerModeStay;
  const nextChord =
    bindings?.controllerModeNext ??
    DEFAULT_SHORTCUT_BINDINGS.controllerModeNext;
  const onMac = isMacPlatform();
  const stayLabel = formatChord(stayChord, onMac);
  const nextLabel = formatChord(nextChord, onMac);

  return (
    <div className="w-80 overflow-hidden rounded-lg border border-blue-400/20 bg-[#151922] text-slate-100 shadow-xl shadow-black/35">
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 rounded-md border border-blue-400/15 bg-blue-400/10 p-1 text-blue-300">
            <ArrowRight className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-50">
              Advancing to next conversation
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              <span className="hidden md:inline">
                Press <span className="font-medium text-slate-200">{stayLabel}</span> to stay ·{" "}
                <span className="font-medium text-slate-200">{nextLabel}</span> to continue ·{" "}
              </span>
              <span>{secondsRemaining}s</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end md:hidden">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100"
          >
            Stay
          </button>
        </div>
      </div>
      <div className="h-1 bg-slate-700/80">
        <div
          className="h-full bg-blue-400 transition-[width] duration-200 ease-linear"
          style={{ width: `${remainingProgress * 100}%` }}
        />
      </div>
    </div>
  );
}