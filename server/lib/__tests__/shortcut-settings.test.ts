/*
 * Tests for the persisted shortcut overrides in
 * `server/lib/shortcut-settings.ts` (issue #235).
 *
 * Strategy: point `CONTROLLER_HOME` at a temp directory so the JSON
 * file lives somewhere we can wipe between cases without touching
 * the user's real config.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearShortcutBindings,
  DEFAULT_SHORTCUT_BINDINGS,
  getShortcutBindings,
  setShortcutBindings,
  type ShortcutBindings,
} from "../shortcut-settings.js";

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CONTROLLER_HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), "ctrl-shortcuts-"));
  process.env.CONTROLLER_HOME = home;
  return fn(home).finally(() => {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

test("returns bundled defaults when no overrides exist", async () => {
  await withTempHome(async () => {
    const bindings = await getShortcutBindings();
    assert.deepEqual(bindings, DEFAULT_SHORTCUT_BINDINGS);
  });
});

test("setShortcutBindings persists a subset of overrides", async () => {
  await withTempHome(async () => {
    const next = await setShortcutBindings({
      controllerModeToggle: "cmd-shift-t",
    });
    assert.equal(next.controllerModeToggle, "cmd-shift-t");
    assert.equal(next.controllerModeNext, DEFAULT_SHORTCUT_BINDINGS.controllerModeNext);

    // Re-read to confirm disk persistence.
    const reread = await getShortcutBindings();
    assert.equal(reread.controllerModeToggle, "cmd-shift-t");
  });
});

test("setShortcutBindings ignores unknown action ids", async () => {
  await withTempHome(async () => {
    // Cast to bypass the static check — the runtime contract is what we
    // actually care about here.
    await setShortcutBindings({
      // @ts-expect-error — intentionally bad id
      nope: "cmd-x",
      controllerModeDone: "cmd-shift-d",
    });
    const bindings = await getShortcutBindings();
    assert.equal("nope" in bindings, false);
    assert.equal(bindings.controllerModeDone, "cmd-shift-d");
  });
});

test("setShortcutBindings normalises case and whitespace", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      controllerModeStay: "  CMD+Shift+S  ",
    });
    const bindings = await getShortcutBindings();
    assert.equal(bindings.controllerModeStay, "cmd-shift-s");
  });
});

test("setShortcutBindings drops non-string values", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      // @ts-expect-error — intentionally bad value
      controllerModeNext: 42,
      // @ts-expect-error — empty string should also be dropped
      controllerModeDone: "",
    });
    const bindings = await getShortcutBindings();
    assert.equal(bindings.controllerModeNext, DEFAULT_SHORTCUT_BINDINGS.controllerModeNext);
    assert.equal(bindings.controllerModeDone, DEFAULT_SHORTCUT_BINDINGS.controllerModeDone);
  });
});

test("clearShortcutBindings wipes all overrides and returns defaults", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({ controllerModeNext: "cmd-shift-n" });
    const cleared = await clearShortcutBindings();
    assert.deepEqual(cleared, DEFAULT_SHORTCUT_BINDINGS);

    const reread = await getShortcutBindings();
    assert.deepEqual(reread, DEFAULT_SHORTCUT_BINDINGS);
  });
});

test("getShortcutBindings merges overrides over defaults in canonical order", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      controllerModeToggle: "cmd-shift-t",
      controllerModeStay: "cmd-shift-s",
    });
    const bindings: ShortcutBindings = await getShortcutBindings();
    // Every action id must be present, even ones the user didn't override.
    for (const id of Object.keys(DEFAULT_SHORTCUT_BINDINGS)) {
      assert.ok(id in bindings, `${id} should be in merged bindings`);
    }
    assert.equal(bindings.controllerModeToggle, "cmd-shift-t");
    assert.equal(bindings.controllerModeStay, "cmd-shift-s");
    assert.equal(bindings.controllerModeNext, DEFAULT_SHORTCUT_BINDINGS.controllerModeNext);
  });
});