import test from "node:test";
import assert from "node:assert/strict";
import {
  findMatchingAction,
  formatChord,
  matchesEvent,
  parseChord,
  serialiseEvent,
} from "./shortcut-match.ts";
import { DEFAULT_SHORTCUT_BINDINGS } from "../../../shared/shortcuts.ts";

/**
 * Build a fake KeyboardEvent with the given key + modifier state. The
 * matcher only reads `key`, `metaKey`, `ctrlKey`, `altKey`, `shiftKey`,
 * so we don't need a full DOM event.
 */
function fakeEvent(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: opts.shiftKey ?? false,
  } as KeyboardEvent;
}

test("parseChord parses a basic cmd+n chord", () => {
  const parsed = parseChord("cmd-n");
  assert.deepEqual(parsed, { primary: "cmd", shift: false, alt: false, key: "n" });
});

test("parseChord parses ctrl+shift+N regardless of case", () => {
  const parsed = parseChord("CTRL+SHIFT+N");
  assert.deepEqual(parsed, { primary: "ctrl", shift: true, alt: false, key: "n" });
});

test("parseChord accepts meta as a synonym for cmd", () => {
  const parsed = parseChord("meta-t");
  assert.deepEqual(parsed, { primary: "cmd", shift: false, alt: false, key: "t" });
});

test("parseChord accepts option as a synonym for alt", () => {
  const parsed = parseChord("cmd-option-d");
  assert.deepEqual(parsed, { primary: "cmd", shift: false, alt: true, key: "d" });
});

test("parseChord returns null for an empty string", () => {
  assert.equal(parseChord(""), null);
  assert.equal(parseChord("   "), null);
});

test("parseChord returns null when no key is present", () => {
  assert.equal(parseChord("cmd"), null);
  assert.equal(parseChord("cmd-shift"), null);
});

test("parseChord returns null when more than one key is present", () => {
  assert.equal(parseChord("cmd-n-m"), null);
});

test("parseChord keeps primary null when none is specified (escape)", () => {
  const parsed = parseChord("escape");
  assert.equal(parsed?.key, "escape");
  assert.equal(parsed?.primary, null);
});

test("parseChord accepts '+' as a separator as well as '-'", () => {
  const parsed = parseChord("cmd+shift+n");
  assert.deepEqual(parsed, { primary: "cmd", shift: true, alt: false, key: "n" });
});

test("matchesEvent recognises Cmd+N on macOS when metaKey is held", () => {
  const parsed = parseChord("cmd-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true }), true),
    true,
  );
});

test("matchesEvent does NOT match Ctrl+N on macOS for a stored cmd-n chord", () => {
  // Strict per-platform: a user who explicitly picks Cmd+N on macOS
  // should not have it accidentally fire when they press Ctrl+N. That
  // would defeat the purpose of avoiding Cmd-system-chord collisions.
  const parsed = parseChord("cmd-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", ctrlKey: true }), true),
    false,
  );
});

test("matchesEvent recognises Ctrl+N on Linux for a stored cmd-n chord", () => {
  // Off-mac, "cmd" maps to the Ctrl key (the OS sends ctrlKey for
  // what users call "Cmd" on Mac). Strict per-platform means we
  // accept ctrlKey and reject metaKey.
  const parsed = parseChord("cmd-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", ctrlKey: true }), false),
    true,
  );
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true }), false),
    false,
  );
});

test("matchesEvent recognises Ctrl+N on macOS when ctrlKey is held", () => {
  const parsed = parseChord("ctrl-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", ctrlKey: true }), true),
    true,
  );
});

test("matchesEvent does NOT match Cmd+N on macOS for a stored ctrl-n chord", () => {
  // Strict per-platform: a stored "ctrl-n" should never fire on the
  // metaKey on macOS, otherwise the user couldn't pick a clean ⌃N
  // binding without worrying about the OS sending metaKey events.
  const parsed = parseChord("ctrl-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true }), true),
    false,
  );
});

test("matchesEvent recognises Ctrl+N off-mac for a stored ctrl-n chord", () => {
  // The strict-per-platform flag is irrelevant for the `ctrl` branch:
  // the physical Control key reads `ctrlKey` on every OS. Off-mac
  // Ctrl+N must match a stored "ctrl-n" — that's the path the default
  // chords (Ctrl+T/N/D/S) take for every Linux/Windows user. The
  // previous implementation rejected this case (issue #235 P1 review).
  const parsed = parseChord("ctrl-n")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", ctrlKey: true }), false),
    true,
  );
  // Meta shouldn't fire a ctrl chord off-mac either.
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true }), false),
    false,
  );
});

test("matchesEvent recognises Ctrl+T off-mac for the default toggle chord", () => {
  // Direct regression for the bug Codex flagged: the default toggle
  // chord is 'ctrl-t', and on Linux a user pressing Ctrl+T must
  // trigger it.
  const parsed = parseChord("ctrl-t")!;
  assert.equal(
    matchesEvent(parsed, fakeEvent({ key: "t", ctrlKey: true }), false),
    true,
  );
});

