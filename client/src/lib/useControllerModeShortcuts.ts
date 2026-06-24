import { useEffect, useRef } from "react";

/**
 * Global keyboard shortcuts that drive the controller-mode loop from the keyboard.
 *
 * - `N` advances to the next pinned session (only while controller mode is active).
 *   If a controller-mode advance countdown is pending, `N` commits it immediately to
 *   continue to the next session. The commit path fires even while the
 *   composer is focused (see issue #104).
 * - `S` cancels a pending controller-mode advance countdown and stays on the current
 *   session (only while controller mode is active).
 * - `D` marks the current session done (only while controller mode is active).
 * - `F` enters controller mode (no-op if already active).
 * - `E` exits controller mode (no-op if not active).
 * - `Esc` blurs the currently-focused input/textarea/contenteditable so the
 *   shortcuts above can fire afterwards. It is intentionally a no-op when the
 *   focus is inside a dialog or the embedded terminal. If a controller-mode
 *   advance countdown is pending and focus is *not* in an editable element, Esc
 *   cancels the countdown (matches the **Stay** button).
 *
 * Shortcuts are suppressed when the user is typing (input, textarea, select,
 * contenteditable), when a dialog is open (role="dialog" or <dialog>), when
 * the embedded terminal has focus, or when a modifier key is held. Keys with
 * auto-repeat are also ignored.
 */
export interface UseControllerModeShortcutsOptions {
  controllerMode: boolean;
  onSkip: () => void;
  onDone: () => void;
  onEnter: () => void;
  onExit: () => void;
  /**
   * Optional. Called when the user presses Esc (and focus is not in
   * an editable element) while a controller-mode advance countdown is
   * pending. Issue #104.
   */
  onCancelAdvance?: () => void;
  /**
   * Optional. Called when the user presses `N` while a controller-mode
   * advance countdown is pending, committing it immediately to continue
   * to the next session. Set only when a countdown is pending so the
   * early `N` path (which fires even while the composer is focused) is a
   * no-op otherwise.
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

export function useControllerModeShortcuts({
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

  useEffect(() => {
    controllerModeRef.current = controllerMode;
    onSkipRef.current = onSkip;
    onDoneRef.current = onDone;
    onEnterRef.current = onEnter;
    onExitRef.current = onExit;
    onCancelAdvanceRef.current = onCancelAdvance;
    onCommitAdvanceRef.current = onCommitAdvance;
  }, [controllerMode, onSkip, onDone, onEnter, onExit, onCancelAdvance, onCommitAdvance]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInsideDialog(event.target)) return;
      if (isInsideTerminal(event.target)) return;

      // Esc handling has two paths:
      //   1. Focus is in an editable element: blur it so the user can
      //      drive the controller-mode loop from the keyboard after
      //      typing.
      //   2. Focus is elsewhere: if a controller-mode advance countdown
      //      is pending, cancel it (matches the **Stay** button in the
      //      advance toast). If no countdown is pending, the Esc key
      //      is a no-op here.
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

      const key = event.key.toLowerCase();
      const inControllerMode = controllerModeRef.current;

      // Let the toast's "Press S to stay" shortcut work even while the
      // composer is focused. Because this path runs before editable-target
      // suppression, preventDefault keeps the literal "s" out of the textarea.
      if (inControllerMode && key === "s" && onCancelAdvanceRef.current) {
        event.preventDefault();
        onCancelAdvanceRef.current();
        return;
      }

      // Mirror the "stay" path for "next": when a countdown is pending, `N`
      // commits it immediately to continue to the next session. Runs before
      // editable-target suppression so it works while the composer is focused
      // (the advance is usually scheduled right after sending a message), and
      // preventDefault keeps the literal "n" out of the textarea. When no
      // countdown is pending, onCommitAdvance is undefined and the regular `N`
      // handler below takes over.
      if (inControllerMode && key === "n" && onCommitAdvanceRef.current) {
        event.preventDefault();
        onCommitAdvanceRef.current();
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (key === "f") {
        if (inControllerMode) return;
        event.preventDefault();
        onEnterRef.current();
        return;
      }
      if (key === "e") {
        if (!inControllerMode) return;
        event.preventDefault();
        onExitRef.current();
        return;
      }
      if (!inControllerMode) return;
      if (key === "n") {
        event.preventDefault();
        onSkipRef.current();
        return;
      }
      if (key === "d") {
        event.preventDefault();
        onDoneRef.current();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
