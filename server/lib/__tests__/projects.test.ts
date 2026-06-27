/*
 * Tests for `server/lib/projects.ts` — project persistence and the
 * `.controller/{setup,run}.sh` script files it writes (issue #52), including
 * the backward-compatible read/write of legacy `.coding-orchestrator/` repos
 * (issue #248).
 *
 * Strategy: point `CONTROLLER_HOME` at a throwaway temp directory so the
 * projects registry is isolated per run, and give each project its own temp
 * directory so the generated scripts don't collide. Both are removed in a
 * finally block.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { addProject, getProject, updateProject } from "../projects.js";

interface Sandbox {
  home: string;
  projectPath: string;
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const previousHome = process.env.CONTROLLER_HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), "controller-home-"));
  const projectPath = mkdtempSync(path.join(os.tmpdir(), "controller-project-"));
  process.env.CONTROLLER_HOME = home;
  try {
    await run({ home, projectPath });
  } finally {
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
}

/* Path to a native script. Defaults to the current `.controller/` directory;
 * pass `.coding-orchestrator` to address the legacy directory in the
 * backward-compatibility tests. */
function scriptPath(
  projectPath: string,
  fileName: string,
  dir: ".controller" | ".coding-orchestrator" = ".controller"
): string {
  return path.join(projectPath, dir, fileName);
}

test("addProject writes run.sh when run commands are provided", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath, "npm install", "npm run dev");

    assert.equal(project.runCommands, "npm run dev");
    const content = await fs.readFile(scriptPath(projectPath, "run.sh"), "utf-8");
    assert.match(content, /npm run dev/);
    assert.ok(existsSync(scriptPath(projectPath, "setup.sh")));
  });
});

test("addProject omits run.sh when no run commands are provided", async () => {
  await withSandbox(async ({ projectPath }) => {
    await addProject("demo", projectPath, "npm install");

    assert.ok(!existsSync(scriptPath(projectPath, "run.sh")));
    assert.ok(existsSync(scriptPath(projectPath, "setup.sh")));
  });
});

test("addProject preserves pre-existing scripts when fields are blank", async () => {
  await withSandbox(async ({ projectPath }) => {
    // Onboarding a repo that already ships Controller scripts.
    await fs.mkdir(path.dirname(scriptPath(projectPath, "setup.sh")), { recursive: true });
    const existing = "#!/bin/bash\nset -e\n\npnpm install\n";
    await fs.writeFile(scriptPath(projectPath, "setup.sh"), existing);
    await fs.writeFile(scriptPath(projectPath, "run.sh"), existing);

    await addProject("demo", projectPath);

    assert.equal(await fs.readFile(scriptPath(projectPath, "setup.sh"), "utf-8"), existing);
    assert.equal(await fs.readFile(scriptPath(projectPath, "run.sh"), "utf-8"), existing);
  });
});

test("addProject writes new scripts to .controller, leaving .coding-orchestrator untouched", async () => {
  await withSandbox(async ({ projectPath }) => {
    await addProject("demo", projectPath, "npm install", "npm run dev");

    assert.ok(existsSync(scriptPath(projectPath, "setup.sh", ".controller")));
    assert.ok(existsSync(scriptPath(projectPath, "run.sh", ".controller")));
    assert.ok(!existsSync(path.join(projectPath, ".coding-orchestrator")));
  });
});

test("updateProject writes back to a legacy .coding-orchestrator repo, not .controller", async () => {
  await withSandbox(async ({ projectPath }) => {
    // Repo onboarded before the rename: scripts live under the legacy dir.
    await fs.mkdir(path.join(projectPath, ".coding-orchestrator"), { recursive: true });
    await fs.writeFile(
      scriptPath(projectPath, "setup.sh", ".coding-orchestrator"),
      "#!/bin/bash\nset -e\n\nnpm install\n"
    );
    const project = await addProject("demo", projectPath);

    await updateProject(project.id, { runCommands: "npm run dev" });

    assert.match(
      await fs.readFile(scriptPath(projectPath, "run.sh", ".coding-orchestrator"), "utf-8"),
      /npm run dev/
    );
    assert.ok(!existsSync(path.join(projectPath, ".controller")));
  });
});

test("updateProject adds, updates, and clears run.sh", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath, "npm install");

    await updateProject(project.id, { runCommands: "npm run dev" });
    assert.match(await fs.readFile(scriptPath(projectPath, "run.sh"), "utf-8"), /npm run dev/);

    await updateProject(project.id, { runCommands: "npm start" });
    assert.match(await fs.readFile(scriptPath(projectPath, "run.sh"), "utf-8"), /npm start/);

    await updateProject(project.id, { runCommands: "" });
    assert.ok(!existsSync(scriptPath(projectPath, "run.sh")));
  });
});

test("updateProject leaves run.sh untouched when runCommands is absent", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath, "npm install", "npm run dev");

    await updateProject(project.id, { name: "renamed" });

    assert.ok(existsSync(scriptPath(projectPath, "run.sh")));
  });
});

test("getProject hydrates commands from script files even when the registry lacks them", async () => {
  await withSandbox(async ({ home, projectPath }) => {
    // Simulate a legacy/external setup: scripts exist on disk but the
    // registry record carries no command strings (the original bug).
    const project = await addProject("demo", projectPath);
    await fs.mkdir(path.dirname(scriptPath(projectPath, "setup.sh")), { recursive: true });
    await fs.writeFile(
      scriptPath(projectPath, "setup.sh"),
      "#!/bin/bash\nset -e\n\npnpm install\n"
    );
    await fs.writeFile(
      scriptPath(projectPath, "run.sh"),
      "#!/bin/bash\nset -e\n\nexport PORT=3000\npnpm dev\n"
    );

    const registry = await fs.readFile(path.join(home, "projects.json"), "utf-8");
    assert.ok(!registry.includes("setupCommands"));

    const hydrated = await getProject(project.id);
    assert.equal(hydrated?.setupCommands, "pnpm install");
    assert.equal(hydrated?.runCommands, "export PORT=3000\npnpm dev");
  });
});

test("editing a hydrated script round-trips without mangling the body", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath);
    const original = "#!/bin/bash\nset -e\n\nexport PORT=3000\nnpm run dev\n";
    await fs.mkdir(path.dirname(scriptPath(projectPath, "run.sh")), { recursive: true });
    await fs.writeFile(scriptPath(projectPath, "run.sh"), original);

    const hydrated = await getProject(project.id);
    // Save the hydrated body back unchanged, as the edit form would.
    await updateProject(project.id, { runCommands: hydrated?.runCommands });

    assert.equal(await fs.readFile(scriptPath(projectPath, "run.sh"), "utf-8"), original);
  });
});
