import fs from "node:fs/promises";
import path from "node:path";

/*
 * Shared safeguards for the orchestrator's JSON-on-disk registries
 * (worktrees, terminal tabs, schedules index, …).
 *
 * Issue #332: the previous `readRegistry` / `writeRegistry` helpers had
 * three concrete unsafe behaviors that combined to silently wipe the
 * registry:
 *
 *   1. `writeRegistry` used `fs.writeFile`, which truncates the
 *      destination before the new JSON is fully written — readers can
 *      observe an empty or partially written file.
 *   2. Registry read-modify-write operations were not serialized, so
 *      two writers could interleave or a writer could race a reader.
 *   3. `readRegistry` swallowed every error (parse or I/O) and returned
 *      `[]`, which callers like `ensureMainInRegistry` then persisted
 *      back as "the new registry contents" — a transient parse failure
 *      became a catastrophic data loss.
 *
 * This module addresses all three:
 *
 *   - Atomic write via `write-to-tmp-then-rename`. POSIX rename within
 *     the same directory is atomic at the filesystem level, so a reader
 *     either sees the old contents or the new contents — never a
 *     truncated file.
 *   - A per-file promise-chain mutex so concurrent read-modify-write
 *     calls in the same Node process are serialized. The orchestrator
 *     is a single-process app, so process-level locking is sufficient.
 *   - A backup of the last known good file (`<file>.bak`) maintained on
 *     every successful write, plus an explicit distinction between
 *     `ENOENT` (first-run → return the default) and other failures
 *     (parse error → throw, after attempting backup recovery).
 *
 * The helpers are intentionally generic. They don't know about Worktree
 * or TerminalTab — they just store/retrieve JSON. Higher-level modules
 * pick a default value (empty array / empty record) and a `key` to
 * serialize against.
 */

/**
 * Indirection seam so tests can inject a slow `writeFile` /
 * `fs.open` / `fs.rename` to reproduce the truncate-then-write race
 * without monkey-patching the host `node:fs/promises` module (whose
 * exports are read-only).
 */
export interface JsonRegistryFs {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  open(path: string, flags: string, mode: number): Promise<{
    writeFile(data: string, encoding: "utf-8"): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
}

const defaultFs: JsonRegistryFs = {
  readFile: fs.readFile,
  open: fs.open,
  writeFile: fs.writeFile,
  rename: fs.rename,
  mkdir: fs.mkdir,
};

let activeFs: JsonRegistryFs = defaultFs;

/** Test-only: install a custom fs layer. Returns the previous one. */
export function _setJsonRegistryFs(layer: JsonRegistryFs | null): JsonRegistryFs {
  const previous = activeFs;
  activeFs = layer ?? defaultFs;
  return previous;
}

/** Thrown when the registry file exists but is not valid JSON. */
export class RegistryParseError extends Error {
  readonly code = "REGISTRY_PARSE_ERROR" as const;
  constructor(
    readonly file: string,
    readonly cause: Error,
    readonly recoveredFromBackup: boolean
  ) {
    super(
      `Failed to parse ${file}: ${cause.message}${
        recoveredFromBackup ? " (recovered from backup)" : ""
      }`
    );
    this.name = "RegistryParseError";
  }
}

interface Mutex {
  acquire(): Promise<() => void>;
}

/** Create a process-level FIFO mutex. */
function createMutex(): Mutex {
  // `tail` is a promise that resolves when the current holder
  // releases its lock. Each acquire() awaits the current tail, then
  // installs its own release-pointing promise as the new tail so the
  // next acquirer waits behind it. The returned `release` callback
  // signals the current holder that it's done.
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire() {
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = tail;
      tail = releasePromise;
      // Caller awaits `previous` so they enter the critical section
      // only after every prior holder has released.
      return previous.then(() => release);
    },
  };
}

const mutexes = new Map<string, Mutex>();

function mutexFor(file: string): Mutex {
  let m = mutexes.get(file);
  if (!m) {
    m = createMutex();
    mutexes.set(file, m);
  }
  return m;
}

/**
 * Read a JSON registry from `file`, falling back to `backup` if the
 * primary file exists but is unparseable. `defaultValue` is returned
 * only when the file is genuinely missing (`ENOENT`).
 *
 * Parse errors throw a `RegistryParseError` after the backup fallback
 * has been tried — the caller is expected to log them, not to
 * silently treat them as "the registry is empty".
 */
