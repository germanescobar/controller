import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import {
  createUnifiedSkill,
  deleteUnifiedSkill,
  listUnifiedSkills,
  readUnifiedSkill,
  updateUnifiedSkill,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_TREE_MAX_BYTES,
  recoverStagedSkillBackups,
} from "../unified-skills.js";
import { unifiedSkillFile, unifiedSkillsDir } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "unified-skills-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("listUnifiedSkills is empty by default", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await listUnifiedSkills(), []);
  });
});

test("listUnifiedSkills ignores dot-prefixed directories", async () => {
  await withTempHome(async () => {
    const hidden = path.join(path.dirname(unifiedSkillFile("visible")), ".skill-import-leftover");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(path.join(hidden, "SKILL.md"), "---\nname: hidden\ndescription: staged\n---\n");
    assert.deepEqual(await listUnifiedSkills(), []);
  });
});

test("createUnifiedSkill writes SKILL.md and returns metadata", async () => {
  await withTempHome(async () => {
    const result = await createUnifiedSkill({
      name: "github-issues",
      description: "Work on GitHub issues",
      body: "# Instructions\nBe concise.",
    });
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(result.name, "github-issues");
    assert.equal(result.scope, "unified");

    const raw = readFileSync(unifiedSkillFile("github-issues"), "utf-8");
    assert.match(raw, /name: github-issues/);
    assert.match(raw, /description: Work on GitHub issues/);
    assert.match(raw, /# Instructions/);
  });
});

test("createUnifiedSkill rejects duplicate names", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({
      name: "foo",
      description: "first",
      body: "body",
    });
    const result = await createUnifiedSkill({
      name: "foo",
      description: "second",
      body: "body",
    });
    assert.equal("error" in result, true);
  });
});

test("createUnifiedSkill rejects names longer than SKILL_NAME_MAX_LENGTH", async () => {
  await withTempHome(async () => {
    const name = "a".repeat(SKILL_NAME_MAX_LENGTH + 1);
    const result = await createUnifiedSkill({
      name,
      description: "d",
      body: "b",
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, new RegExp(`${SKILL_NAME_MAX_LENGTH} characters or fewer`));
  });
});

test("createUnifiedSkill accepts a name at exactly SKILL_NAME_MAX_LENGTH", async () => {
  await withTempHome(async () => {
    const name = "a".repeat(SKILL_NAME_MAX_LENGTH);
    const result = await createUnifiedSkill({
      name,
      description: "d",
      body: "b",
    });
    assert.equal("error" in result, false);
  });
});

test("createUnifiedSkill rejects names with forbidden characters", async () => {
  await withTempHome(async () => {
    const result = await createUnifiedSkill({
      name: "has spaces",
      description: "d",
      body: "b",
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, /letters, numbers, dots, dashes, and underscores/);
  });
});

test("createUnifiedSkill rejects path components", async () => {
  await withTempHome(async () => {
    for (const name of [".", "..", "../outside"]) {
      const result = await createUnifiedSkill({ name, description: "d", body: "b" });
      assert.equal("error" in result, true);
    }
  });
});

test("create and update reject dot-prefixed names", async () => {
  await withTempHome(async () => {
    const input = { name: ".review", description: "d", body: "b" };
    const created = await createUnifiedSkill(input);
    assert.equal("error" in created, true);
    if ("error" in created) assert.match(created.error, /cannot start with a dot/);
    await createUnifiedSkill({ ...input, name: "review" });
    const updated = await updateUnifiedSkill("review", input);
    assert.equal("error" in updated, true);
    if ("error" in updated) assert.match(updated.error, /cannot start with a dot/);
  });
});

test("recoverStagedSkillBackups restores an interrupted overwrite", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "Review", description: "old", body: "old body" });
    const liveDir = path.dirname(unifiedSkillFile("Review"));
    const stagingRoot = path.join(path.dirname(unifiedSkillsDir()), ".skill-staging");
    mkdirSync(stagingRoot);
    const backup = path.join(stagingRoot, ".skill-backup-abcdef");
    renameSync(liveDir, backup);
    writeFileSync(`${backup}.json`, JSON.stringify({ finalTarget: "review", originalDir: "Review" }));
    assert.equal(await readUnifiedSkill("Review"), null);

    await recoverStagedSkillBackups();
    assert.equal((await readUnifiedSkill("Review"))?.body, "old body");
    assert.equal(existsSync(liveDir), true);
    assert.deepEqual(readdirSync(unifiedSkillsDir()), ["Review"]);
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(`${backup}.json`), false);
  });
});

test("recoverStagedSkillBackups removes the old casing after a case-changing install", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "review", description: "new", body: "new body" });
    const stagingRoot = path.join(path.dirname(unifiedSkillsDir()), ".skill-staging");
    mkdirSync(stagingRoot);
    const backup = path.join(stagingRoot, ".skill-backup-abcdef");
    mkdirSync(backup);
    writeFileSync(path.join(backup, "SKILL.md"), "---\nname: Review\ndescription: old\n---\n\nold body\n");
    writeFileSync(`${backup}.json`, JSON.stringify({ finalTarget: "review", originalDir: "Review" }));

    await recoverStagedSkillBackups();
    assert.equal((await readUnifiedSkill("review"))?.body, "new body");
    assert.deepEqual(readdirSync(unifiedSkillsDir()), ["review"]);
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(`${backup}.json`), false);
  });
});

