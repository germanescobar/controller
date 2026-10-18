import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #332: registry loss under concurrent reads and writes.
 *
 * The previous `readRegistry` / `writeRegistry` pair in
 * `server/lib/worktrees.ts` had three concrete unsafe behaviors that
 * combined to wipe the worktrees.json registry:
 *
 *   1. `writeRegistry` used `fs.writeFile`, which truncates the
 *      destination before the new JSON is fully written. A reader
 *      during the truncate-to-rename window saw an empty file.
 *   2. Registry read-modify-write operations were not serialized. Two
 *      writers could interleave their read and write phases.
 *   3. `readRegistry` swallowed every error (including parse failures)
 *      and returned `[]`. Callers like `ensureMainInRegistry` then
 *      persisted the empty array back as the new contents — a single
 *      transient parse failure became a full registry wipe.
 *
 * The fix is a per-file mutex plus atomic write-via-rename plus
 * distinct error handling for ENOENT vs parse failure. These tests
 * exercise all three fixes end-to-end via the public worktrees API.
 */

async function withHome<T>(
  setup: (ctx: { homeDir: string; projectsFile: string; worktreesFile: string }) => Promise<void>,
  fn: (ctx: { homeDir: string; projectsFile: string; worktreesFile: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-registry-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectsFile = path.join(homeDir, "projects.json");
  const worktreesFile = path.join(homeDir, "worktrees.json");
  try {
    await setup({ homeDir, projectsFile, worktreesFile });
    return await fn({ homeDir, projectsFile, worktreesFile });
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function seedProjects(projectsFile: string, projects: Array<{ id: string; path: string }>): Promise<void> {
  await fs.writeFile(
    projectsFile,
    JSON.stringify(
      projects.map((project) => ({
        id: project.id,
        name: project.id,
        path: project.path,
        createdAt: "2026-01-01T00:00:00.000Z",
      }))
    )
  );
}

test("concurrent getProjectWorktrees calls do not corrupt the registry", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      // Pre-seed a registry with 20 worktrees across two projects. Each
      // row is a minimal but valid record so `validateArray` keeps it.
      const seeded = [];
      for (let i = 0; i < 20; i += 1) {
        seeded.push({
          id: `wt-${i}`,
          projectId: i % 2 === 0 ? "proj-a" : "proj-b",
          name: `wt-${i}`,
          path: `/tmp/wt-${i}`,
          isMain: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
      await fs.writeFile(worktreesFile, JSON.stringify(seeded));
      await seedProjects(projectsFile, [
        { id: "proj-a", path: "/tmp/a" },
        { id: "proj-b", path: "/tmp/b" },
      ]);
    },
    async () => {
      const { getProjectWorktrees } = await import("../worktrees.js");
      // Fire 50 concurrent reads against both projects. With the old
      // (unsynchronized) implementation, two of these reads would
      // occasionally observe each other's empty read-modify-write
      // window and persist a main-only registry, dropping the seeded
      // worktrees.
      const calls: Array<Promise<unknown[]>> = [];
      for (let i = 0; i < 25; i += 1) {
        calls.push(getProjectWorktrees("proj-a"));
        calls.push(getProjectWorktrees("proj-b"));
      }
      const results = await Promise.all(calls);

      // Every read must return the seeded rows plus a lazily-created
      // main row, never an empty list (the bug that wiped the
      // registry in production).
      for (const list of results) {
        assert.ok(list.length >= 10, `expected at least 10 worktrees, got ${list.length}`);
      }
    }
  );
});

test("concurrent addWorktree + getProjectWorktrees calls preserve all records", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      await fs.writeFile(worktreesFile, JSON.stringify([]));
      await seedProjects(projectsFile, [
        { id: "proj-a", path: "/tmp/a" },
        { id: "proj-b", path: "/tmp/b" },
      ]);
    },
    async () => {
      const { addWorktree, getProjectWorktrees } = await import("../worktrees.js");
      const adds: Array<Promise<unknown>> = [];
      for (let i = 0; i < 10; i += 1) {
        const projectId = i % 2 === 0 ? "proj-a" : "proj-b";
        adds.push(
          addWorktree({
            projectId,
            name: `wt-${i}`,
            path: `/tmp/wt-${i}`,
            isMain: false,
          })
        );
      }
      const reads: Array<Promise<unknown[]>> = [];
      for (let i = 0; i < 30; i += 1) {
        reads.push(getProjectWorktrees(i % 2 === 0 ? "proj-a" : "proj-b"));
      }
      await Promise.all([...adds, ...reads]);

      // After everything settles, every worktree added must still be
      // present. The old implementation would intermittently drop
      // records when an `addWorktree`'s read phase observed the
      // pre-add state and an earlier adder's write phase hadn't
      // landed yet.
      const projA = await getProjectWorktrees("proj-a");
      const projB = await getProjectWorktrees("proj-b");
      const aNames = projA.map((w) => w.name).sort();
      const bNames = projB.map((w) => w.name).sort();
      // Each project also gets a lazily-created "main" worktree the
      // first time it's read.
      assert.deepEqual(aNames, ["main", "wt-0", "wt-2", "wt-4", "wt-6", "wt-8"]);
      assert.deepEqual(bNames, ["main", "wt-1", "wt-3", "wt-5", "wt-7", "wt-9"]);
    }
  );
});

test("corrupted worktrees.json is reported, not silently persisted as empty", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      // Write obviously-invalid JSON to the registry file.
      await fs.writeFile(worktreesFile, "this is not json");
      await seedProjects(projectsFile, [{ id: "proj-a", path: "/tmp/a" }]);
    },
    async ({ worktreesFile }) => {
      const { getProjectWorktrees } = await import("../worktrees.js");
      // The call must not throw. It also must not silently rewrite
      // the registry — the corrupted file should still be on disk
      // afterward so an operator can recover from .bak.
      const list = await getProjectWorktrees("proj-a");
      assert.deepEqual(list, []);

      const content = await fs.readFile(worktreesFile, "utf-8");
      assert.equal(content, "this is not json");
    }
  );
});