test("matchesEvent requires the modifier for a non-escape chord", () => {
  const parsed = parseChord("cmd-n")!;
  // No modifier held at all → not a match.
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), true), false);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), false), false);
});

test("matchesEvent requires the exact shift state", () => {
  const parsed = parseChord("cmd-shift-n")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true, shiftKey: true }), true), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true }), true), false);
});

test("matchesEvent requires the exact alt state", () => {
  const parsed = parseChord("cmd-alt-d")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "d", metaKey: true, altKey: true }), true), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "d", metaKey: true }), true), false);
});

test("matchesEvent normalises Escape alias to lowercase 'escape'", () => {
  const parsed = parseChord("escape")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "Escape" }), true), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "Escape" }), false), true);
});

test("matchesEvent rejects a 'cmd-n' chord when only a letter is pressed", () => {
  const parsed = parseChord("cmd-n")!;
  // No modifier held at all → not a match for a chord that requires one.
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), true), false);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), false), false);
});

test("matchesEvent accepts a modifier-less chord when no modifier is held", () => {
  const parsed = parseChord("n")!;
  assert.equal(parsed.primary, null);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), true), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" }), false), true);
});

test("formatChord renders ⌘N on macOS", () => {
  assert.equal(formatChord("cmd-n", true), "⌘N");
});

test("formatChord renders Ctrl+N off macOS", () => {
  assert.equal(formatChord("cmd-n", false), "Ctrl+N");
});

test("formatChord renders ⇧ for Shift on macOS and Shift elsewhere", () => {
  assert.equal(formatChord("cmd-shift-n", true), "⌘⇧N");
  assert.equal(formatChord("cmd-shift-n", false), "Ctrl+Shift+N");
});

test("formatChord pretty-prints Enter / Escape / Arrow keys", () => {
  assert.equal(formatChord("cmd-enter", true), "⌘Enter");
  assert.equal(formatChord("escape", true), "Esc");
  assert.equal(formatChord("cmd-arrowup", true), "⌘↑");
});

test("formatChord renders ⌃N on macOS for a stored ctrl-n chord", () => {
  // Regression: the previous implementation used the literal word
  // "Ctrl" on macOS, which glued onto the key letter ("CtrlN").
  assert.equal(formatChord("ctrl-n", true), "⌃N");
  assert.equal(formatChord("ctrl-shift-n", true), "⌃⇧N");
});

test("formatChord falls back to the raw string when the chord is invalid", () => {
  assert.equal(formatChord("not-a-real-chord", true), "not-a-real-chord");
});

test("findMatchingAction returns the bound action for a matching event", () => {
  const bindings = { next: "cmd-n", done: "cmd-d", stay: "cmd-s" };
  const action = findMatchingAction(
    bindings,
    fakeEvent({ key: "d", metaKey: true }),
    true,
  );
  assert.equal(action, "done");
});

test("findMatchingAction returns null when no chord matches", () => {
  const bindings = { next: "cmd-n", done: "cmd-d" };
  const action = findMatchingAction(
    bindings,
    fakeEvent({ key: "k", metaKey: true }),
    true,
  );
  assert.equal(action, null);
});

test("findMatchingAction treats ctrl and cmd as different on macOS", () => {
  // A binding for "cmd-n" must NOT match an event with ctrlKey held
  // on macOS. Otherwise a user who picked ⌘N to avoid Cmd-system-chord
  // collisions would have it fire on Ctrl+N too.
  const bindings = { next: "cmd-n" };
  assert.equal(
    findMatchingAction(bindings, fakeEvent({ key: "n", ctrlKey: true }), true),
    null,
  );
  assert.equal(
    findMatchingAction(bindings, fakeEvent({ key: "n", metaKey: true }), true),
    "next",
  );
});

test("serialiseEvent returns null for a bare letter (no modifiers)", () => {
  assert.equal(serialiseEvent(fakeEvent({ key: "n" })), null);
});

test("serialiseEvent captures cmd-shift-d", () => {
  assert.equal(serialiseEvent(fakeEvent({ key: "d", metaKey: true, shiftKey: true })), "cmd-shift-d");
});

test("serialiseEvent ignores modifier-only keypresses", () => {
  assert.equal(serialiseEvent(fakeEvent({ key: "Shift", shiftKey: true })), null);
  assert.equal(serialiseEvent(fakeEvent({ key: "Meta", metaKey: true })), null);
});

test("serialiseEvent captures Ctrl+Enter off-mac", () => {
  assert.equal(
    serialiseEvent(fakeEvent({ key: "Enter", ctrlKey: true })),
    "ctrl-enter",
  );
});

test("DEFAULT_SHORTCUT_BINDINGS use ctrl-* (Cmd collides with too many macOS chords)", () => {
  // Guard against an accidental revert: a Cmd-default on macOS would
  // collide with Cmd+W / Cmd+Q / Cmd+R / Cmd+T (the last one is the
  // browser's "new tab" shortcut). See issue #235.
  for (const [action, chord] of Object.entries(DEFAULT_SHORTCUT_BINDINGS)) {
    assert.ok(
      chord.startsWith("ctrl-"),
      `default for ${action} should be ctrl-* but was ${chord}`,
    );
  }
});