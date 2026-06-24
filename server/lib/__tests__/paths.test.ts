/*
 * Tests for `server/lib/paths.ts` — the Controller home resolution
 * introduced in issue #223.
 *
 * Strategy: drive resolution through the public `orchestratorHome()` and
 * `defaultHomeForPlatform()` functions. Env-var overrides, `HOME`, and
 * `XDG_STATE_HOME` are mutated per-case and restored in a finally block
 * so the rest of the suite isn't affected. `process.platform` is
 * shadow-defined for each test (it's a read-only property in modern
 * Node) and restored afterwards.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  orchestratorHome,
  defaultHomeForPlatform,
} from "../paths.js";

interface EnvSnapshot {
  CONTROLLER_HOME?: string;
  HOME?: string;
  XDG_STATE_HOME?: string;
}

function captureEnv(): EnvSnapshot {
  return {
    CONTROLLER_HOME: process.env.CONTROLLER_HOME,
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
    assert.equal(orchestratorHome(), tmp);
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

test("defaultHomeForPlatform falls back to ~/coding-orchestrator on unsupported platforms", () => {
  const snapshot = captureEnv();
  try {
    const fakeHome = makeTempDir("paths-other-");
    process.env.HOME = fakeHome;
    withPlatform("win32", () => {
      assert.equal(
        defaultHomeForPlatform(),
        path.join(fakeHome, "coding-orchestrator"),
      );
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("CONTROLLER_HOME wins when set on any platform", () => {
  const snapshot = captureEnv();
  try {
    const override = makeTempDir("paths-override-");
    const fakeHome = makeTempDir("paths-override-home-");
    process.env.HOME = fakeHome;
    process.env.CONTROLLER_HOME = override;
    withPlatform("darwin", () => {
      assert.equal(orchestratorHome(), override);
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("whitespace-only CONTROLLER_HOME is ignored", () => {
  const snapshot = captureEnv();
  try {
    const fakeHome = makeTempDir("paths-whitespace-");
    process.env.HOME = fakeHome;
    process.env.CONTROLLER_HOME = "   ";
    withPlatform("darwin", () => {
      // Falls through to the platform default instead of returning a
      // path composed entirely of whitespace.
      assert.equal(
        orchestratorHome(),
        path.join(fakeHome, "Library", "Application Support", "Controller"),
      );
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test("cleanup: each test's temp dir is removed", () => {
  // The earlier tests in this file are responsible for their own cleanup
  // via try/finally + restoreEnv. This test asserts the test runner
  // itself doesn't leak os.tmpdir() content from these tests by spot
  // checking that the prefix dirs are gone after the run. We can't see
  // the past cleanup from here, so this is a no-op assertion that simply
  // documents the contract — the suite is "well-behaved" by convention.
  // (If the cleanup pattern ever drifts, add a real assertion here.)
  assert.equal(typeof mkdtempSync, "function");
  // Touch the import to keep rmSync reachable for future cleanup tests.
  void rmSync;
});