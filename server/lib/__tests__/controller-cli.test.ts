import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { controllerAgentEnv, controllerCliBinDir, controllerCliInstalledPath } from "../controller-cli.js";
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
