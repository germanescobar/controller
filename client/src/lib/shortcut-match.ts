/*
 * Parser + matcher for serialised keyboard shortcut chords.
 *
 * Chord format (case-insensitive):
 *
 *   "cmd-n"        → ⌘N / Ctrl+N
 *   "ctrl-shift-n" → Ctrl+Shift+N
 *   "escape"       → Esc
 *   "enter"        → Enter
 *
 * Modifier tokens recognised in any order before the key:
 *   cmd   (or meta)  → matches metaKey on macOS, ctrlKey elsewhere
 *   ctrl  (or control)
 *   shift
 *   alt   (or option)
 *
 * The "cmd vs ctrl" platform-resolution is deliberate: a user who picks
 * the macOS-default "Cmd+N" gets the same logical binding on Linux as
 * "Ctrl+N" — see `matchesEvent` below. That way the persisted file is
 * portable (issue #235).
 */

const MODIFIER_TOKENS = new Set(["cmd", "meta", "ctrl", "control", "shift", "alt", "option"]);

/** Tokens that map to "primary modifier" on the current platform. */
function platformPrimaryTokens(): { mac: string; other: string } {
  // `navigator` is undefined during SSR; default to non-mac.
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? { mac: "cmd", other: "ctrl" } : { mac: "ctrl", other: "cmd" };
}

export interface ParsedChord {
  /**
   * "cmd" / "ctrl" when the stored chord explicitly named one; null when
   * the chord is modifier-less (e.g. just "escape"). The matcher treats
   * `null` specially: the event must not have any primary modifier held.
   */
  primary: "cmd" | "ctrl" | null;
  shift: boolean;
  alt: boolean;
  /** Lower-case key, e.g. "n", "escape", "enter", "arrowup". */
  key: string;
}

export function parseChord(input: string): ParsedChord | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Accept "cmd+shift+n" and "cmd-shift+n" interchangeably. We split on
  // any non-alphanumeric run so "+", "-", " ", "_" all work.
  const parts = trimmed.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return null;

  let primary: "cmd" | "ctrl" | null = null;
  let shift = false;
  let alt = false;
  const keyParts: string[] = [];

  for (const token of parts) {
    if (token === "cmd" || token === "meta") {
      primary = "cmd";
    } else if (token === "ctrl" || token === "control") {
      primary = "ctrl";
    } else if (token === "shift") {
      shift = true;
    } else if (token === "alt" || token === "option") {
      alt = true;
    } else {
      keyParts.push(token);
    }
  }

  if (keyParts.length !== 1) return null;
  const key = keyParts[0];
  if (!key) return null;
  // A chord that says only "shift" with no other key is meaningless.
  if (primary === null && !alt && !shift && key === "shift") return null;

  return {
    primary,
    shift,
    alt,
    key,
  };
}

/**
 * True iff the given KeyboardEvent matches the stored chord.
 *
 * Modifier policy:
 *   - `event.metaKey`  matches the "cmd" token
 *   - `event.ctrlKey`  matches the "ctrl" token
 *   - The "opposite" modifier (ctrl when the chord says cmd, or vice
 *     versa) is allowed so a stored "cmd-n" still fires on Linux where
 *     the OS sends `ctrlKey`. This is intentional: the file is portable.
 *   - `altKey` and `shiftKey` must match exactly.
 *   - If the chord has no primary modifier (rare — e.g. just "escape"),
 *     neither metaKey nor ctrlKey may be held.
 */
export function matchesEvent(parsed: ParsedChord, event: KeyboardEvent): boolean {
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;

  const meta = event.metaKey;
  const ctrl = event.ctrlKey;
  if (parsed.primary === null) {
    if (meta || ctrl) return false;
  } else {
    const primaryHeld =
      parsed.primary === "cmd" ? meta || ctrl : ctrl || meta;
    if (!primaryHeld) return false;
  }

  const eventKey = normaliseEventKey(event);
  return eventKey === parsed.key;
}

