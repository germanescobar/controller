import { useEffect, useRef } from "react";

/**
 * Global keyboard shortcuts that drive the focus-mode loop from the keyboard.
 *
 * - `N` advances to the next pinned session (only while focus mode is active).
 *   If a focus-advance countdown is pending, `N` commits it immediately
 *   (see issue #104).
 * - `S` cancels a pending focus-advance countdown and stays on the current
 *   session (only while focus mode is active).
 * - `D` marks the current session done (only while focus mode is active).
 * - `F` enters focus mode (no-op if already active).
 * - `E` exits focus mode (no-op if not active).
 * - `Esc` blurs the currently-focused input/textarea/contenteditable so the
 *   shortcuts above can fire afterwards. It is intentionally a no-op when the
 *   focus is inside a dialog or the embedded terminal. If a focus-advance
 *   countdown is pending and focus is *not* in an editable element, Esc
 *   cancels the countdown (matches the **Stay** button).
 *
 * Shortcuts are suppressed when the user is typing (input, textarea, select,
 * contenteditable), when a dialog is open (role="dialog" or <dialog>), when
 * the embedded terminal has focus, or when a modifier key is held. Keys with
 * auto-repeat are also ignored.
 */
export interface UseFocusModeShortcutsOptions {
  focusMode: boolean;
  onSkip: () => void;
  onDone: () => void;
  onEnter: () => void;
  onExit: () => void;
  /**
   * Optional. Called when the user presses Esc (and focus is not in
   * an editable element) while a focus-advance countdown is
   * pending. Issue #104.
   */
  onCancelAdvance?: () => void;
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

export function useFocusModeShortcuts({
  focusMode,
  onSkip,
  onDone,
  onEnter,
  onExit,
  onCancelAdvance,
}: UseFocusModeShortcutsOptions): void {
  // Keep handler refs in sync so the keydown listener doesn't have to
  // re-attach on every render of the host component.
  const focusModeRef = useRef(focusMode);
  const onSkipRef = useRef(onSkip);
  const onDoneRef = useRef(onDone);
  const onEnterRef = useRef(onEnter);
  const onExitRef = useRef(onExit);
  const onCancelAdvanceRef = useRef(onCancelAdvance);

  useEffect(() => {
    focusModeRef.current = focusMode;
    onSkipRef.current = onSkip;
    onDoneRef.current = onDone;
    onEnterRef.current = onEnter;
    onExitRef.current = onExit;
    onCancelAdvanceRef.current = onCancelAdvance;
  }, [focusMode, onSkip, onDone, onEnter, onExit, onCancelAdvance]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInsideDialog(event.target)) return;
      if (isInsideTerminal(event.target)) return;

      // Esc handling has two paths:
      //   1. Focus is in an editable element: blur it so the user can
      //      drive the focus-mode loop from the keyboard after typing.
      //   2. Focus is elsewhere: if a focus-advance countdown is
      //      pending, cancel it (matches the **Stay** button in the
      //      focus-advance toast). If no countdown is pending, the Esc key
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
      const inFocusMode = focusModeRef.current;

      // Let the toast's "Press S to stay" shortcut work even while the
      // composer is focused. Because this path runs before editable-target
      // suppression, preventDefault keeps the literal "s" out of the textarea.
      if (inFocusMode && key === "s" && onCancelAdvanceRef.current) {
        event.preventDefault();
        onCancelAdvanceRef.current();
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (key === "f") {
        if (inFocusMode) return;
        event.preventDefault();
        onEnterRef.current();
        return;
      }
      if (key === "e") {
        if (!inFocusMode) return;
        event.preventDefault();
        onExitRef.current();
        return;
      }
      if (!inFocusMode) return;
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
