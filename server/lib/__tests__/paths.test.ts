/*
 * Tests for `server/lib/paths.ts` — the Controller home resolution and
 * the one-shot legacy-home migration introduced in issue #223.
 *
 * Strategy: every case drives the resolution through the public
 * `orchestratorHome()` and `migrateLegacyHomeIfNeeded()` functions.
 * Env-var overrides and `HOME` are mutated per-case and restored
 * in a finally block so the rest of the suite isn't affected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  orchestratorHome,
  defaultHomeForPlatform,
  legacyOrchestratorHome,
  migrateLegacyHomeIfNeeded,
} from "../paths.js";

interface EnvSnapshot {
  CONTROLLER_HOME?: string;
  CODING_ORCHESTRATOR_HOME?: string;
  HOME?: string;
  XDG_STATE_HOME?: string;
}

function captureEnv(): EnvSnapshot {
  return {
    CONTROLLER_HOME: process.env.CONTROLLER_HOME,
    CODING_ORCHESTRATOR_HOME: process.env.CODING_ORCHESTRATOR_HOME,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * `process.platform` is a read-only property in modern Node. To exercise
 * the platform-specific branches in `defaultHomeForPlatform` we shadow
 * `process.platform` via `Object.defineProperty` for the duration of `run`
 * and restore the real value afterwards. Each test case uses a fresh
 * property descriptor, so concurrent invocations are safe.
 */
function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const previous = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", {
      value: previous,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("orchestratorHome honors CONTROLLER_HOME over the platform default", () => {
  const snapshot = captureEnv();
  try {
    const tmp = makeTempDir("paths-controllervar-");
    process.env.CONTROLLER_HOME = tmp;
    delete process.env.CODING_ORCHESTRATOR_HOME;
    assert.equal(orchestratorHome(), tmp);
  } finally {
    restoreEnv(snapshot);
  }
});

test("orchestratorHome falls back to CODING_ORCHESTRATOR_HOME (deprecated alias)", () => {
  const snapshot = captureEnv();
  try {
    const tmp = makeTempDir("paths-deprecatedvar-");
    delete process.env.CONTROLLER_HOME;
    process.env.CODING_ORCHESTRATOR_HOME = tmp;
    assert.equal(orchestratorHome(), tmp);
  } finally {
    restoreEnv(snapshot);
  }
});

test("orchestratorHome prefers CONTROLLER_HOME over the deprecated alias", () => {
  const snapshot = captureEnv();
  try {
    const canonical = makeTempDir("paths-canonical-");
    const alias = makeTempDir("paths-alias-");
    process.env.CONTROLLER_HOME = canonical;
    process.env.CODING_ORCHESTRATOR_HOME = alias;
    assert.equal(orchestratorHome(), canonical);
  } finally {
    restoreEnv(snapshot);
  }
});

