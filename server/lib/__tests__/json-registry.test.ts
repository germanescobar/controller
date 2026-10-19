import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Unit tests for the JSON registry helpers introduced for issue #332.
 * These cover the three concrete behaviors that fixed the silent registry
 * loss:
 *
 *   - atomic write (write to tmp, fsync, rename)
 *   - per-file mutex (concurrent readers can't interleave with a writer)
 *   - distinct handling of ENOENT (return default) vs parse failure
 *     (throw RegistryParseError, after attempting backup recovery)
 */

import {
  RegistryParseError,
  _setJsonRegistryFs,
  readJsonRegistry,
  validateArray,
  validateRecord,
  withLock,
  writeJsonRegistry,
} from "../json-registry.js";

async function tempHome(): Promise<{ homeDir: string; cleanup: () => Promise<void> }> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "json-registry-test-"));
  return {
    homeDir,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
}

test("writeJsonRegistry writes JSON atomically (no truncation observed)", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    await writeJsonRegistry(file, [{ id: "a" }, { id: "b" }]);

    // File should exist, contain valid JSON, and have NO leftover
    // `.tmp-*` siblings. The atomic write uses `<file>.tmp-<rand>`
    // which gets renamed over the target, so any failure should leave
    // the .tmp file in place rather than corrupt the target.
    const content = await fs.readFile(file, "utf-8");
    assert.deepEqual(JSON.parse(content), [{ id: "a" }, { id: "b" }]);

    const siblings = await fs.readdir(homeDir);
    assert.ok(
      siblings.every((entry) => !entry.includes(".tmp-")),
      `unexpected tmp files: ${siblings.join(", ")}`
    );
  } finally {
    await cleanup();
  }
});

test("writeJsonRegistry creates the parent directory if missing", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "nested", "deep", "registry.json");
    await writeJsonRegistry(file, { hello: "world" });
    const content = await fs.readFile(file, "utf-8");
    assert.deepEqual(JSON.parse(content), { hello: "world" });
  } finally {
    await cleanup();
  }
});

test("writeJsonRegistry mirrors the previous contents to <file>.bak", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    await writeJsonRegistry(file, { v: 1 });
    await writeJsonRegistry(file, { v: 2 });
    const backup = await fs.readFile(`${file}.bak`, "utf-8");
    assert.deepEqual(JSON.parse(backup), { v: 1 });
  } finally {
    await cleanup();
  }
});

test("writeJsonRegistry keeps a valid .bak when the primary is corrupt", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    const backup = `${file}.bak`;
    await fs.writeFile(file, "{ truncated");
    await fs.writeFile(backup, JSON.stringify([{ id: "good" }]));

    await writeJsonRegistry(file, [{ id: "good" }, { id: "new" }]);

    assert.deepEqual(JSON.parse(await fs.readFile(backup, "utf-8")), [{ id: "good" }]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), [
      { id: "good" },
      { id: "new" },
    ]);
  } finally {
    await cleanup();
  }
});

test("a failed rename while repairing a corrupt primary leaves .bak recoverable", async () => {
  const { homeDir, cleanup } = await tempHome();
  const fsLayer = {
    readFile: fs.readFile,
    open: fs.open,
    writeFile: fs.writeFile,
    rename: async () => {
      throw new Error("simulated crash before rename");
    },
    mkdir: fs.mkdir,
  };
  const previous = _setJsonRegistryFs(fsLayer);
  try {
    const file = path.join(homeDir, "registry.json");
    const backup = `${file}.bak`;
    await fs.writeFile(file, "{ truncated");
    await fs.writeFile(backup, JSON.stringify([{ id: "good" }]));

    await assert.rejects(writeJsonRegistry(file, [{ id: "new" }]), /simulated crash/);

    const { value, fromBackup } = await readJsonRegistry<{ id: string }[]>(file, {
      defaultValue: [],
      backup,
      validate: validateArray<{ id: string }>,
    });
    assert.deepEqual(value, [{ id: "good" }]);
    assert.equal(fromBackup, true);
  } finally {
    _setJsonRegistryFs(previous);
    await cleanup();
  }
});

test("readJsonRegistry returns the defaultValue when the file is missing (ENOENT)", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "missing.json");
    const { value, fromBackup } = await readJsonRegistry<number[]>(file, {
      defaultValue: [],
      validate: validateArray<number>,
    });
    assert.deepEqual(value, []);
    assert.equal(fromBackup, false);
  } finally {
    await cleanup();
  }
});