function normaliseEventKey(event: KeyboardEvent): string {
  const key = event.key;
  // Normalise named keys so the user can write "escape" / "esc" / "enter" /
  // "return" interchangeably. We map the longest common aliases to a single
  // canonical form that the stored chord also uses (lowercase).
  switch (key) {
    case "Escape":
      return "escape";
    case "Enter":
      return "enter";
    case "Tab":
      return "tab";
    case " ":
      return "space";
    case "ArrowUp":
      return "arrowup";
    case "ArrowDown":
      return "arrowdown";
    case "ArrowLeft":
      return "arrowleft";
    case "ArrowRight":
      return "arrowright";
    default:
      return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  }
}

/**
 * Format a parsed chord for display. `metaMac` controls whether the
 * primary modifier renders as ⌘ (true) or Ctrl (false).
 */
export function formatChord(chord: string, metaMac: boolean): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const tokens: string[] = [];
  if (parsed.primary === "cmd") tokens.push(metaMac ? "⌘" : "Ctrl");
  else if (parsed.primary === "ctrl") tokens.push(metaMac ? "Ctrl" : "⌘");
  if (parsed.shift) tokens.push(metaMac ? "⇧" : "Shift");
  if (parsed.alt) tokens.push(metaMac ? "⌥" : "Alt");
  tokens.push(prettyKey(parsed.key));
  if (metaMac) {
    // macOS convention: symbols joined without "+".
    return tokens.join("");
  }
  return tokens.join("+");
}

function prettyKey(key: string): string {
  switch (key) {
    case "escape":
      return "Esc";
    case "enter":
      return "Enter";
    case "tab":
      return "Tab";
    case "space":
      return "Space";
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "arrowleft":
      return "←";
    case "arrowright":
      return "→";
    default:
      return key.toUpperCase();
  }
}

/**
 * Returns the matching action id for an event, or null.
 *
 * Bindings map action-id → chord-string. We resolve each chord to a
 * parsed form and return the first match.
 *
 * Note: in practice we don't use this — `useControllerModeShortcuts`
 * matches against each action's chord directly so the host can decide
 * priority (e.g. the `controllerModeNext` chord matches even while a
 * countdown is pending, taking precedence over `controllerModeStay`).
 * Exposed for future chords and for the settings UI's "what fires for
 * this chord?" lookup.
 */
export function findMatchingAction(
  bindings: Record<string, string>,
  event: KeyboardEvent,
): string | null {
  for (const [action, chord] of Object.entries(bindings)) {
    const parsed = parseChord(chord);
    if (!parsed) continue;
    if (matchesEvent(parsed, event)) return action;
  }
  return null;
}

/** Detect whether the current platform is macOS / iOS. */
export function isMacPlatform(): boolean {
  return platformPrimaryTokens().mac === "cmd";
}

/**
 * Turn a live KeyboardEvent (typically from a "record shortcut" UI)
 * into a serialised chord string. Returns null if the event is a
 * modifier-only press (no usable key) or has no modifiers — we
 * require at least one modifier so plain letter keys don't shadow
 * the composer.
 */
export function serialiseEvent(event: KeyboardEvent): string | null {
  const key = normaliseEventKey(event);
  if (!key) return null;
  // Modifier-only presses (just Shift/Ctrl/Alt/Meta) have event.key
  // equal to the modifier name. Those aren't bindable.
  if (
    key === "shift" ||
    key === "control" ||
    key === "alt" ||
    key === "meta"
  ) {
    return null;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return null;
  }
  const tokens: string[] = [];
  if (event.metaKey) tokens.push("cmd");
  if (event.ctrlKey) tokens.push("ctrl");
  if (event.altKey) tokens.push("alt");
  if (event.shiftKey) tokens.push("shift");
  tokens.push(key);
  return tokens.join("-");
}