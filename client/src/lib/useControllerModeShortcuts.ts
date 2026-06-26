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
 * Default actions:
 *   - `Cmd/Ctrl+T`  → toggle controller mode (enter if off, exit if on).
 *   - `Cmd/Ctrl+N`  → next pinned session. If a controller-mode advance
 *                    countdown is pending, this commits it immediately to
 *                    continue to the next session. The commit path fires
 *                    even while the composer is focused.
 *   - `Cmd/Ctrl+D`  → mark current session done (only while controller mode
 *                    is active).
 *   - `Cmd/Ctrl+S`  → cancel a pending controller-mode advance countdown
 *                    and stay on the current session. Fires even while the
 *                    composer is focused so the user can dismiss the toast
 *                    without blurring first.
 *   - `Esc`         → blurs the currently-focused input/textarea/
 *                    contenteditable. If no countdown is pending, it's a
 *                    no-op. Intentionally a no-op inside dialogs and the
 *                    embedded terminal.
 *
 * Shortcuts are suppressed inside dialogs (role="dialog" / <dialog>), the
 * embedded terminal, or when an auto-repeat fires. `Esc` is always
 * permitted (the same dialog/terminal suppressions apply).
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

      // The "stay" chord (default Cmd/Ctrl+S) fires even while the
      // composer is focused. Because this path runs before editable-target
      // suppression, preventDefault keeps the literal "s" out of the
      // textarea.
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

      // Mirror the "stay" path for "next": when a countdown is pending, the
      // next chord commits it immediately. Runs before editable-target
      // suppression so it works while the composer is focused. When no
      // countdown is pending, onCommitAdvance is undefined and the regular
      // next handler below takes over.
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

      if (isEditableTarget(event.target)) return;

      // Toggle chord (default Cmd/Ctrl+T) is the unified enter/exit
      // binding. No priority over the editable target check — toggling
      // while typing would be surprising, so require the cursor to be
      // outside the composer first.
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

      if (!inControllerMode) return;

      if (nextChord && matchesEvent(nextChord, event)) {
        event.preventDefault();
        onSkipRef.current();
        return;
      }
      const doneChord = getParsedChord(currentBindings, "controllerModeDone");
      if (doneChord && matchesEvent(doneChord, event)) {
        event.preventDefault();
        onDoneRef.current();
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
  const fallback = {
    controllerModeToggle: "cmd-t",
    controllerModeNext: "cmd-n",
    controllerModeDone: "cmd-d",
    controllerModeStay: "cmd-s",
  }[action];
  return formatChord(bindings?.[action] ?? fallback, isMacPlatform());
}