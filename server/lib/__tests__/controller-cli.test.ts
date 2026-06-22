import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { symlinkSync, writeFileSync } from "node:fs";
import {
  controllerAgentEnv,
  controllerCliBinDir,
  controllerCliInstalledPath,
  removeLegacyControllerSymlinks,
} from "../controller-cli.js";
import { orchestratorHome } from "../paths.js";

/**
 * Issue #187: the `controller` CLI must be resolvable from agent shell
 * sessions even when the user has not manually symlinked it onto PATH. The
 * server installs the CLI into `<orchestratorHome>/bin/` on startup and
 * `controllerAgentEnv` is the seam that surfaces that bin dir to the spawned
 * agent process.
 */

test("controllerCliBinDir is the directory containing the installed CLI", () => {
  assert.equal(
    controllerCliBinDir(),
    path.dirname(controllerCliInstalledPath())
  );
  assert.equal(
    controllerCliBinDir(),
    path.join(orchestratorHome(), "bin")
  );
});

test("controllerAgentEnv exposes CONTROLLER_SERVER_URL", () => {
  const env = controllerAgentEnv();
  assert.ok(env.CONTROLLER_SERVER_URL, "CONTROLLER_SERVER_URL must be set");
  assert.match(env.CONTROLLER_SERVER_URL, /^http:\/\/localhost:\d+$/);
});

test("controllerAgentEnv prepends the CLI bin dir to PATH", () => {
  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const env = controllerAgentEnv();
    const entries = env.PATH.split(":");
    assert.ok(
      entries.includes(controllerCliBinDir()),
      `PATH should include ${controllerCliBinDir()}, got ${env.PATH}`
    );
    // Existing entries must be preserved — the merge is purely additive so
    // the agent's shell can still find bash, git, node, etc.
    assert.ok(entries.includes("/usr/bin"));
    assert.ok(entries.includes("/bin"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("controllerAgentEnv dedupes the bin dir when already on PATH", () => {
  const savedPath = process.env.PATH;
  process.env.PATH = `/usr/bin:${controllerCliBinDir()}:/bin`;
  try {
    const env = controllerAgentEnv();
    const matches = env.PATH
      .split(":")
      .filter((entry) => entry === controllerCliBinDir());
    assert.equal(
      matches.length,
      1,
      `bin dir should appear exactly once, got ${env.PATH}`
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("controllerAgentEnv handles an empty inherited PATH", () => {
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const env = controllerAgentEnv();
    // Even with no inherited PATH the agent shell can still find `controller`.
    assert.equal(env.PATH, controllerCliBinDir());
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

/**
 * The cleanup targets `os.homedir() + "/.local/bin"`. To avoid touching the
 * real user home (which, for the bug reporter, actually contains the
 * workaround we're trying to remove), every cleanup test pins HOME to a
 * fresh temp dir and cleans it up afterwards.
 */
async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-cli-cleanup-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("removeLegacyControllerSymlinks removes the documented workaround", async () => {
  await withTempHome(async () => {
    const legacyDir = path.join(os.homedir(), ".local", "bin");
    await fs.mkdir(legacyDir, { recursive: true });

    // The workaround from the issue: a symlink in ~/.local/bin/controller
    // pointing at the bundled CLI. We point at the bundled source dir
    // (rather than the orchestrator-home install path) because the test runs
    // before `installControllerCli()` and we only need `realpath` to land
    // inside `cliSourceDir()` for the cleanup to recognize it.
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    // __tests__/ → lib/ → server/ → repo root, then into cli/.
    const bundledSource = path.join(testDir, "..", "..", "..", "cli", "controller");
    assert.ok(
      await fileExists(bundledSource),
      `bundled CLI source expected at ${bundledSource}`
    );
    const linkPath = path.join(legacyDir, "controller");
    symlinkSync(bundledSource, linkPath);

    // Sanity: the symlink is there before we run cleanup.
    assert.ok(await fileExists(linkPath));

    await removeLegacyControllerSymlinks();

    assert.equal(
      await fileExists(linkPath),
      false,
      "the legacy workaround symlink should have been removed"
    );
  });
});

test("removeLegacyControllerSymlinks leaves a user-authored controller alone", async () => {
  await withTempHome(async () => {
    const legacyDir = path.join(os.homedir(), ".local", "bin");
    await fs.mkdir(legacyDir, { recursive: true });

    // A real (non-symlink) file the user wrote themselves. realpath returns
    // the file itself, which is not inside Controller's CLI source dir, so
    // the cleanup must leave it alone.
    const userBinary = path.join(legacyDir, "controller");
    writeFileSync(userBinary, "#!/bin/sh\necho user controller\n");
    await fs.chmod(userBinary, 0o755);

    await removeLegacyControllerSymlinks();

    assert.equal(
      await fileExists(userBinary),
      true,
      "a user-authored controller binary must not be removed"
    );
  });
});

test("removeLegacyControllerSymlinks leaves an unrelated symlink alone", async () => {
  await withTempHome(async () => {
    const legacyDir = path.join(os.homedir(), ".local", "bin");
    await fs.mkdir(legacyDir, { recursive: true });

    // A symlink that resolves somewhere Controller does not own. The cleanup
    // must not touch it.
    const linkPath = path.join(legacyDir, "controller");
    // `/usr/bin/env` is universal on macOS/Linux dev machines and is a
    // symlink (resolves to /usr/bin/...). It is definitely not inside our
    // CLI source dir.
    symlinkSync("/usr/bin/env", linkPath);

    await removeLegacyControllerSymlinks();

    assert.equal(
      await fileExists(linkPath),
      true,
      "a symlink that does not point at our CLI must be left alone"
    );
  });
});

test("removeLegacyControllerSymlinks is a no-op when the legacy dir is absent", async () => {
  await withTempHome(async () => {
    // No ~/.local/bin created — the cleanup must not throw.
    await removeLegacyControllerSymlinks();
  });
});

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
