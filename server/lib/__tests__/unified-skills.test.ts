import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createUnifiedSkill,
  deleteUnifiedSkill,
  listUnifiedSkills,
  readUnifiedSkill,
  updateUnifiedSkill,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from "../unified-skills.js";
import { unifiedSkillFile } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "unified-skills-"));
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("listUnifiedSkills is empty by default", async () => {
  await withTempHome(async () => {
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