test("readJsonRegistry throws RegistryParseError when the file is corrupted", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    await fs.writeFile(file, "{ this is not valid json");
    await assert.rejects(
      readJsonRegistry<unknown>(file, { defaultValue: {} }),
      (err: unknown) => {
        assert.ok(err instanceof RegistryParseError);
        assert.equal((err as RegistryParseError).recoveredFromBackup, false);
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("readJsonRegistry recovers from a valid .bak when the primary file is corrupted", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    const backup = `${file}.bak`;
    // Primary is corrupt; backup has the last-known-good contents.
    await fs.writeFile(file, "garbage");
    await fs.writeFile(backup, JSON.stringify([{ id: "from-backup" }]));

    const { value, fromBackup } = await readJsonRegistry<{ id: string }[]>(file, {
      defaultValue: [],
      backup,
      validate: validateArray<{ id: string }>,
    });
    assert.deepEqual(value, [{ id: "from-backup" }]);
    assert.equal(fromBackup, true);
  } finally {
    await cleanup();
  }
});

test("readJsonRegistry surfaces a clear error when both primary and backup are corrupted", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    const backup = `${file}.bak`;
    await fs.writeFile(file, "garbage");
    await fs.writeFile(backup, "also garbage");

    await assert.rejects(
      readJsonRegistry<unknown>(file, {
        defaultValue: {},
        backup,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RegistryParseError);
        assert.equal((err as RegistryParseError).recoveredFromBackup, false);
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("validateArray coerces non-array values to the empty array", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    await fs.writeFile(file, JSON.stringify({ not: "an array" }));
    const { value } = await readJsonRegistry<unknown[]>(file, {
      defaultValue: [],
      validate: validateArray<unknown>,
    });
    assert.deepEqual(value, []);
  } finally {
    await cleanup();
  }
});

test("validateRecord coerces non-object values to an empty record", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "registry.json");
    await fs.writeFile(file, JSON.stringify(["not", "an", "object"]));
    const { value } = await readJsonRegistry<Record<string, number>>(
      file,
      { defaultValue: {}, validate: validateRecord<number> }
    );
    assert.deepEqual(value, {});
  } finally {
    await cleanup();
  }
});

test("withLock serializes callbacks against the same file (FIFO order)", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "counter.json");
    await writeJsonRegistry(file, { n: 0 });

    const order: number[] = [];
    const tick = async (id: number, holdMs: number) => {
      await withLock(file, async () => {
        order.push(id);
        // Hold the lock so concurrent acquirers queue up behind us.
        await new Promise((r) => setTimeout(r, holdMs));
        order.push(-id);
      });
    };

    // Three concurrent acquirers, each holding for a different duration.
    // With proper serialization the entry order must equal the exit
    // order, and no two `[+]` / `[-]` events from the same id can
    // interleave.
    const a = tick(1, 30);
    const b = tick(2, 10);
    const c = tick(3, 0);
    await Promise.all([a, b, c]);

    assert.deepEqual(order, [1, -1, 2, -2, 3, -3]);
  } finally {
    await cleanup();
  }
});

test("withLock releases the lock even when the callback throws", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const file = path.join(homeDir, "counter.json");
    await writeJsonRegistry(file, { n: 0 });

    await assert.rejects(
      withLock(file, async () => {
        throw new Error("boom");
      }),
      /boom/
    );

    // If the lock wasn't released, this second acquirer would never
    // resolve. Bound it with a timeout so a regression fails fast
    // instead of hanging the test.
    const second = withLock(file, async () => "ok");
    const result = await Promise.race([
      second,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("lock leaked")), 1000)
      ),
    ]);
    assert.equal(result, "ok");
  } finally {
    await cleanup();
  }
});

test("withLock uses independent queues per file", async () => {
  const { homeDir, cleanup } = await tempHome();
  try {
    const fileA = path.join(homeDir, "a.json");
    const fileB = path.join(homeDir, "b.json");
    await writeJsonRegistry(fileA, { v: 1 });
    await writeJsonRegistry(fileB, { v: 1 });

    // Hold file A's lock from inside A, then immediately request file
    // B's lock. If B's queue reused A's, this would deadlock.
    let bAcquired = false;
    const aDone = withLock(fileA, async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const bDone = withLock(fileB, async () => {
      bAcquired = true;
    });
    await Promise.all([aDone, bDone]);
    assert.equal(bAcquired, true);
  } finally {
    await cleanup();
  }
});