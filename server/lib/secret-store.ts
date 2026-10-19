/*
 * At-rest JSON store for integration secrets (issue #130).
 *
 * Two storage formats are supported, identified by the on-disk envelope:
 *
 *   1. Encrypted (`{ v: 1, enc: true, blob }`). The blob is base64 of
 *      `safeStorage.encryptString`'s output. Used when the server runs
 *      inside an Electron build that has access to a stable keychain
 *      identity — i.e. a properly signed/notarized build. The OS
 *      keychain is what makes the ciphertext unreadable to other
 *      processes.
 *
 *   2. Plaintext (`{ v: 1, enc: false, data }`). A 0600 file with the
 *      JSON inline. Used when safeStorage is unavailable (the server
 *      is running under `tsx` for tests, or as a forked process where
 *      `electron` resolves to a binary path string rather than the
 *      module).
 *
 * The historical Controller builds (issue #130) shipped only ad-hoc
 * signed Electron binaries. Each rebuild produces a different code-
 * signing identity, so safeStorage's per-binary keychain entry changes
 * with every release — old ciphertext is unreadable by the new
 * binary, throwing "Error while decrypting the ciphertext provided to
 * safeStorage.decryptString" on every read. To avoid that footgun we
 * use the plaintext envelope for now and document the trade-off:
 * secrets at rest are protected by 0600 file permissions only, not
 * OS-level encryption. A future notarized build can opt back into the
 * encrypted envelope by setting `CONTROLLER_ENCRYPT_SECRETS=1`.
 *
 * Durability (issue #469): writes go through `writeJsonRegistry` — a 0600
 * tmp file, fsync, then an atomic rename — and the previous valid envelope
 * is mirrored to `<file>.bak`. Callers doing read-modify-write must hold
 * `withLock(file)` (see integrations.ts).
 *
 * Recovery on read:
 *   - Unparseable or malformed envelope (e.g. a truncated file): warn and
 *     use `<file>.bak`. If the backup is unusable too, quarantine the file
 *     and return the fallback.
 *   - Un-decryptable encrypted envelope: quarantine and return the fallback.
 * Quarantine renames the file to `<file>.broken-<iso>` so the bytes are kept
 * for manual recovery while the rest of the app keeps working; the user re-
 * authorizes affected connections. The connections themselves live in
 * `integrations.json` (plaintext) and are preserved. Any other I/O error
 * (other than a missing file) is thrown rather than read as "empty", so a
 * following write can't wipe the store. Warnings never include file contents
 * or parse-error messages, which can quote secret bytes.
 */

import fs from "node:fs/promises";
import { readJsonRegistry, RegistryParseError, writeJsonRegistry } from "./json-registry.js";

interface EncryptedEnvelope {
  v: 1;
  enc: true;
  /** base64 of safeStorage ciphertext over the JSON payload. */
  blob: string;
}

interface PlaintextEnvelope {
  v: 1;
  enc: false;
  data: unknown;
}

type Envelope = EncryptedEnvelope | PlaintextEnvelope;

type SafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

let cachedSafeStorage: SafeStorage | null | undefined;

/**
 * When `CONTROLLER_ENCRYPT_SECRETS=1`, prefer the encrypted envelope even
 * outside Electron when safeStorage is available. Default off: the project
 * ships only ad-hoc-signed builds, where the per-binary keychain entry
 * changes every rebuild and turns the encrypted envelope into a trap.
 */
function preferEncryption(): boolean {
  return process.env.CONTROLLER_ENCRYPT_SECRETS === "1";
}

/*
 * Resolve Electron's `safeStorage` if we are running inside Electron and the OS
 * keychain is ready. Cached because the answer cannot change within a process.
 * Outside Electron, `import("electron")` resolves to the binary path string, so
 * `safeStorage` is undefined and we return null.
 */
async function getSafeStorage(): Promise<SafeStorage | null> {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  try {
    const electron = (await import("electron")) as unknown as {
      safeStorage?: SafeStorage;
    };
    const ss = electron.safeStorage;
    cachedSafeStorage = ss && ss.isEncryptionAvailable() ? ss : null;
  } catch {
    cachedSafeStorage = null;
  }
  return cachedSafeStorage;
}