test("defaultHomeForPlatform picks Application Support on darwin", () => {
  const snapshot = captureEnv();
  try {
    const fakeHome = makeTempDir("paths-darwin-");
    process.env.HOME = fakeHome;
    withPlatform("darwin", () => {
      assert.equal(
        defaultHomeForPlatform(),
        path.join(fakeHome, "Library", "Application Support", "Controller"),
      );
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("defaultHomeForPlatform honors XDG_STATE_HOME on linux", () => {
  const snapshot = captureEnv();
  try {
    const xdg = makeTempDir("paths-xdg-");
    const fakeHome = makeTempDir("paths-linuxhome-");
    process.env.XDG_STATE_HOME = xdg;
    process.env.HOME = fakeHome;
    withPlatform("linux", () => {
      assert.equal(defaultHomeForPlatform(), path.join(xdg, "Controller"));
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("defaultHomeForPlatform falls back to ~/.local/state on linux without XDG_STATE_HOME", () => {
  const snapshot = captureEnv();
  try {
    const fakeHome = makeTempDir("paths-linuxnoxdg-");
    process.env.HOME = fakeHome;
    delete process.env.XDG_STATE_HOME;
    withPlatform("linux", () => {
      assert.equal(
        defaultHomeForPlatform(),
        path.join(fakeHome, ".local", "state", "Controller"),
      );
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("legacyOrchestratorHome is the pre-#223 top-level dot-less directory", () => {
  const snapshot = captureEnv();
  try {
    const fakeHome = makeTempDir("paths-legacy-");
    process.env.HOME = fakeHome;
    assert.equal(legacyOrchestratorHome(), path.join(fakeHome, "coding-orchestrator"));
  } finally {
    restoreEnv(snapshot);
  }
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

/**
 * Drive `migrateLegacyHomeIfNeeded` against a fresh fake `$HOME` so the
 * test never touches the developer's real `~/coding-orchestrator` or
 * `~/Library/Application Support`. The fake home is created via a temp
 * dir; we mutate `HOME` (and any other env vars) for the duration of the
 * case and restore in a finally block.
 */
async function withFakeHome(
  platform: NodeJS.Platform,
  run: (home: string) => Promise<void>
): Promise<void> {
  const snapshot = captureEnv();
  const fakeHome = makeTempDir(`paths-migrate-${platform}-`);
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.CONTROLLER_HOME;
  delete process.env.CODING_ORCHESTRATOR_HOME;

  // `process.platform` is read-only; `withPlatform` shadow-defines it
  // for the duration of the run. The async body stays inside the
  // shadow, so every `defaultHomeForPlatform()` / `migrateLegacyHomeIfNeeded()`
  // call in the test sees the fake platform value.
  const previous = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  try {
    await run(fakeHome);
  } finally {
    Object.defineProperty(process, "platform", {
      value: previous,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    restoreEnv(snapshot);
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

test("migration is a no-op when the legacy home does not exist", async () => {
  await withFakeHome("darwin", async (home) => {
    // No legacy dir under fakeHome/coding-orchestrator.
    const result = await migrateLegacyHomeIfNeeded();
    assert.equal(result.migrated, false);
    assert.equal(result.skippedReason, "no-legacy");
    const target = path.join(home, "Library", "Application Support", "Controller");
    assert.equal(existsSync(target), false);
  });
});

test("migration moves legacy state into the platform default and writes a marker", async () => {
  await withFakeHome("darwin", async (home) => {
    const legacy = path.join(home, "coding-orchestrator");
    mkdirSync(path.join(legacy, "skills", "demo"), { recursive: true });
    writeFileSync(
      path.join(legacy, "projects.json"),
      JSON.stringify([{ id: "p1", name: "demo" }]),
      "utf-8",
    );
    writeFileSync(path.join(legacy, "skills", "demo", "SKILL.md"), "demo body", "utf-8");

    const result = await migrateLegacyHomeIfNeeded();
    assert.equal(result.migrated, true);
    assert.equal(result.from, legacy);
    const target = path.join(home, "Library", "Application Support", "Controller");
    assert.equal(result.to, target);
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(target), true);
    const movedProjects = JSON.parse(
      readFileSync(path.join(target, "projects.json"), "utf-8"),
    );
    assert.equal(movedProjects[0].id, "p1");
    assert.equal(
      readFileSync(path.join(target, "skills", "demo", "SKILL.md"), "utf-8"),
      "demo body",
    );
    const marker = JSON.parse(
      readFileSync(path.join(target, "migrated-from-legacy-home.json"), "utf-8"),
    );
    assert.equal(marker.migratedFrom, legacy);
    assert.ok(marker.migratedAt);
  });
});

test("migration on linux uses XDG_STATE_HOME when set", async () => {
  await withFakeHome("linux", async (home) => {
    const xdg = makeTempDir("paths-migrate-xdg-");
    const previousXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = xdg;
    try {
      const legacy = path.join(home, "coding-orchestrator");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(path.join(legacy, "projects.json"), "[]", "utf-8");

      const result = await migrateLegacyHomeIfNeeded();
      assert.equal(result.migrated, true);
      assert.equal(result.to, path.join(xdg, "Controller"));
      assert.equal(existsSync(legacy), false);
      assert.equal(existsSync(path.join(xdg, "Controller", "projects.json")), true);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdg;
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});

test("migration is idempotent — second run no-ops via the marker", async () => {
  await withFakeHome("darwin", async () => {
    const legacy = path.join(os.homedir(), "coding-orchestrator");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "projects.json"), "[]", "utf-8");

    const first = await migrateLegacyHomeIfNeeded();
    assert.equal(first.migrated, true);

    // Re-create the legacy directory to make sure the second run doesn't
    // re-migrate stale state — the marker in the new home should win.
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "projects.json"), "[stale]", "utf-8");

    const second = await migrateLegacyHomeIfNeeded();
    assert.equal(second.migrated, false);
    assert.equal(second.skippedReason, "marker-exists");

    // The new home still holds the original migrated content.
    const target = path.join(os.homedir(), "Library", "Application Support", "Controller");
    assert.equal(
      readFileSync(path.join(target, "projects.json"), "utf-8"),
      "[]",
    );
    // The stale legacy directory the test re-created is left as-is — the
    // migration only runs once; users who recreate the legacy dir by
    // hand are on their own.
  });
});

test("migration is skipped when CONTROLLER_HOME is set", async () => {
  const snapshot = captureEnv();
  try {
    const override = makeTempDir("paths-migrate-override-");
    const fakeHome = makeTempDir("paths-migrate-skiphome-");
    process.env.HOME = fakeHome;
    process.env.CONTROLLER_HOME = override;
    delete process.env.CODING_ORCHESTRATOR_HOME;
    // Plant a legacy directory; without the env-var override this would
    // trigger the migration.
    mkdirSync(path.join(fakeHome, "coding-orchestrator"), { recursive: true });
    writeFileSync(path.join(fakeHome, "coding-orchestrator", "projects.json"), "[]", "utf-8");

    const result = await migrateLegacyHomeIfNeeded();
    assert.equal(result.migrated, false);
    assert.equal(result.skippedReason, "env-override-set");
    // Legacy was not touched and override home was not populated.
    assert.equal(existsSync(path.join(fakeHome, "coding-orchestrator", "projects.json")), true);
    assert.equal(existsSync(path.join(override, "projects.json")), false);
  } finally {
    restoreEnv(snapshot);
  }
});

test("migration on linux falls back to ~/.local/state without XDG_STATE_HOME", async () => {
  await withFakeHome("linux", async (home) => {
    const previousXdg = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      const legacy = path.join(home, "coding-orchestrator");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(path.join(legacy, "projects.json"), "[]", "utf-8");

      const result = await migrateLegacyHomeIfNeeded();
      assert.equal(result.migrated, true);
      assert.equal(result.to, path.join(home, ".local", "state", "Controller"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdg;
    }
  });
});

test("migration handles symlinks inside the legacy home", async () => {
  await withFakeHome("darwin", async () => {
    const legacy = path.join(os.homedir(), "coding-orchestrator");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "projects.json"), "[]", "utf-8");
    // A symlink that resolves into a sibling of the legacy dir; the
    // recursive copy path (cross-volume fallback) handles it via
    // `fs.copyFile`, which follows the link.
    const external = path.join(os.homedir(), "external-skill");
    mkdirSync(external, { recursive: true });
    writeFileSync(path.join(external, "SKILL.md"), "external body", "utf-8");
    try {
      symlinkSync(external, path.join(legacy, "skill-link"), "dir");
      const result = await migrateLegacyHomeIfNeeded();
      assert.equal(result.migrated, true);
      const target = path.join(os.homedir(), "Library", "Application Support", "Controller");
      assert.equal(
        readFileSync(path.join(target, "skill-link", "SKILL.md"), "utf-8"),
        "external body",
      );
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});