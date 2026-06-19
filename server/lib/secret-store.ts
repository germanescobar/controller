/*
 * Encrypted-at-rest JSON store for integration secrets (issue #130).
 *
 * Secrets must never sit in plaintext when we can avoid it. The Express server
 * is imported directly into the Electron main process (see electron/main.ts),
 * so Electron's `safeStorage` — backed by the OS keychain — is available and is
 * the preferred path. When the server runs standalone (dev with `tsx`, tests, a
 * forked process where `electron` resolves to a path string rather than the
 * module) `safeStorage` is unavailable; we fall back to a 0600-permission
 * plaintext file so the feature still works, mirroring how `api-keys.json` is
 * stored today.
 *
 * The on-disk envelope records which format was used so reads can detect a
 * keychain that has since become unavailable instead of returning garbage.
 */

import fs from "node:fs/promises";
import path from "node:path";

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

/** Read and decrypt a JSON value, returning `fallback` when the file is absent. */
export async function readSecretJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return fallback;
  }

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return fallback;
  }

  if (!envelope.enc) {
    return envelope.data as T;
  }

  const safeStorage = await getSafeStorage();
  if (!safeStorage) {
    throw new Error(
      "Stored integration secrets are encrypted with the OS keychain, which is " +
        "not available in this process. Run Controller as the desktop app to access them."
    );
  }
  const decrypted = safeStorage.decryptString(Buffer.from(envelope.blob, "base64"));
  return JSON.parse(decrypted) as T;
}

/** Encrypt (when possible) and persist a JSON value, creating parent dirs. */
export async function writeSecretJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  const safeStorage = await getSafeStorage();
  if (safeStorage) {
    const blob = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    const envelope: EncryptedEnvelope = { v: 1, enc: true, blob };
    await fs.writeFile(file, JSON.stringify(envelope), { mode: 0o600 });
    return;
  }

  const envelope: PlaintextEnvelope = { v: 1, enc: false, data: value };
  await fs.writeFile(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}
