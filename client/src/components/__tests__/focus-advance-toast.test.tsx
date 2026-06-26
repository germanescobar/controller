import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  type ShortcutBindings,
} from "../../../../shared/shortcuts.ts";
import { formatChord, isMacPlatform } from "../../lib/shortcut-match.ts";
import { FocusAdvanceToast } from "../focus-advance-toast.tsx";

/*
 * Regression test for the focus-advance countdown toast (issue
 * follow-up to #235).
 *
 * Background: issue #235 moved every Controller Mode shortcut to a
 * modifier-based chord so it fires regardless of focus (default
 * `Ctrl+S` for stay, `Ctrl+N` for continue). The toast copy was left
 * untouched, advertising "Press S to stay · N to continue" — strings
 * that no longer match the keys the listener honours.
 *
 * This test asserts the toast surfaces the actual chords:
 *
 *   - With `bindings === null` (first paint, before the server fetch
 *     resolves) it falls back to the bundled defaults so the copy is
 *     never the stale single-letter "S" / "N".
 *   - With a custom `bindings` map (e.g. user rebound next to
 *     `cmd-shift-n` in Settings) the toast reflects that binding
 *     verbatim so the visible chip and the live chord stay in sync.
 *
 * We mirror the toast's `formatChord(chord, isMacPlatform())` call
 * here so the expected labels track the platform the test runs on
 * (macOS renders ⌃S, Linux/Windows render Ctrl+S) without
 * duplicating formatter logic.
 *
 * `renderToStaticMarkup` is enough — we don't need DOM effects for
 * the chip text, and the countdown timer isn't under test here.
 */

const NOOP = () => {};

function render(bindings: ShortcutBindings | null): string {
  return renderToStaticMarkup(
    <FocusAdvanceToast
      scheduledAt={Date.now()}
      durationMs={4000}
      bindings={bindings}
      onCancel={NOOP}
    />,
  );
}

function labelFor(chord: string): string {
  return formatChord(chord, isMacPlatform());
}

test("toast falls back to default stay / next chips when bindings are null", () => {
  const html = render(null);
  const stayDefault = labelFor(DEFAULT_SHORTCUT_BINDINGS.controllerModeStay);
  const nextDefault = labelFor(DEFAULT_SHORTCUT_BINDINGS.controllerModeNext);
  assert.ok(
    html.includes(`>${stayDefault}</span> to stay`),
    `expected toast to render default stay label "${stayDefault}", got: ${html}`,
  );
  assert.ok(
    html.includes(`>${nextDefault}</span> to continue`),
    `expected toast to render default next label "${nextDefault}", got: ${html}`,
  );
  // And — critically — the stale single-letter copy must not be present.
  assert.ok(
    !/>S<\/span> to stay/.test(html),
    "stale single-letter 'S' chip must be gone",
  );
  assert.ok(
    !/>N<\/span> to continue/.test(html),
    "stale single-letter 'N' chip must be gone",
  );
});

test("toast surfaces the rebound chord when the user customises it in Settings", () => {
  const rebound: ShortcutBindings = {
    ...DEFAULT_SHORTCUT_BINDINGS,
    controllerModeStay: "ctrl-shift-s",
    controllerModeNext: "ctrl-shift-n",
  };
  const html = render(rebound);
  const stayLabel = labelFor(rebound.controllerModeStay);
  const nextLabel = labelFor(rebound.controllerModeNext);
  assert.ok(
    html.includes(`>${stayLabel}</span> to stay`),
    `expected rebound stay label "${stayLabel}", got: ${html}`,
  );
  assert.ok(
    html.includes(`>${nextLabel}</span> to continue`),
    `expected rebound next label "${nextLabel}", got: ${html}`,
  );
});