/**
 * Read and parse a JSON value, returning `fallback` when the file is absent,
 * corrupt beyond backup recovery, or encrypted with a key the current process
 * can't access. Unexpected I/O errors are thrown.
 *
 * The decrypt-failure path matters in practice: when `safeStorage.decryptString`
 * throws, the file on disk was written by a build whose keychain identity the
 * current process no longer has (typical when the Electron app has been
 * rebuilt and re-signed).
 */
export async function readSecretJson<T>(file: string, fallback: T): Promise<T> {
  const envelope = await readEnvelope(file);
  if (!envelope) return fallback;

  if (!envelope.enc) {
    return envelope.data as T;
  }

  const safeStorage = await getSafeStorage();
  if (!safeStorage) {
    // Encrypted envelope but no keychain access in this process. The
    // file was written by Electron; we can't read it from `tsx` / tests.
    // Treat as missing so reads don't crash the rest of the app.
    console.warn(
      `[secret-store] ${file} is encrypted with the OS keychain, which is ` +
        "not available in this process. Treating as empty."
    );
    return fallback;
  }
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(envelope.blob, "base64"));
    return JSON.parse(decrypted) as T;
  } catch (error) {
    // Most common cause: the file was written by a different (rebuilt /
    // re-signed) Electron binary whose keychain entry the current
    // process can't access.
    await quarantine(
      file,
      `could not be decrypted (${error instanceof Error ? error.message : String(error)})`
    );
    return fallback;
  }
}

/** Encrypt (when possible) and atomically persist a JSON value as a 0600 file. */
export async function writeSecretJson(file: string, value: unknown): Promise<void> {
  await writeJsonRegistry(file, await buildEnvelope(file, value), {
    validate: validateEnvelope,
  });
}

async function buildEnvelope(file: string, value: unknown): Promise<Envelope> {
  if (preferEncryption()) {
    const safeStorage = await getSafeStorage();
    if (safeStorage) {
      try {
        const blob = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
        return { v: 1, enc: true, blob };
      } catch (error) {
        // If the keychain is in a weird state (just-rebuilt binary,
        // locked keychain, etc.) the encrypt call can throw. Fall
        // through to the plaintext path so the write still succeeds.
        console.warn(
          `[secret-store] Failed to encrypt ${file} (${error instanceof Error ? error.message : String(error)}). ` +
            "Falling back to plaintext envelope."
        );
      }
    }
  }
  return { v: 1, enc: false, data: value };
}

/*
 * Read the on-disk envelope, falling back to `<file>.bak` when the primary is
 * corrupt. Returns null when the file is missing or was quarantined because
 * neither copy is usable.
 */
async function readEnvelope(file: string): Promise<Envelope | null> {
  const backup = `${file}.bak`;
  try {
    const { value, fromBackup } = await readJsonRegistry<Envelope | null>(file, {
      defaultValue: null,
      backup,
      validate: validateEnvelope,
    });
    if (fromBackup) {
      console.warn(`[secret-store] ${file} is corrupt; recovered secrets from ${backup}.`);
    }
    return value;
  } catch (error) {
    // RegistryParseError's message quotes the JSON.parse error, which can
    // echo file contents — never log it.
    if (!(error instanceof RegistryParseError)) throw error;
    await quarantine(file, `is corrupt and ${backup} is missing or unusable`);
    return null;
  }
}

/** Throws unless `value` is a well-formed envelope. Used as a read/backup validator. */
function validateEnvelope(value: unknown): Envelope {
  if (typeof value === "object" && value !== null && "v" in value && value.v === 1) {
    if ("enc" in value && value.enc === true && "blob" in value && typeof value.blob === "string") {
      return { v: 1, enc: true, blob: value.blob };
    }
    if ("enc" in value && value.enc === false && "data" in value) {
      return { v: 1, enc: false, data: value.data };
    }
  }
  throw new Error("not a secret-store envelope");
}

/*
 * Move an unusable secrets file aside to `<file>.broken-<iso>` so we stop
 * tripping on it while keeping its bytes for manual recovery.
 */
async function quarantine(file: string, reason: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const broken = `${file}.broken-${stamp}`;
  console.warn(
    `[secret-store] ${file} ${reason}. Moving it aside to ${broken} and treating secrets as empty. ` +
      "Affected connections will need to be re-authorized."
  );
  try {
    await fs.rename(file, broken);
  } catch (error) {
    // Best-effort: the read still succeeds and the next write replaces the file.
    console.warn(
      `[secret-store] Failed to move ${file} aside: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
