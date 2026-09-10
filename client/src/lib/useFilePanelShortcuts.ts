import { useEffect, useRef } from "react";
import {
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";
import {
  matchesEvent,
  parseChord,
} from "./shortcut-match.ts";
import { isRecordingChord } from "./useShortcutBindings.tsx";

/*
 * Keyboard shortcuts for the right-side Files panel (issue #313).
 *
 *   - `filesPanelToggle` (default `cmd-b`) toggles the right panel
 *     open on the `files` tab / closed. Works regardless of which
 *     right-tab is currently active.
 *   - `filesPanelSearch` (default `cmd-p`) opens the fuzzy file
 *     finder overlay scoped to the active worktree.
 *
 * Both chords follow the same suppression rules as
 * `useFocusShortcuts` (issue #235):
 *   - Skipped while the Settings recorder is mid-capture so the
 *     recorded key isn't double-handled.
 *   - Skipped on auto-repeat.
 *   - Skipped when the event target is inside a dialog
 *     (`<dialog>` / `role="dialog"`) — the rename dialog and our
 *     own file finder use this so `Esc` can dismiss and a `Cmd+B`
 *     bound for the file explorer doesn't close the dialog
 *     underneath.
 *   - Skipped when the event target is inside the embedded
 *     terminal (xterm injects its own keydown handlers there).
 *   - Suppressed inside editable elements (`<input>`, `<textarea>`,
 *     `contenteditable`) so typing in the composer doesn't fight
 *     the shortcut. The composer needs `Cmd+B` / `Cmd+P` for text
 *     formatting and clipboard respectively, and the chat
 *     composer's own handlers win the race anyway. Note this is the
 *     one place the rules diverge from `useFocusShortcuts`:
 *     focus-queue chords fire even inside the composer because
 *     they're the only way to escape a stuck focus loop; the
 *     files-panel chords are convenience bindings and shouldn't
 *     clobber text editing.
 *
 * The hook returns nothing; the host wires the `onToggle` / `onSearch`
 * callbacks to its own state setters (`setRightTab`, `setTerminalOpen`,
 * `setMobilePanel`, …) so this hook stays decoupled from the rest
 * of `SessionView`.
 */
export interface UseFilePanelShortcutsOptions {
  bindings: ShortcutBindings | null;
  onToggle: () => void;
  onSearch: () => void;
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
  if (target.closest(".xterm")) return true;
  return false;
}

function getParsedChord(
  bindings: ShortcutBindings | null,
  action: keyof ShortcutBindings,
) {
  if (!bindings) return null;
  return parseChord(bindings[action]);
}

export function useFilePanelShortcuts({
  bindings,
  onToggle,
  onSearch,
}: UseFilePanelShortcutsOptions): void {
  const onToggleRef = useRef(onToggle);
  const onSearchRef = useRef(onSearch);
  const bindingsRef = useRef(bindings);

  useEffect(() => {
    onToggleRef.current = onToggle;
    onSearchRef.current = onSearch;
    bindingsRef.current = bindings;
  }, [onToggle, onSearch, bindings]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isRecordingChord()) return;
      if (event.repeat) return;
      if (isInsideDialog(event.target)) return;
      if (isInsideTerminal(event.target)) return;
      if (isEditableTarget(event.target)) return;

      const currentBindings = bindingsRef.current;
      if (!currentBindings) return;

      const toggleChord = getParsedChord(currentBindings, "filesPanelToggle");
      if (toggleChord && matchesEvent(toggleChord, event)) {
        event.preventDefault();
        onToggleRef.current();
        return;
      }

      const searchChord = getParsedChord(currentBindings, "filesPanelSearch");
      if (searchChord && matchesEvent(searchChord, event)) {
        event.preventDefault();
        onSearchRef.current();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
