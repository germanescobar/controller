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

import { addProject, findProjectByPath, getProject, getProjects, updateProject } from "../projects.js";
import { RegistryParseError } from "../json-registry.js";
import { addWorktree } from "../worktrees.js";
import { worktreePath } from "../paths.js";

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

/*
 * findProjectByPath: the cwd-based project lookup the CLI hits when
 * `<project>` is omitted (or doesn't match by id/name). The lookup
 * considers both `project.path` (the main worktree root) and every
 * registered worktree's on-disk path under
 * `orchestratorHome()/worktrees/<projectId>/<name>`. The latter matters
 * because Controller-created worktrees do not live under `project.path`
 * — see `worktreePath()` in `paths.ts` and the review on PR #298.
 */
test("findProjectByPath resolves a cwd inside a Controller-created worktree", async () => {
  // Regression test for the Codex review on PR #298: a session running
  // in a Controller-created worktree (the exact case the optional
  // `<project>` resolver was built for) was returning null because the
  // lookup only checked `project.path`, but those worktrees live at
  // `orchestratorHome()/worktrees/<projectId>/<name>`. The fix
  // delegates to `findWorktreeByPath` first.
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath);
    const worktreeDir = worktreePath(project.id, "issue-298");
    await fs.mkdir(worktreeDir, { recursive: true });
    await addWorktree({
      projectId: project.id,
      name: "issue-298",
      path: worktreeDir,
      branch: "issue-298",
      isMain: false,
    });

    // A file deep inside the worktree resolves to the project.
    const fromCwd = await findProjectByPath(
      path.join(worktreeDir, "src", "foo.ts")
    );
    assert.ok(fromCwd, "expected to find a project for a cwd inside a registered worktree");
    assert.equal(fromCwd?.id, project.id);
    // And so does the worktree root itself.
    const fromCwdRoot = await findProjectByPath(worktreeDir);
    assert.equal(fromCwdRoot?.id, project.id);
  });
});

test("findProjectByPath matches an exact cwd", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath);
    const fromCwd = await findProjectByPath(projectPath);
    assert.equal(fromCwd?.id, project.id);
  });
});

test("findProjectByPath resolves symlinks and `..` segments before comparing", async () => {
  await withSandbox(async ({ projectPath }) => {
    const project = await addProject("demo", projectPath);
    // `<projectPath>/sub/..` should normalize to `<projectPath>` and match.
    const fromCwd = await findProjectByPath(path.join(projectPath, "sub", ".."));
    assert.equal(fromCwd?.id, project.id);
  });
});

test("findProjectByPath returns null when no project owns the cwd", async () => {
  await withSandbox(async () => {
    // The sandbox is fresh, no projects added. The lookup must not throw.
    const orphan = mkdtempSync(path.join(os.tmpdir(), "controller-orphan-"));
    try {
      const fromCwd = await findProjectByPath(orphan);
      assert.equal(fromCwd, null);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

test("findProjectByPath picks the most specific project (longest-prefix match)", async () => {
  await withSandbox(async () => {
    // Two projects, one nested inside the other. The deeper one should
    // win for paths inside it; the outer one for paths that are inside
    // it but outside the inner one.
    const outer = mkdtempSync(path.join(os.tmpdir(), "controller-outer-"));
    const inner = path.join(outer, "nested-project");
    await fs.mkdir(inner, { recursive: true });
    try {
      const outerProject = await addProject("outer", outer);
      const innerProject = await addProject("inner", inner);

      // Inside the inner project: inner wins (longer prefix).
      const insideInner = await findProjectByPath(path.join(inner, "src", "foo.ts"));
      assert.equal(insideInner?.id, innerProject.id);
      // Inside the outer project but outside the inner: outer wins.
      const insideOuter = await findProjectByPath(outer);
      assert.equal(insideOuter?.id, outerProject.id);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

test("addProject refuses to overwrite a corrupt registry with a single entry", async () => {
  await withSandbox(async ({ home, projectPath }) => {
    // Simulates a crash mid-write that left `projects.json` truncated
    // with no backup to recover from (issue #454).
    const registryFile = path.join(home, "projects.json");
    const truncated = '[{"id":"a","name":"kept","path":"/tmp/kept","createdAt":"2026-01-01"},{"id":';
    await fs.writeFile(registryFile, truncated);

    await assert.rejects(addProject("demo", projectPath), RegistryParseError);
    assert.equal(await fs.readFile(registryFile, "utf-8"), truncated);
  });
});

test("addProject recovers a corrupt registry from its backup", async () => {
  await withSandbox(async ({ home, projectPath }) => {
    const first = await addProject("first", projectPath);
    // The second write mirrors the one-project registry into `.bak`.
    const second = await addProject("second", projectPath);
    const registryFile = path.join(home, "projects.json");
    await fs.writeFile(registryFile, "{ not json");

    const third = await addProject("third", projectPath);

    const ids = JSON.parse(await fs.readFile(registryFile, "utf-8")).map(
      (p: { id: string }) => p.id
    );
    assert.deepEqual(ids, [first.id, third.id]);
    assert.ok(!ids.includes(second.id));
  });
});

test("concurrent addProject calls all persist", async () => {
  await withSandbox(async ({ projectPath }) => {
    const added = await Promise.all(
      Array.from({ length: 10 }, (_, i) => addProject(`p${i}`, projectPath))
    );

    const ids = (await getProjects()).map((p) => p.id).sort();
    assert.deepEqual(ids, added.map((p) => p.id).sort());
  });
});

test("reading strips legacy command keys and the next write persists the stripped shape", async () => {
  await withSandbox(async ({ home, projectPath }) => {
    const registryFile = path.join(home, "projects.json");
    await fs.writeFile(
      registryFile,
      JSON.stringify([
        { id: "a", name: "legacy", path: projectPath, createdAt: "2026-01-01", setupCommands: "npm i" },
      ])
    );

    await updateProject("a", { name: "renamed" });

    const registry = await fs.readFile(registryFile, "utf-8");
    assert.ok(!registry.includes("setupCommands"));
    assert.equal((await getProject("a"))?.name, "renamed");
  });
});