test("corrupted worktrees.json is auto-recovered from .bak when the backup is valid", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      // The backup holds the last-known-good registry. The primary
      // is corrupt (as it would be after a crash mid-write).
      const backup = `${worktreesFile}.bak`;
      await fs.writeFile(worktreesFile, "{ broken");
      await fs.writeFile(
        backup,
        JSON.stringify([
          {
            id: "wt-recovered",
            projectId: "proj-a",
            name: "recovered",
            path: "/tmp/recovered",
            isMain: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ])
      );
      await seedProjects(projectsFile, [{ id: "proj-a", path: "/tmp/a" }]);
    },
    async () => {
      const { getProjectWorktrees } = await import("../worktrees.js");
      // The recovered registry should contain the backed-up row plus
      // a freshly-lazied main row.
      const list = await getProjectWorktrees("proj-a");
      const ids = list.map((w) => w.id).sort();
      assert.ok(ids.includes("wt-recovered"));
    }
  );
});

test("removeWorktree retains the targeted record as history and never changes siblings", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      const seeded = [];
      for (let i = 0; i < 5; i += 1) {
        seeded.push({
          id: `wt-${i}`,
          projectId: "proj-a",
          name: `wt-${i}`,
          path: `/tmp/wt-${i}`,
          isMain: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
      await fs.writeFile(worktreesFile, JSON.stringify(seeded));
      await seedProjects(projectsFile, [{ id: "proj-a", path: "/tmp/a" }]);
    },
    async () => {
      const { removeWorktree, getProjectWorktrees } = await import("../worktrees.js");
      const removed = await removeWorktree("wt-2");
      assert.equal(removed, true);
      // The default response hides removed worktrees; the archive
      // view opts in explicitly with `{ includeRemoved: true }` to
      // surface the same data this assertion is checking.
      const remaining = await getProjectWorktrees("proj-a", { includeRemoved: true });
      // The removed row remains addressable for historical sessions.
      const names = remaining.map((w) => w.name).sort();
      assert.deepEqual(names, ["main", "wt-0", "wt-1", "wt-2", "wt-3", "wt-4"]);
      assert.equal(remaining.find((w) => w.id === "wt-2")?.presence, "removed");
      assert.equal(await removeWorktree("wt-2"), false);
    }
  );
});

test("concurrent updateWorktree + removeWorktree calls preserve all untargeted records", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      const seeded = [];
      for (let i = 0; i < 8; i += 1) {
        seeded.push({
          id: `wt-${i}`,
          projectId: "proj-a",
          name: `wt-${i}`,
          path: `/tmp/wt-${i}`,
          isMain: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
      await fs.writeFile(worktreesFile, JSON.stringify(seeded));
      await seedProjects(projectsFile, [{ id: "proj-a", path: "/tmp/a" }]);
    },
    async () => {
      const { updateWorktree, removeWorktree } = await import("../worktrees.js");
      const operations: Array<Promise<unknown>> = [];
      for (let i = 0; i < 4; i += 1) {
        operations.push(updateWorktree(`wt-${i}`, { portOffset: 100 + i }));
      }
      for (let i = 4; i < 6; i += 1) {
        operations.push(removeWorktree(`wt-${i}`));
      }
      await Promise.all(operations);

      const { getProjectWorktrees } = await import("../worktrees.js");
      const list = await getProjectWorktrees("proj-a", { includeRemoved: true });
      const names = list.map((w) => w.name).sort();
      // The four updates and two tombstones must all land.
      assert.deepEqual(names, ["main", "wt-0", "wt-1", "wt-2", "wt-3", "wt-4", "wt-5", "wt-6", "wt-7"]);
      assert.equal(list.find((w) => w.id === "wt-4")?.presence, "removed");
      assert.equal(list.find((w) => w.id === "wt-5")?.presence, "removed");
      for (const worktree of list) {
        if (worktree.name === "wt-0") assert.equal(worktree.portOffset, 100);
        if (worktree.name === "wt-1") assert.equal(worktree.portOffset, 101);
        if (worktree.name === "wt-2") assert.equal(worktree.portOffset, 102);
        if (worktree.name === "wt-3") assert.equal(worktree.portOffset, 103);
      }
    }
  );
});