test("recoverStagedSkillBackups waits for a cross-process catalog lock", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "review", description: "old", body: "old body" });
    const liveDir = path.dirname(unifiedSkillFile("review"));
    const stagingRoot = path.join(path.dirname(unifiedSkillsDir()), ".skill-staging");
    mkdirSync(stagingRoot);
    const backup = path.join(stagingRoot, ".skill-backup-abcdef");
    renameSync(liveDir, backup);
    writeFileSync(`${backup}.json`, JSON.stringify({ finalTarget: "review", originalDir: "review" }));
    const release = await lock(stagingRoot, {
      lockfilePath: path.join(stagingRoot, "catalog.lock"), realpath: false,
      stale: 30_000, update: 5_000,
    });
    let released = false;
    const recovery = recoverStagedSkillBackups();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(existsSync(backup), true);
      assert.equal(existsSync(liveDir), false);
      await release();
      released = true;
      await recovery;
      assert.equal((await readUnifiedSkill("review"))?.body, "old body");
    } finally {
      if (!released) await release();
      await recovery;
    }
  });
});

test("recoverStagedSkillBackups leaves a backup with an invalid marker untouched", async () => {
  await withTempHome(async () => {
    const stagingRoot = path.join(path.dirname(unifiedSkillsDir()), ".skill-staging");
    mkdirSync(stagingRoot);
    const backup = path.join(stagingRoot, ".skill-backup-abcdef");
    mkdirSync(backup);
    writeFileSync(`${backup}.json`, JSON.stringify({ finalTarget: "../outside", originalDir: "review" }));
    await recoverStagedSkillBackups();
    assert.equal(existsSync(backup), true);
    assert.equal(existsSync(`${backup}.json`), true);
  });
});

test("createUnifiedSkill rejects an oversized SKILL.md", async () => {
  await withTempHome(async () => {
    const result = await createUnifiedSkill({
      name: "large", description: "d", body: "x".repeat(SKILL_TREE_MAX_BYTES),
    });
    assert.equal("error" in result, true);
    if ("error" in result) assert.match(result.error, /exceeds/);
  });
});

test("createUnifiedSkill rejects empty descriptions", async () => {
  await withTempHome(async () => {
    const result = await createUnifiedSkill({
      name: "ok",
      description: "   ",
      body: "b",
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, /Description is required/);
  });
});

test("createUnifiedSkill rejects descriptions longer than SKILL_DESCRIPTION_MAX_LENGTH", async () => {
  await withTempHome(async () => {
    const description = "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    const result = await createUnifiedSkill({
      name: "ok",
      description,
      body: "b",
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, new RegExp(`${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer`));
  });
});

test("updateUnifiedSkill rejects descriptions longer than SKILL_DESCRIPTION_MAX_LENGTH", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "ok", description: "d", body: "b" });
    const result = await updateUnifiedSkill("ok", {
      name: "ok",
      description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1),
      body: "b",
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, new RegExp(`${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer`));
  });
});

test("readUnifiedSkill returns body and metadata", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({
      name: "bar",
      description: "d",
      body: "## Body\nText",
    });
    const body = await readUnifiedSkill("bar");
    assert.ok(body);
    assert.equal(body.metadata.name, "bar");
    assert.equal(body.body, "## Body\nText");
  });
});

test("readUnifiedSkill is case-insensitive", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({
      name: "MixedCase",
      description: "d",
      body: "body",
    });
    const body = await readUnifiedSkill("MIXEDCASE");
    assert.ok(body);
    assert.equal(body.metadata.name, "MixedCase");
  });
});

test("updateUnifiedSkill renames skill directory and updates content", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({
      name: "old",
      description: "d",
      body: "body",
    });
    mkdirSync(path.join(path.dirname(unifiedSkillFile("old")), "references"));
    writeFileSync(path.join(path.dirname(unifiedSkillFile("old")), "references", "a.md"), "reference");
    const result = await updateUnifiedSkill("old", {
      name: "new",
      description: "updated",
      body: "updated body",
    });
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(result.name, "new");
    const updated = await readUnifiedSkill("new");
    assert.ok(updated);
    assert.equal(updated.body, "updated body");
    assert.equal(readFileSync(path.join(path.dirname(unifiedSkillFile("new")), "references", "a.md"), "utf-8"), "reference");

    const old = await readUnifiedSkill("old");
    assert.equal(old, null);
  });
});

test("updateUnifiedSkill prevents name collisions", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "a", description: "d", body: "b" });
    await createUnifiedSkill({ name: "b", description: "d", body: "b" });
    const result = await updateUnifiedSkill("a", {
      name: "b",
      description: "d",
      body: "b",
    });
    assert.equal("error" in result, true);
  });
});

test("deleteUnifiedSkill removes the skill directory", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "gone", description: "d", body: "b" });
    assert.ok(await readUnifiedSkill("gone"));
    await deleteUnifiedSkill("gone");
    assert.equal(await readUnifiedSkill("gone"), null);
    assert.equal((await listUnifiedSkills()).length, 0);
  });
});

test("deleteUnifiedSkill is case-insensitive and idempotent", async () => {
  await withTempHome(async () => {
    await createUnifiedSkill({ name: "Case", description: "d", body: "b" });
    await deleteUnifiedSkill("case");
    assert.equal(await readUnifiedSkill("Case"), null);
  });
});