export async function readJsonRegistry<T>(
  file: string,
  options: { defaultValue: T; backup?: string; validate?: (v: unknown) => T }
): Promise<{ value: T; fromBackup: boolean }> {
  let content: string;
  try {
    content = await activeFs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: options.defaultValue, fromBackup: false };
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(content);
    const value = options.validate ? options.validate(parsed) : (parsed as T);
    return { value, fromBackup: false };
  } catch (parseErr) {
    if (options.backup) {
      try {
        const backupContent = await activeFs.readFile(options.backup, "utf-8");
        const parsed = JSON.parse(backupContent);
        const value = options.validate
          ? options.validate(parsed)
          : (parsed as T);
        return { value, fromBackup: true };
      } catch {
        // Fall through — backup is also unreadable. Throw the original
        // parse error so the caller sees the actual corruption.
      }
    }
    throw new RegistryParseError(
      file,
      parseErr as Error,
      false
    );
  }
}

/**
 * Atomically write JSON to `file`. Writes to `<file>.tmp-<rand>` first,
 * fsyncs the descriptor, then renames over the target. On success the
 * previous contents are mirrored to `<file>.bak` so a future parse
 * failure can recover.
 *
 * Serializes via the per-file mutex — callers must invoke this from
 * inside a `withLock` block so a concurrent reader can't observe the
 * file mid-rename. (The rename itself is atomic at the OS level, so a
 * reader outside the lock will see either the old or the new contents
 * — never a half-written file. The mutex mostly protects readers that
 * also need to mutate, e.g. addWorktree.)
 */
export async function writeJsonRegistry<T>(
  file: string,
  value: T,
  options: { validate?: (v: unknown) => unknown } = {}
): Promise<void> {
  const dir = path.dirname(file);
  await activeFs.mkdir(dir, { recursive: true });

  const backup = `${file}.bak`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  // Serialize JSON.stringify at the top of the function so the file
  // write below only fails for I/O reasons — easier to reason about
  // than catching a SyntaxError deep in the write pipeline.
  const serialized = JSON.stringify(value, null, 2);

  const handle = await activeFs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(serialized, "utf-8");
    // fsync so the rename below doesn't expose writes that haven't
    // reached disk yet — important after a crash for a recovery that
    // can trust the rename target.
    await handle.sync();
  } finally {
    await handle.close();
  }

  await mirrorToBackup(file, backup, options.validate);
  await activeFs.rename(tmp, file);
}

/*
 * Mirror the *previous* primary contents to `.bak` before the tmp file is
 * swapped in. Only a primary that is still readable — it parses and, when
 * a `validate` is supplied, passes it — is mirrored: when it is corrupt
 * (typically because the caller just recovered from `.bak`), overwriting
 * the backup would destroy the only good copy, and a crash or rename
 * failure before the swap would then leave both files unreadable. Pass the
 * same throwing validator used for reads so "valid JSON, wrong shape"
 * counts as corrupt too. On the very first write the primary doesn't
 * exist yet, so there's nothing to mirror. Failures are logged rather
 * than thrown — losing the backup is bad, but not as bad as failing the
 * user's write.
 */
async function mirrorToBackup(
  file: string,
  backup: string,
  validate?: (v: unknown) => unknown
): Promise<void> {
  try {
    const previous = await activeFs.readFile(file, "utf-8");
    if (!isReadable(previous, validate)) return;
    await activeFs.writeFile(backup, previous, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`Failed to back up ${file} to ${backup}: ${(err as Error).message}`);
  }
}

function isReadable(content: string, validate?: (v: unknown) => unknown): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    validate?.(parsed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the per-file write lock for `file`. Use this
 * for any read-modify-write sequence so concurrent callers can't
 * interleave their read and write phases.
 *
 *     await withLock(worktreesRegistryFile(), async () => {
 *       const { value } = await readJsonRegistry(...);
 *       value.push(newRecord);
 *       await writeJsonRegistry(...);
 *     });
 */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const mutex = mutexFor(file);
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Convenience wrapper for "read, validate, return". */
export function validateArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function validateRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : ({} as Record<string, T>);
}
