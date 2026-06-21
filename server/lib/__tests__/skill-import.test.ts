import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverImportableSkills,
  importSkills,
  type SkillImportEnv,
} from "../skill-import.js";
import type { Project } from "../projects.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkillFile(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string
): string {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const frontmatterLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const file = path.join(skillDir, "SKILL.md");
  writeFileSync(file, `---\n${frontmatterLines}\n---\n\n${body}\n`, "utf-8");
  return file;
}

function makeEnv(
  home: string,
  projects: Project[] = []
): SkillImportEnv {
  return {
    homedir: () => home,
    codexHome: () => path.join(home, ".codex"),
    getProjects: async () => projects,
  };
}

test("discoverImportableSkills returns nothing when no skills are installed", async () => {
  const home = makeTempDir("import-empty-");
  try {
    const skills = await discoverImportableSkills(makeEnv(home));
    assert.deepEqual(skills, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills finds user skills for all three providers", async () => {
  const home = makeTempDir("import-user-");
  try {
    writeSkillFile(path.join(home, ".anita", "skills"), "anita-only", {
      name: "anita-only",
      description: "Anita user skill",
    }, "anita body");
    writeSkillFile(path.join(home, ".codex", "skills"), "codex-only", {
      name: "codex-only",
      description: "Codex user skill",
    }, "codex body");
    writeSkillFile(path.join(home, ".claude", "skills"), "claude-only", {
      name: "claude-only",
      description: "Claude user skill",
    }, "claude body");

    const skills = await discoverImportableSkills(makeEnv(home));
    assert.equal(skills.length, 3);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    assert.equal(byName["anita-only"].providerId, "anita");
    assert.equal(byName["anita-only"].scope, "user");
    assert.equal(byName["anita-only"].projectPath, null);
    assert.equal(byName["codex-only"].providerId, "codex");
    assert.equal(byName["claude-only"].providerId, "claude");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills surfaces legacy .ada user skills under the anita provider", async () => {
  // After the Ada→Anita rename (issue #151), pre-rename installs may still
  // live under ~/.ada/skills. Discovery should pick them up so the user can
  // promote them to the unified catalog.
  const home = makeTempDir("import-legacy-user-");
  try {
    writeSkillFile(path.join(home, ".ada", "skills"), "legacy", {
      name: "legacy",
      description: "Pre-rename user skill",
    }, "legacy body");

    const skills = await discoverImportableSkills(makeEnv(home));
    assert.equal(skills.length, 1);
    assert.equal(skills[0].providerId, "anita");
    assert.equal(skills[0].scope, "user");
    assert.equal(skills[0].name, "legacy");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills tags codex system skills correctly", async () => {
  const home = makeTempDir("import-codex-system-");
  try {
    writeSkillFile(
      path.join(home, ".codex", "skills", ".system"),
      "bundled",
      { name: "bundled", description: "Codex bundled" },
      "bundled body"
    );

    const skills = await discoverImportableSkills(makeEnv(home));
    assert.equal(skills.length, 1);
    assert.equal(skills[0].scope, "system");
    assert.equal(skills[0].providerId, "codex");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills scans repo skills for every registered project", async () => {
  const home = makeTempDir("import-repo-");
  try {
    const projectA = makeTempDir("project-a-");
    const projectB = makeTempDir("project-b-");
    writeSkillFile(path.join(projectA, ".anita", "skills"), "from-a", {
      name: "from-a",
      description: "repo from A",
    }, "a body");
    writeSkillFile(path.join(projectB, ".claude", "skills"), "from-b", {
      name: "from-b",
      description: "repo from B",
    }, "b body");

    const env = makeEnv(home, [
      { id: "a", name: "A", path: projectA, createdAt: "" },
      { id: "b", name: "B", path: projectB, createdAt: "" },
    ]);
    const skills = await discoverImportableSkills(env);
    assert.equal(skills.length, 2);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    assert.equal(byName["from-a"].scope, "repo");
    assert.equal(byName["from-a"].projectPath, projectA);
    assert.equal(byName["from-b"].scope, "repo");
    assert.equal(byName["from-b"].projectPath, projectB);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills surfaces legacy .ada repo skills under the anita provider", async () => {
  const home = makeTempDir("import-legacy-repo-");
  try {
    const project = makeTempDir("legacy-project-");
    writeSkillFile(path.join(project, ".ada", "skills"), "from-legacy", {
      name: "from-legacy",
      description: "Pre-rename repo skill",
    }, "body");

    const env = makeEnv(home, [
      { id: "p", name: "P", path: project, createdAt: "" },
    ]);
    const skills = await discoverImportableSkills(env);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].providerId, "anita");
    assert.equal(skills[0].scope, "repo");
    assert.equal(skills[0].projectPath, project);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverImportableSkills dedupes by source path", async () => {
  // Same file should never appear twice even if multiple providers scan it.
  const home = makeTempDir("import-dedupe-");
  try {
    writeSkillFile(path.join(home, ".anita", "skills"), "dup", {
      name: "dup",
      description: "d",
    }, "body");
    const skills = await discoverImportableSkills(makeEnv(home));
    assert.equal(skills.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importSkills copies a user skill into the unified catalog", async () => {
  const home = makeTempDir("import-run-");
  const orchestratorHome = makeTempDir("orch-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const sourcePath = writeSkillFile(
      path.join(home, ".anita", "skills"),
      "review",
      { name: "review", description: "Review PRs" },
      "Review carefully"
    );

    const env = makeEnv(home);
    const result = await importSkills(
      {
        selections: [
          { providerId: "anita", sourcePath, scope: "user" },
        ],
      },
      env
    );
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "imported");
    assert.equal(result.results[0].name, "review");
    assert.equal(result.results[0].scope, "user");
    assert.ok(result.results[0].metadata);
    assert.equal(result.results[0].metadata?.path, path.join(orchestratorHome, "skills", "review", "SKILL.md"));

    // And the file should now exist on disk
    const written = path.join(orchestratorHome, "skills", "review", "SKILL.md");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(written, "utf-8");
    assert.match(raw, /name: review/);
    assert.match(raw, /description: Review PRs/);
    assert.match(raw, /Review carefully/);
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills still accepts the legacy `ada` provider id", async () => {
  // Pre-rename callers may still send `ada`. The import endpoint should
  // resolve it the same way the rest of the app does (issue #151).
  const home = makeTempDir("import-legacy-id-");
  const orchestratorHome = makeTempDir("orch-legacy-id-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const sourcePath = writeSkillFile(
      path.join(home, ".ada", "skills"),
      "legacy",
      { name: "legacy", description: "d" },
      "body"
    );

    const result = await importSkills(
      { selections: [{ providerId: "ada", sourcePath, scope: "user" }] },
      makeEnv(home)
    );
    assert.equal(result.results[0].status, "imported");
    assert.equal(result.results[0].name, "legacy");
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills skips a selection whose name collides with a unified skill", async () => {
  const home = makeTempDir("import-skip-");
  const orchestratorHome = makeTempDir("orch-skip-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const sourcePath = writeSkillFile(
      path.join(home, ".anita", "skills"),
      "duplicate",
      { name: "duplicate", description: "d" },
      "body"
    );

    // Pre-create a unified skill with the same name.
    const { createUnifiedSkill } = await import("../unified-skills.js");
    await createUnifiedSkill({
      name: "duplicate",
      description: "pre-existing",
      body: "old body",
    });

    const result = await importSkills(
      { selections: [{ providerId: "anita", sourcePath, scope: "user" }] },
      makeEnv(home)
    );
    assert.equal(result.results[0].status, "skipped");
    assert.match(result.results[0].reason ?? "", /already exists/);

    // The original unified skill must remain untouched.
    const { readUnifiedSkill } = await import("../unified-skills.js");
    const existing = await readUnifiedSkill("duplicate");
    assert.ok(existing);
    assert.equal(existing.body, "old body");
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills overwrites when the caller asks for it", async () => {
  const home = makeTempDir("import-overwrite-");
  const orchestratorHome = makeTempDir("orch-overwrite-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const { createUnifiedSkill } = await import("../unified-skills.js");
    await createUnifiedSkill({
      name: "dup",
      description: "old",
      body: "old body",
    });

    const sourcePath = writeSkillFile(
      path.join(home, ".anita", "skills"),
      "dup",
      { name: "dup", description: "new" },
      "new body"
    );

    const result = await importSkills(
      {
        selections: [
          { providerId: "anita", sourcePath, scope: "user", overwrite: true },
        ],
      },
      makeEnv(home)
    );
    assert.equal(result.results[0].status, "imported");

    const { readUnifiedSkill } = await import("../unified-skills.js");
    const updated = await readUnifiedSkill("dup");
    assert.ok(updated);
    assert.equal(updated.body, "new body");
    assert.equal(updated.metadata.description, "new");
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills returns an error for an unknown provider", async () => {
  const home = makeTempDir("import-bad-provider-");
  const orchestratorHome = makeTempDir("orch-bad-provider-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const result = await importSkills(
      {
        selections: [
          { providerId: "bogus", sourcePath: "/tmp/whatever/SKILL.md", scope: "user" },
        ],
      },
      makeEnv(home)
    );
    assert.equal(result.results[0].status, "error");
    assert.match(result.results[0].reason ?? "", /Unknown agent provider/);
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills returns an error for a missing source file", async () => {
  const home = makeTempDir("import-missing-");
  const orchestratorHome = makeTempDir("orch-missing-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const result = await importSkills(
      {
        selections: [
          { providerId: "anita", sourcePath: path.join(home, "does-not-exist", "SKILL.md"), scope: "user" },
        ],
      },
      makeEnv(home)
    );
    assert.equal(result.results[0].status, "error");
    assert.match(result.results[0].reason ?? "", /not found|unreadable/);
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});

test("importSkills processes multiple selections in one call", async () => {
  const home = makeTempDir("import-multi-");
  const orchestratorHome = makeTempDir("orch-multi-");
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  try {
    const anitaSkill = writeSkillFile(
      path.join(home, ".anita", "skills"),
      "anita-skill",
      { name: "anita-skill", description: "a" },
      "a body"
    );
    const claudeSkill = writeSkillFile(
      path.join(home, ".claude", "skills"),
      "claude-skill",
      { name: "claude-skill", description: "c" },
      "c body"
    );

    const result = await importSkills(
      {
        selections: [
          { providerId: "anita", sourcePath: anitaSkill, scope: "user" },
          { providerId: "claude", sourcePath: claudeSkill, scope: "user" },
        ],
      },
      makeEnv(home)
    );
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      result.results.map((r) => r.status),
      ["imported", "imported"]
    );

    const { listUnifiedSkills } = await import("../unified-skills.js");
    const unified = await listUnifiedSkills();
    assert.equal(unified.length, 2);
  } finally {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  }
});
