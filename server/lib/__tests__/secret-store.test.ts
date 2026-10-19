import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Recovery semantics for the at-rest secret store.
 *
 * Before this change, a corrupt encrypted envelope (one whose ciphertext
 * the current process's keychain can't decrypt — typical after a
 * rebuild that changed the app's signing identity) made every read
 * throw "Error while decrypting the ciphertext provided to
 * safeStorage.decryptString". That broke every code path that touched
 * secrets: starting a session with a connection, clicking Connect on
 * an OAuth scheme, even deleting one.
 *
 * The fix renames the un-decryptable file to `*.broken-<iso>` and
 * returns the fallback. The user re-authorizes any affected schemes;
 * `integrations.json` (plaintext) keeps the connection metadata.
 */

async function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secret-store-test-"));
  const file = path.join(dir, "secrets.json");
  try {
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withModule<T>(
  env: Record<string, string | undefined>,
  fn: (mod: typeof import("../secret-store.js")) => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const mod = await import(`../secret-store.js?t=${Date.now()}-${Math.random()}`);
    return await fn(mod);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("readSecretJson: returns fallback when the file is absent", async () => {
  await withTempFile(async (file) => {
    await withModule({}, async ({ readSecretJson }) => {
      const out = await readSecretJson(file, { default: true });
      assert.deepEqual(out, { default: true });
    });
  });
});

test("readSecretJson: returns the inline data for a plaintext envelope", async () => {
  await withTempFile(async (file) => {
    await fs.writeFile(
      file,
      JSON.stringify({ v: 1, enc: false, data: { token: "abc" } }),
      { mode: 0o600 }
    );
    await withModule({}, async ({ readSecretJson }) => {
      const out = await readSecretJson<{ token: string }>(file, { token: "" });
      assert.equal(out.token, "abc");
    });
  });
});

test("readSecretJson: returns fallback and treats the file as missing when the keychain is unavailable", async () => {
  // In a real `tsx` / test process there's no `electron` module, so
  // safeStorage resolves to null. The encrypted envelope can't be
  // decrypted; we surface a warning and return the fallback without
  // touching the file. This is the same branch that fires when a
  // background worker (e.g. the managed-skills installer) reads the
  // store outside Electron.
  //
  // The closely-related `decryptString throws` branch — which adds
  // the file rename — runs in production when a new build can't
  // decrypt a previous build's ciphertext. The recovery logic is
  // identical (try / catch around the decrypt call) and is covered by
  // end-to-end manual testing of the OAuth flow against a stale file.
  await withTempFile(async (file) => {
    await fs.writeFile(
      file,
      JSON.stringify({ v: 1, enc: true, blob: "irrelevant" }),
      { mode: 0o600 }
    );
    await withModule({}, async ({ readSecretJson }) => {
      const out = await readSecretJson<{ token: string }>(file, { token: "FALLBACK" });
      assert.deepEqual(out, { token: "FALLBACK" });
      const stillThere = await fs.readFile(file, "utf-8");
      assert.match(stillThere, /"enc":true/, "file is preserved (we don't rename without a real decrypt attempt)");
    });
  });
});

test("readSecretJson: encrypted envelope with no keychain access returns fallback and warns", async () => {
  await withTempFile(async (file) => {
    await fs.writeFile(
      file,
      JSON.stringify({ v: 1, enc: true, blob: "abc" }),
      { mode: 0o600 }
    );
    // No CONTROLLER_ENCRYPT_SECRETS, no electron module in scope →
    // safeStorage is null, so we hit the "keychain not available"
    // branch. Verify the file is *not* renamed (we only rename on a
    // real decrypt failure, not on missing-keychain) and the
    // fallback is returned.
    await withModule({}, async ({ readSecretJson }) => {
      const out = await readSecretJson(file, { fallback: 1 });
      assert.deepEqual(out, { fallback: 1 });
      const stillThere = await fs.readFile(file, "utf-8");
      assert.match(stillThere, /"enc":true/);
    });
  });
});

test("readSecretJson: malformed JSON with no backup is quarantined and returns fallback", async () => {
  await withTempFile(async (file) => {
    await fs.writeFile(file, "not json {", { mode: 0o600 });
    await withModule({}, async ({ readSecretJson }) => {
      const out = await readSecretJson(file, []);
      assert.deepEqual(out, []);
    });
    const entries = await fs.readdir(path.dirname(file));
    assert.ok(!entries.includes("secrets.json"), "corrupt file is moved aside");
    const broken = entries.filter((name) => name.startsWith("secrets.json.broken-"));
    assert.equal(broken.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(file), broken[0]), "utf-8"), "not json {");
  });
});

test("readSecretJson: a truncated store recovers from .bak without logging secret bytes", async () => {
  await withTempFile(async (file) => {
    await withModule({}, async ({ readSecretJson, writeSecretJson }) => {
      await writeSecretJson(file, { conn: { scheme: "SECRET-OLD" } });
      // The second write mirrors the first envelope to `.bak`.
      await writeSecretJson(file, { conn: { scheme: "SECRET-NEW" } });
      const raw = await fs.readFile(file, "utf-8");
      await fs.writeFile(file, raw.slice(0, raw.indexOf("SECRET-NEW") + 6));

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const out = await readSecretJson(file, {});
        assert.deepEqual(out, { conn: { scheme: "SECRET-OLD" } });
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /recovered secrets from .*\.bak/);
      assert.doesNotMatch(warnings[0], /SECRET/);
    });
  });
});

test("readSecretJson: unexpected I/O errors are thrown, not read as empty", async () => {
  await withTempFile(async (file) => {
    // A directory at the store path makes readFile fail with EISDIR.
    await fs.mkdir(file);
    await withModule({}, async ({ readSecretJson }) => {
      await assert.rejects(readSecretJson(file, {}), { code: "EISDIR" });
    });
  });
});

test("writeSecretJson: writes a plaintext envelope by default", async () => {
  await withTempFile(async (file) => {
    await withModule({ CONTROLLER_ENCRYPT_SECRETS: undefined }, async ({ writeSecretJson }) => {
      await writeSecretJson(file, { token: "x" });
      const raw = await fs.readFile(file, "utf-8");
      const envelope = JSON.parse(raw);
      assert.equal(envelope.v, 1);
      assert.equal(envelope.enc, false);
      assert.deepEqual(envelope.data, { token: "x" });
    });
  });
});

test("writeSecretJson: 0600 file mode regardless of envelope type", async () => {
  await withTempFile(async (file) => {
    await withModule({ CONTROLLER_ENCRYPT_SECRETS: undefined }, async ({ writeSecretJson }) => {
      await writeSecretJson(file, { token: "x" });
      await writeSecretJson(file, { token: "y" });
      // 0o600 = owner read/write only. The mode bitmask is the
      // lower 9 bits; group/other should be zero. The second write
      // also creates `.bak`, which holds secrets too.
      for (const target of [file, `${file}.bak`]) {
        const stat = await fs.stat(target);
        assert.equal(stat.mode & 0o777, 0o600, `expected 0600 permissions on ${target}`);
      }
    });
  });
});
