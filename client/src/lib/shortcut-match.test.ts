import test from "node:test";
import assert from "node:assert/strict";
import {
  findMatchingAction,
  formatChord,
  matchesEvent,
  parseChord,
  serialiseEvent,
} from "./shortcut-match.ts";

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

test("matchesEvent recognises Cmd+N when metaKey is held", () => {
  const parsed = parseChord("cmd-n")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true })), true);
});

test("matchesEvent recognises Cmd+N even when ctrlKey is held (portable)", () => {
  const parsed = parseChord("cmd-n")!;
  // A user on Linux who pressed Ctrl+N should still fire a "cmd-n"
  // binding so the persisted file stays portable across machines.
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", ctrlKey: true })), true);
});

test("matchesEvent requires the modifier for a non-escape chord", () => {
  const parsed = parseChord("cmd-n")!;
  // No modifier held at all → not a match.
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" })), false);
});

test("matchesEvent requires the exact shift state", () => {
  const parsed = parseChord("cmd-shift-n")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true, shiftKey: true })), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n", metaKey: true })), false);
});

test("matchesEvent requires the exact alt state", () => {
  const parsed = parseChord("cmd-alt-d")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "d", metaKey: true, altKey: true })), true);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "d", metaKey: true })), false);
});

test("matchesEvent normalises Escape alias to lowercase 'escape'", () => {
  const parsed = parseChord("escape")!;
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "Escape" })), true);
});

test("matchesEvent rejects a 'cmd-n' chord when only a letter is pressed", () => {
  const parsed = parseChord("cmd-n")!;
  // No modifier held at all → not a match for a chord that requires one.
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" })), false);
});

test("matchesEvent accepts a modifier-less chord when no modifier is held", () => {
  const parsed = parseChord("n")!;
  assert.equal(parsed.primary, null);
  assert.equal(matchesEvent(parsed, fakeEvent({ key: "n" })), true);
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

test("formatChord falls back to the raw string when the chord is invalid", () => {
  assert.equal(formatChord("not-a-real-chord", true), "not-a-real-chord");
});

test("findMatchingAction returns the bound action for a matching event", () => {
  const bindings = { next: "cmd-n", done: "cmd-d", stay: "cmd-s" };
  const action = findMatchingAction(bindings, fakeEvent({ key: "d", metaKey: true }));
  assert.equal(action, "done");
});

test("findMatchingAction returns null when no chord matches", () => {
  const bindings = { next: "cmd-n", done: "cmd-d" };
  const action = findMatchingAction(bindings, fakeEvent({ key: "k", metaKey: true }));
  assert.equal(action, null);
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