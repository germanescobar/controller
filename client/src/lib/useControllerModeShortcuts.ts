import { useEffect, useRef } from "react";
import {
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";
import {
  formatChord,
  isMacPlatform,
  matchesEvent,
  parseChord,
} from "./shortcut-match.ts";

/**
 * Global keyboard shortcuts that drive the controller-mode loop from the
 * keyboard. Bindings are sourced from the shared `useShortcutBindings`
 * hook so the user can rebind them in Settings (issue #235).
 *
 * Default actions (strict per-platform: ⌃ on macOS, Ctrl elsewhere):
 *   - `Ctrl+T`       → toggle controller mode (enter if off, exit if on).
 *   - `Ctrl+N`       → next pinned session. If a controller-mode advance
 *                      countdown is pending, this commits it immediately to
 *                      continue to the next session. The commit path fires
 *                      even while the composer is focused.
 *   - `Ctrl+D`       → mark current session done. Fires regardless of
 *                      Controller Mode state; no-op when no session is
 *                      open.
 *   - `Ctrl+S`       → cancel a pending controller-mode advance countdown
 *                      and stay on the current session. Fires even while
 *                      the composer is focused so the user can dismiss
 *                      the toast without blurring first.
 *   - `Esc`          → blurs the currently-focused input/textarea/
 *                      contenteditable. If no countdown is pending, it's
 *                      a no-op. Intentionally a no-op inside dialogs and
 *                      the embedded terminal.
 *
 * Defaults use Ctrl (not Cmd) because Cmd collides with too many macOS
 * system shortcuts (Cmd+W, Cmd+Q, Cmd+R, …) and the matcher is strict
 * per-platform — a stored "ctrl-n" will not fire on Cmd+N on macOS and
 * vice-versa.
 *
 * Every chord fires regardless of which element has focus (textarea,
 * contenteditable, button, …). `preventDefault` blocks the literal key
 * from reaching the textarea so typing isn't corrupted. `Esc` is the
 * one exception: it still blurs an editable element so the user can
 * resume typing without their keys being intercepted.
 *
 * Shortcuts are suppressed inside dialogs (role="dialog" / <dialog>), the
 * embedded terminal, or when an auto-repeat fires.
 */
export interface UseControllerModeShortcutsOptions {
  bindings: ShortcutBindings | null;
  controllerMode: boolean;
  onSkip: () => void;
  onDone: () => void;
  onEnter: () => void;
  onExit: () => void;
  /**
   * Optional. Called when the user invokes the "stay" chord while a
   * controller-mode advance countdown is pending. Issue #104.
   */
  onCancelAdvance?: () => void;
  /**
   * Optional. Called when the user invokes the "next" chord while a
   * controller-mode advance countdown is pending, committing it
   * immediately to continue to the next session. Set only when a
   * countdown is pending so the early `N` path (which fires even while
   * the composer is focused) is a no-op otherwise.
   */
  onCommitAdvance?: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function isInsideDialog(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("dialog,[role='dialog']")) return true;
  return false;
}

function isInsideTerminal(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // xterm injects a .xterm-helper-textarea inside a .xterm container.
  if (target.closest(".xterm")) return true;
  return false;
}

/**
 * Returns the parsed chord for an action, or null if the bindings aren't
 * loaded yet or the stored string is unparseable. Cached per call so we
 * don't re-parse on every keydown.
 */
function getParsedChord(
  bindings: ShortcutBindings | null,
  action: keyof ShortcutBindings
) {
  if (!bindings) return null;
  return parseChord(bindings[action]);
}

export function useControllerModeShortcuts({
  bindings,
  controllerMode,
  onSkip,
  onDone,
  onEnter,
  onExit,
  onCancelAdvance,
  onCommitAdvance,
}: UseControllerModeShortcutsOptions): void {
  // Keep handler refs in sync so the keydown listener doesn't have to
  // re-attach on every render of the host component.
  const controllerModeRef = useRef(controllerMode);
  const onSkipRef = useRef(onSkip);
  const onDoneRef = useRef(onDone);
  const onEnterRef = useRef(onEnter);
  const onExitRef = useRef(onExit);
  const onCancelAdvanceRef = useRef(onCancelAdvance);
  const onCommitAdvanceRef = useRef(onCommitAdvance);
  const bindingsRef = useRef(bindings);

  useEffect(() => {
    controllerModeRef.current = controllerMode;
    onSkipRef.current = onSkip;
    onDoneRef.current = onDone;
    onEnterRef.current = onEnter;
    onExitRef.current = onExit;
    onCancelAdvanceRef.current = onCancelAdvance;
    onCommitAdvanceRef.current = onCommitAdvance;
    bindingsRef.current = bindings;
  }, [
    controllerMode,
    onSkip,
    onDone,
    onEnter,
    onExit,
    onCancelAdvance,
    onCommitAdvance,
    bindings,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (isInsideDialog(event.target)) return;
      if (isInsideTerminal(event.target)) return;

      // Esc handling has two paths:
      //   1. Focus is in an editable element: blur it so the user can
      //      drive the controller-mode loop from the keyboard after
      //      typing.
      //   2. Focus is elsewhere: if a controller-mode advance countdown
      //      is pending, cancel it (matches the **Stay** chord).
      // Suppressed inside dialogs (let them close) and the terminal
      // (let it forward the key to the running process).
      if (event.key === "Escape") {
        const target = event.target;
        if (isEditableTarget(target) && target instanceof HTMLElement) {
          target.blur();
          return;
        }
        if (onCancelAdvanceRef.current) {
          onCancelAdvanceRef.current();
        }
        return;
      }

      const currentBindings = bindingsRef.current;
      if (!currentBindings) return;
      const inControllerMode = controllerModeRef.current;

      // All Controller Mode chords (default Ctrl+T / Ctrl+N / Ctrl+D /
      // Ctrl+S) fire regardless of where focus is — that's the whole
      // reason the issue switched them to modifier-based (issue #235).
      // preventDefault keeps the literal character out of the textarea
      // when one is focused. Esc is intentionally not in this group
      // because the user still wants Esc to blur the input.

      // The "stay" chord (default Ctrl+S) only matters while an
      // advance is pending; no-op otherwise.
      const stayChord = getParsedChord(currentBindings, "controllerModeStay");
      if (
        stayChord &&
        onCancelAdvanceRef.current &&
        matchesEvent(stayChord, event)
      ) {
        event.preventDefault();
        onCancelAdvanceRef.current();
        return;
      }

      // "Next" while a countdown is pending commits the advance
      // immediately. When no countdown is pending the regular next
      // handler below takes over.
      const nextChord = getParsedChord(currentBindings, "controllerModeNext");
      if (
        nextChord &&
        onCommitAdvanceRef.current &&
        matchesEvent(nextChord, event)
      ) {
        event.preventDefault();
        onCommitAdvanceRef.current();
        return;
      }

      // Toggle chord (default Ctrl+T) is the unified enter/exit
      // binding. Runs before the controller-mode gate so the user can
      // leave controller mode even if they're typing in the composer.
      const toggleChord = getParsedChord(currentBindings, "controllerModeToggle");
      if (toggleChord && matchesEvent(toggleChord, event)) {
        event.preventDefault();
        if (inControllerMode) {
          onExitRef.current();
        } else {
          onEnterRef.current();
        }
        return;
      }

      // "Mark done" (default Ctrl+D) fires regardless of Controller
      // Mode — the user wants to be able to clear a pinned session
      // from the radar without first toggling Controller Mode on.
      // `handleFocusDone` no-ops when no session is active, so an
      // un-focused Ctrl+D is harmless.
      const doneChord = getParsedChord(currentBindings, "controllerModeDone");
      if (doneChord && matchesEvent(doneChord, event)) {
        event.preventDefault();
        onDoneRef.current();
        return;
      }

      if (!inControllerMode) return;

      if (nextChord && matchesEvent(nextChord, event)) {
        event.preventDefault();
        onSkipRef.current();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}

/**
 * Helper for callers that want a chip-ready label for an action, taking
 * the current bindings and platform into account. Centralised here so the
 * UI uses the same formatting as the live matcher.
 */
export function labelForAction(
  bindings: ShortcutBindings | null,
  action: keyof ShortcutBindings
): string {
  // Mirror DEFAULT_SHORTCUT_BINDINGS so callers get a label even
  // before the server fetch resolves. Keeping this in sync with the
  // shared defaults is enforced by the DEFAULT_SHORTCUT_BINDINGS test
  // in shortcut-match.test.ts.
  const fallback = {
    controllerModeToggle: "ctrl-t",
    controllerModeNext: "ctrl-n",
    controllerModeDone: "ctrl-d",
    controllerModeStay: "ctrl-s",
  }[action];
  return formatChord(bindings?.[action] ?? fallback, isMacPlatform());
}