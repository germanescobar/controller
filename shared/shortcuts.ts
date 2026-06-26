/*
 * Canonical shortcut action list shared by the server (which persists
 * overrides) and the client (which reads them and renders the keyboard
 * chips). Defining the list in one place keeps the two sides from drifting.
 *
 * A "chord" is a serialised `KeyboardEvent` description. We store it as a
 * plain string of the form `<modifiers>-<key>` (lower-case, hyphen-joined
 * modifier tokens) so the file stays JSON-friendly and human-readable:
 *
 *   "cmd-shift-n"     // ⌘⇧N on macOS
 *   "ctrl-d"          // Ctrl+D everywhere
 *   "escape"
 *
 * The platform-appropriate modifier (Cmd on macOS, Ctrl elsewhere) is
 * resolved by the matcher at runtime against `event.metaKey` /
 * `event.ctrlKey`, so the user only has to think about the *label* —
 * they bind "Cmd+N" on macOS and "Ctrl+N" on Linux/Windows and the
 * matcher accepts either shape for the same logical action.
 *
 * Issue #235.
 */

export type ShortcutActionId =
  | "controllerModeToggle"
  | "controllerModeNext"
  | "controllerModeDone"
  | "controllerModeStay";

export interface ShortcutActionSpec {
  id: ShortcutActionId;
  /** Short verb shown in the settings list. */
  label: string;
  /** One-line description of what the action does. */
  description: string;
}

export const SHORTCUT_ACTIONS: ShortcutActionSpec[] = [
  {
    id: "controllerModeToggle",
    label: "Toggle Controller Mode",
    description: "Enter or exit Controller Mode for the focus queue.",
  },
  {
    id: "controllerModeNext",
    label: "Next session",
    description:
      "Advance to the next focus-queue session. While an advance countdown is pending, this commits the advance immediately instead of waiting.",
  },
  {
    id: "controllerModeDone",
    label: "Mark session done",
    description: "Remove the active session from the focus queue.",
  },
  {
    id: "controllerModeStay",
    label: "Stay on session",
    description: "Cancel a pending focus-queue advance countdown.",
  },
];

/**
 * Default chords. We use `ctrl-*` everywhere (not `cmd-*`) because
 * Cmd collides with too many macOS system shortcuts (Cmd+W, Cmd+Q,
 * Cmd+R, …) and the user is more likely to want a fresh binding than
 * to override one of those. The matcher is strict per-platform
 * (see `client/src/lib/shortcut-match.ts`), so a stored `ctrl-n`
 * matches ⌃N on macOS and Ctrl+N everywhere else — never both.
 */
export const DEFAULT_SHORTCUT_BINDINGS: Record<ShortcutActionId, string> = {
  controllerModeToggle: "ctrl-t",
  controllerModeNext: "ctrl-n",
  controllerModeDone: "ctrl-d",
  controllerModeStay: "ctrl-s",
};

/** Reserved OS / browser chords we warn about (but don't block). */
export const RESERVED_SHORTCUTS: string[] = [
  "cmd-w", // close window/tab
  "cmd-q", // quit
  "cmd-r", // reload
  "cmd-shift-r", // hard reload
  "cmd-shift-delete", // clear browsing data in some browsers
  "ctrl-w",
  "ctrl-r",
  "ctrl-shift-r",
  "ctrl-shift-delete",
  "alt-f4", // close window on Windows
  "f11", // full-screen toggle
];

/** Type for what the server returns to the client. */
export type ShortcutBindings = Record<ShortcutActionId, string>;