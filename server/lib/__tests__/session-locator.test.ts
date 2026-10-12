import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the shared session locator (issue #339 review).
 *
 * The original wake / goal / monitor ID-only handlers and the wakes
 * consumer each rolled their own "find which project owns a session"
 * walk, and every one of them stopped at `project.path` — the main
 * worktree — so sessions in non-main worktrees were silently dropped.
 *
 * These tests plant a session in a non-main worktree and assert the
 * shared locator resolves it through the worktree registry.
 */

import { locateSessionById, locateSessionPath } from "../session-locator.js";
import { projectStoreDir } from "../paths.js";
import { getProjectWorktrees, invalidateWorktreeCache } from "../worktrees.js";
import { _setJsonRegistryFs } from "../json-registry.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-locator-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    invalidateWorktreeCache();
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function plantProject(
  home: string,
  projectId: string,
  projectName: string,
  projectPath: string
): Promise<void> {
  await writeFileProjectRegistry(home, [
    {
      id: projectId,
      name: projectName,
      path: projectPath,
      createdAt: new Date().toISOString(),
    },
  ]);
}

async function writeFileProjectRegistry(
  home: string,
  projects: Array<{ id: string; name: string; path: string; createdAt: string }>
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path.join(home, "projects.json"),
    JSON.stringify(projects)
  );
}

test("locateSessionById returns null when no project is registered", async () => {
  await withTempHome(async () => {
    assert.equal(await locateSessionById("missing"), null);
  });
});

test("locator reuses the registry snapshot and sees a rewritten registry", async () => {
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    await plantProject(home, "proj-1", "demo", mainPath);
    mkdirSync(path.join(projectStoreDir(featurePath), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(featurePath), "sessions", "s1.json"),
      JSON.stringify({ id: "s1", worktreeId: "feature" })
    );
    const registryFile = path.join(home, "worktrees.json");
    const main = {
      id: "main", projectId: "proj-1", name: "main", path: mainPath,
      isMain: true, createdAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(registryFile, JSON.stringify([main]));
    let registryReads = 0;
    const previous = _setJsonRegistryFs({
      readFile: async (file, encoding) => {
        if (file === registryFile) registryReads++;
        return fs.readFile(file, encoding);
      },
      open: fs.open,
      writeFile: fs.writeFile,
      rename: fs.rename,
      mkdir: fs.mkdir,
    });
    try {
      assert.equal(await locateSessionById("s1"), null);
      assert.equal(await locateSessionById("s1"), null);
      assert.equal(registryReads, 1, "same registry version should be parsed once");
      invalidateWorktreeCache();
      assert.equal(await locateSessionById("s1"), null);
      assert.equal(registryReads, 2, "explicit invalidation forces a fresh parse");

      writeFileSync(registryFile, JSON.stringify([main, {
        id: "feature", projectId: "proj-1", name: "feature", path: featurePath,
        isMain: false, createdAt: "2026-01-01T00:00:00.000Z",
      }]));
      assert.equal((await locateSessionById("s1"))?.worktreePath, featurePath);
      assert.equal(registryReads, 3, "a registry rewrite must invalidate the cache");
    } finally {
      _setJsonRegistryFs(previous);
    }
  });
});

