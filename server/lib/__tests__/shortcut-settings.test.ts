/*
 * Tests for the persisted shortcut overrides in
 * `server/lib/shortcut-settings.ts` (issue #235 + the
 * Controller-Mode-removal migration in #333 follow-up).
 *
 * Strategy: point `CONTROLLER_HOME` at a temp directory so the JSON
 * file lives somewhere we can wipe between cases without touching
 * the user's real config.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearShortcutBindings,
  DEFAULT_SHORTCUT_BINDINGS,
  getShortcutBindings,
  setShortcutBindings,
  shortcutBindingsFile,
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
      focusStay: "cmd-shift-s",
    });
    assert.equal(next.focusStay, "cmd-shift-s");
    assert.equal(next.focusAdvanceNext, DEFAULT_SHORTCUT_BINDINGS.focusAdvanceNext);

    // Re-read to confirm disk persistence.
    const reread = await getShortcutBindings();
    assert.equal(reread.focusStay, "cmd-shift-s");
  });
});

test("setShortcutBindings ignores unknown action ids", async () => {
  await withTempHome(async () => {
    // Cast to bypass the static check — the runtime contract is what we
    // actually care about here.
    await setShortcutBindings({
      // @ts-expect-error — intentionally bad id
      nope: "cmd-x",
      focusDone: "cmd-shift-d",
    });
    const bindings = await getShortcutBindings();
    assert.equal("nope" in bindings, false);
    assert.equal(bindings.focusDone, "cmd-shift-d");
  });
});

test("setShortcutBindings normalises case and whitespace", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      focusStay: "  CMD+Shift+S  ",
    });
    const bindings = await getShortcutBindings();
    assert.equal(bindings.focusStay, "cmd-shift-s");
  });
});

test("setShortcutBindings drops non-string values", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      // @ts-expect-error — intentionally bad value
      focusAdvanceNext: 42,
      // @ts-expect-error — empty string should also be dropped
      focusDone: "",
    });
    const bindings = await getShortcutBindings();
    assert.equal(bindings.focusAdvanceNext, DEFAULT_SHORTCUT_BINDINGS.focusAdvanceNext);
    assert.equal(bindings.focusDone, DEFAULT_SHORTCUT_BINDINGS.focusDone);
  });
});

test("clearShortcutBindings wipes all overrides and returns defaults", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({ focusAdvanceNext: "cmd-shift-n" });
    const cleared = await clearShortcutBindings();
    assert.deepEqual(cleared, DEFAULT_SHORTCUT_BINDINGS);

    const reread = await getShortcutBindings();
    assert.deepEqual(reread, DEFAULT_SHORTCUT_BINDINGS);
  });
});

test("getShortcutBindings merges overrides over defaults in canonical order", async () => {
  await withTempHome(async () => {
    await setShortcutBindings({
      focusStay: "cmd-shift-s",
      focusDone: "cmd-shift-d",
    });
    const bindings: ShortcutBindings = await getShortcutBindings();
    // Every action id must be present, even ones the user didn't override.
    for (const id of Object.keys(DEFAULT_SHORTCUT_BINDINGS)) {
      assert.ok(id in bindings, `${id} should be in merged bindings`);
    }
    assert.equal(bindings.focusStay, "cmd-shift-s");
    assert.equal(bindings.focusDone, "cmd-shift-d");
    assert.equal(bindings.focusAdvanceNext, DEFAULT_SHORTCUT_BINDINGS.focusAdvanceNext);
  });
});

// ---------------------------------------------------------------------------
// Controller-Mode → focus-queue migration (issue #333 follow-up).
//
// When the user upgrades across the rename, their persisted overrides
// file may still contain `controllerMode*` keys. The server should
// translate them to the new ids in-memory AND rewrite the file so
// future reads see the cleaned shape.
// ---------------------------------------------------------------------------

function writeLegacyOverrides(home: string, overrides: Record<string, string>) {
  // Mirror the on-disk shape — flat JSON object of action-id -> chord.
  mkdirSync(home, { recursive: true });
  writeFileSync(
    shortcutBindingsFile(),
    JSON.stringify(overrides, null, 2),
  );
}

test("legacy controllerMode* ids are translated to the new ids on read", async () => {
  await withTempHome(async (home) => {
    writeLegacyOverrides(home, {
      controllerModeNext: "cmd-shift-n",
      controllerModeStay: "cmd-shift-s",
      controllerModeDone: "cmd-shift-d",
    });

    const bindings = await getShortcutBindings();
    // Each legacy chord lands on its renamed equivalent.
    assert.equal(bindings.focusAdvanceNext, "cmd-shift-n");
    assert.equal(bindings.focusStay, "cmd-shift-s");
    assert.equal(bindings.focusDone, "cmd-shift-d");
    // The legacy keys themselves don't leak through.
    assert.equal("controllerModeNext" in bindings, false);
    assert.equal("controllerModeStay" in bindings, false);
    assert.equal("controllerModeDone" in bindings, false);
  });
});

test("legacy migration rewrites the on-disk file in the new shape", async () => {
  await withTempHome(async (home) => {
    writeLegacyOverrides(home, {
      controllerModeNext: "cmd-shift-n",
      controllerModeStay: "cmd-shift-s",
    });

    // Trigger the migration by reading.
    await getShortcutBindings();

    // The file should now have only the new keys.
    const onDisk = JSON.parse(readFileSync(shortcutBindingsFile(), "utf-8"));
    assert.deepEqual(Object.keys(onDisk).sort(), [
      "focusAdvanceNext",
      "focusStay",
    ]);
    assert.equal(onDisk.focusAdvanceNext, "cmd-shift-n");
    assert.equal(onDisk.focusStay, "cmd-shift-s");
    // controllerModeDone was not overridden, so it must not appear
    // (the file only stores overrides, not defaults).
    assert.equal("controllerModeDone" in onDisk, false);
  });
});

test("controllerModeToggle (no longer a real action) is dropped on migration", async () => {
  await withTempHome(async (home) => {
    writeLegacyOverrides(home, {
      controllerModeToggle: "cmd-shift-t",
    });

    const bindings = await getShortcutBindings();
    // Nothing gets remapped to a real action.
    assert.deepEqual(bindings, DEFAULT_SHORTCUT_BINDINGS);

    // The file is rewritten without the orphaned key.
    const onDisk = JSON.parse(readFileSync(shortcutBindingsFile(), "utf-8"));
    assert.equal("controllerModeToggle" in onDisk, false);
  });
});

test("a new-id override beats a legacy alias for the same action", async () => {
  // The user saved a chord under the new id and later (or earlier)
  // an old version of the file has a legacy id with a different chord.
  // We must not clobber the new-id value with the older one — the
  // user's most recent choice wins.
  await withTempHome(async (home) => {
    writeLegacyOverrides(home, {
      focusStay: "ctrl-shift-s",
      controllerModeStay: "cmd-shift-s",
    });

    const bindings = await getShortcutBindings();
    // The current focusStay override wins; the legacy alias is
    // migrated but discarded because the slot was already filled.
    assert.equal(bindings.focusStay, "ctrl-shift-s");

    // After the migration rewrites the file, only the new key
    // survives.
    const onDisk = JSON.parse(readFileSync(shortcutBindingsFile(), "utf-8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["focusStay"]);
    assert.equal(onDisk.focusStay, "ctrl-shift-s");
  });
});

test("unknown ids in the legacy file are dropped, not migrated", async () => {
  // Defensive: a future-removal or a typo in the file shouldn't crash
  // the reader. Unknown ids (not in the alias map) are dropped.
  await withTempHome(async (home) => {
    writeLegacyOverrides(home, {
      controllerModeNext: "cmd-shift-n",
      someRandomKey: "ctrl-x",
      filesPanelToggle: "cmd-alt-b",
    });

    const bindings = await getShortcutBindings();
    assert.equal(bindings.focusAdvanceNext, "cmd-shift-n");
    assert.equal(bindings.filesPanelToggle, "cmd-alt-b");
    // someRandomKey isn't a current or legacy id, so it's dropped.
    assert.equal("someRandomKey" in bindings, false);
  });
});