/*
 * Deterministic reproduction of the catastrophic registry loss from
 * issue #332. The original report described a window where:
 *
 *   - `writeRegistry()` truncated `worktrees.json` with `fs.writeFile`,
 *     then spent several milliseconds writing the new JSON.
 *   - A concurrent reader called `readRegistry()`, observed an empty or
 *     truncated file, and `JSON.parse` threw.
 *   - `readRegistry()` caught the error and returned `[]`.
 *   - The caller (`getProjectWorktrees` → `ensureMainInRegistry`) then
 *     called `writeRegistry([mainRow])`, persisting a main-only
 *     registry as the new contents.
 *
 * We inject the same window by installing a slow `writeFile` via the
 * `_setJsonRegistryFs` seam. With the old code this would reproduce
 * the wipe; with the new code (atomic write + per-file mutex) the
 * reader either sees the pre-write contents or the post-write
 * contents, but never an empty file, and the mutex prevents the
 * reader from writing back a stale snapshot while the slow writer is
 * still mid-flight.
 */
test("a slow write that overlaps a read does not wipe the registry (regression for #332)", async () => {
  await withHome(
    async ({ worktreesFile, projectsFile }) => {
      const seeded = [
        {
          id: "wt-keep-1",
          projectId: "proj-a",
          name: "keep-1",
          path: "/tmp/keep-1",
          isMain: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "wt-keep-2",
          projectId: "proj-a",
          name: "keep-2",
          path: "/tmp/keep-2",
          isMain: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      await fs.writeFile(worktreesFile, JSON.stringify(seeded));
      await seedProjects(projectsFile, [{ id: "proj-a", path: "/tmp/a" }]);
    },
    async ({ worktreesFile }) => {
      const registry = await import("../json-registry.js");
      const realFs = await import("node:fs/promises");

      const isRegistryPath = (target: string): boolean =>
        target === worktreesFile ||
        target.startsWith(worktreesFile + ".tmp-") ||
        target === worktreesFile + ".bak";

      const slowWriteFile: typeof realFs.writeFile = (async (
        target: string | Buffer | URL,
        data: string | Buffer | Uint8Array,
        encoding?: BufferEncoding | null
      ) => {
        const targetStr = typeof target === "string" ? target : String(target);
        if (isRegistryPath(targetStr)) {
          // Defer the write by 50ms so a concurrent reader has a
          // genuine overlap window.
          await new Promise((r) => setTimeout(r, 50));
        }
        // The signatures for writeFile vary — pass through whatever
        // the helper actually called with.
        return realFs.writeFile(
          target as Parameters<typeof realFs.writeFile>[0],
          data as Parameters<typeof realFs.writeFile>[1],
          ...(encoding !== undefined ? [encoding] : []) as unknown as []
        );
      }) as typeof realFs.writeFile;

      const layer = {
        readFile: realFs.readFile,
        open: realFs.open,
        writeFile: slowWriteFile,
        rename: realFs.rename,
        mkdir: realFs.mkdir,
      };
      registry._setJsonRegistryFs(layer);
      try {
        const { addWorktree, getProjectWorktrees } = await import("../worktrees.js");
        // Concurrent reader + writer. Both target the same registry
        // file. With the old (non-atomic, non-locked) implementation
        // this would often reproduce the catastrophic wipe.
        const operations: Array<Promise<unknown>> = [
          getProjectWorktrees("proj-a"),
          addWorktree({
            projectId: "proj-a",
            name: "added-mid-race",
            path: "/tmp/added-mid-race",
            isMain: false,
          }),
          getProjectWorktrees("proj-a"),
        ];
        await Promise.all(operations);
      } finally {
        registry._setJsonRegistryFs(null);
      }

      // Read the registry straight from disk and verify nothing was
      // wiped. Both pre-existing rows must survive, and the new row
      // added by the writer must be present. No main-only persist.
      const raw = await fs.readFile(worktreesFile, "utf-8");
      const persisted = JSON.parse(raw) as Array<{ id: string; name: string; isMain?: boolean }>;
      const names = persisted.map((w) => w.name).sort();
      assert.deepEqual(
        names,
        ["added-mid-race", "keep-1", "keep-2", "main"],
        `registry was wiped — only found ${names.join(", ")}`
      );
    }
  );
});