test("locator scans more than 64 projects without reparsing the shared registry", async () => {
  await withTempHome(async (home) => {
    const projects = Array.from({ length: 65 }, (_, i) => ({
      id: `proj-${i}`, name: `project ${i}`, path: path.join(home, `project-${i}`),
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await writeFileProjectRegistry(home, projects);
    const registryFile = path.join(home, "worktrees.json");
    writeFileSync(registryFile, JSON.stringify(projects.map((project) => ({
      id: project.id, projectId: project.id, name: "main", path: project.path,
      isMain: true, createdAt: project.createdAt,
    }))));
    let registryReads = 0;
    const previous = _setJsonRegistryFs({
      readFile: async (file, encoding) => {
        if (file === registryFile) registryReads++;
        return fs.readFile(file, encoding);
      },
      open: fs.open,
      writeFile: fs.writeFile,
      rename: fs.rename,
      mkdir: fs.mkdir,
    });
    try {
      assert.equal(await locateSessionById("missing"), null);
      assert.equal(await locateSessionById("missing"), null);
      assert.equal(registryReads, 1, "both scans share one parsed registry");
    } finally {
      _setJsonRegistryFs(previous);
    }
  });
});

test("worktree cache evicts old registry snapshots after 64 files", async () => {
  await withTempHome(async (home) => {
    const homes = Array.from({ length: 65 }, (_, i) => path.join(home, `home-${i}`));
    for (const fixtureHome of homes) {
      mkdirSync(fixtureHome, { recursive: true });
      const projectPath = path.join(fixtureHome, "project");
      await plantProject(fixtureHome, "proj", "demo", projectPath);
      writeFileSync(path.join(fixtureHome, "worktrees.json"), JSON.stringify([{
        id: "main", projectId: "proj", name: "main", path: projectPath,
        isMain: true, createdAt: "2026-01-01T00:00:00.000Z",
      }]));
    }
    let registryReads = 0;
    const previous = _setJsonRegistryFs({
      readFile: async (file, encoding) => {
        if (file.endsWith("/worktrees.json")) registryReads++;
        return fs.readFile(file, encoding);
      },
      open: fs.open,
      writeFile: fs.writeFile,
      rename: fs.rename,
      mkdir: fs.mkdir,
    });
    try {
      for (const fixtureHome of homes) {
        process.env.CONTROLLER_HOME = fixtureHome;
        await getProjectWorktrees("proj");
      }
      assert.equal(registryReads, 65);
      process.env.CONTROLLER_HOME = homes[64];
      await getProjectWorktrees("proj");
      assert.equal(registryReads, 65, "most recent snapshot stays cached");
      process.env.CONTROLLER_HOME = homes[0];
      await getProjectWorktrees("proj");
      assert.equal(registryReads, 66, "oldest snapshot was evicted");
    } finally {
      _setJsonRegistryFs(previous);
    }
  });
});

test("locateSessionById finds a session in the main worktree", async () => {
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(mainPath), "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: mainPath })
    );
    await plantProject(home, "proj-1", "demo", mainPath);
    const located = await locateSessionById("s1");
    assert.ok(located);
    assert.equal(located?.projectId, "proj-1");
    assert.equal(located?.worktreePath, mainPath);
  });
});

test("locateSessionById finds a session in a non-main worktree", async () => {
  // The original handlers stopped at `project.path` (main worktree),
  // so a session in a feature branch's worktree was silently dropped.
  // The shared locator enumerates `getProjectWorktrees` to fix this.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    mkdirSync(path.join(projectStoreDir(featurePath), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(featurePath), "sessions", "s1.json"),
      JSON.stringify({
        id: "s1",
        workingDirectory: featurePath,
        worktreeId: "wt-feature",
      })
    );
    await plantProject(home, "proj-1", "demo", mainPath);
    // Plant the worktree registry so `getProjectWorktrees` returns
    // the feature worktree.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(home, "worktrees.json"),
      JSON.stringify([
        {
          id: "wt-feature",
          projectId: "proj-1",
          name: "feature",
          path: featurePath,
          branch: "feature",
          isMain: false,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    const located = await locateSessionById("s1");
    assert.ok(located, "locator must walk non-main worktrees");
    assert.equal(located?.projectId, "proj-1");
    assert.equal(located?.worktreePath, featurePath);
    assert.equal(located?.worktreeId, "wt-feature");
  });
});

test("locateSessionPath returns the same project/worktree tuple as locateSessionById", async () => {
  // The wakes consumer uses the cheap path-only variant to avoid
  // re-reading the full session state on every tick. The two
  // locators must agree on the resolved (projectId, worktreePath)
  // tuple.
  await withTempHome(async (home) => {
    const proj = path.join(home, "p");
    mkdirSync(path.join(projectStoreDir(proj), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(proj), "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: proj })
    );
    await plantProject(home, "proj-1", "demo", proj);
    const full = await locateSessionById("s1");
    const cheap = await locateSessionPath("s1");
    assert.ok(full);
    assert.ok(cheap);
    assert.equal(cheap?.projectId, full?.projectId);
    assert.equal(cheap?.worktreePath, full?.worktreePath);
    assert.equal(cheap?.worktreeId, full?.worktreeId);
  });
});

test("locateSessionPath returns null when the session is unknown", async () => {
  await withTempHome(async () => {
    assert.equal(await locateSessionPath("missing"), null);
  });
});
