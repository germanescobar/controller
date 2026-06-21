/*
 * Tests for the pure helpers backing the Settings → Skills import dialog.
 *
 * These cover the data-shape and state-translation logic so the dialog can
 * focus on UI state. See `import-skills-dialog.tsx` for the consumer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollisionMap,
  buildImportRequest,
  clearImportSelection,
  importSkillKey,
  selectAllImportable,
  setImportOverwrite,
  summarizeImportResults,
  toggleImportSelection,
  type ImportSelectionState,
} from "./import-skills-helpers.ts";
import type {
  ImportableSkill,
  SkillImportResult,
} from "../api.ts";

function makeSkill(overrides: Partial<ImportableSkill> = {}): ImportableSkill {
  return {
    name: "review",
    description: "Review PRs",
    providerId: "anita",
    scope: "user",
    sourcePath: "/Users/me/.anita/skills/review/SKILL.md",
    projectPath: null,
    ...overrides,
  };
}

function emptyState(overrides: Partial<ImportSelectionState> = {}): ImportSelectionState {
  return { selected: new Set<string>(), overwrite: false, ...overrides };
}

test("importSkillKey is unique per provider/scope/path combination", () => {
  const a = makeSkill();
  const b = makeSkill({ providerId: "codex" });
  const c = makeSkill({ scope: "system" });
  const d = makeSkill({ sourcePath: "/elsewhere/SKILL.md" });
  // Different inputs yield different keys
  assert.notEqual(importSkillKey(a), importSkillKey(b));
  assert.notEqual(importSkillKey(a), importSkillKey(c));
  assert.notEqual(importSkillKey(a), importSkillKey(d));
  // Same input yields the same key
  assert.equal(importSkillKey(a), importSkillKey(makeSkill()));
});

test("toggleImportSelection adds and removes a skill id from the selection set", () => {
  const skill = makeSkill();
  const key = importSkillKey(skill);

  const added = toggleImportSelection(emptyState(), skill);
  assert.equal(added.selected.has(key), true);
  assert.equal(added.selected.size, 1);

  // Toggling again removes the key (not throws, not duplicates).
  const removed = toggleImportSelection(added, skill);
  assert.equal(removed.selected.has(key), false);
  assert.equal(removed.selected.size, 0);
});

test("toggleImportSelection returns a new state object without mutating the input", () => {
  const skill = makeSkill();
  const before = emptyState();
  const beforeKey = before.selected;
  const after = toggleImportSelection(before, skill);
  assert.notEqual(after, before, "should return a new state object");
  assert.equal(before.selected, beforeKey, "should not mutate the input set");
  assert.equal(before.selected.size, 0);
  assert.equal(after.selected.size, 1);
});

test("selectAllImportable marks every skill as selected", () => {
  const skills = [
    makeSkill({ name: "a" }),
    makeSkill({ name: "b", providerId: "codex" }),
    makeSkill({ name: "c", providerId: "claude" }),
  ];
  const next = selectAllImportable(emptyState(), skills);
  assert.equal(next.selected.size, 3);
  for (const s of skills) {
    assert.equal(next.selected.has(importSkillKey(s)), true);
  }
});

test("selectAllImportable replaces the previous selection", () => {
  const oldSkill = makeSkill({
    name: "old",
    sourcePath: "/Users/me/.anita/skills/old/SKILL.md",
  });
  const newSkills = [
    makeSkill({
      name: "new-1",
      sourcePath: "/Users/me/.anita/skills/new-1/SKILL.md",
    }),
    makeSkill({
      name: "new-2",
      sourcePath: "/Users/me/.anita/skills/new-2/SKILL.md",
    }),
  ];
  const state = emptyState({ selected: new Set([importSkillKey(oldSkill)]) });
  const next = selectAllImportable(state, newSkills);
  assert.equal(next.selected.has(importSkillKey(oldSkill)), false);
  assert.equal(next.selected.size, 2);
});

test("clearImportSelection empties the selection set", () => {
  const skill = makeSkill();
  const state: ImportSelectionState = {
    selected: new Set([importSkillKey(skill)]),
    overwrite: true,
  };
  const next = clearImportSelection(state);
  assert.equal(next.selected.size, 0);
  // overwrite flag is preserved (this only affects selection)
  assert.equal(next.overwrite, true);
});

test("setImportOverwrite toggles the overwrite flag without touching the selection", () => {
  const skill = makeSkill();
  const state: ImportSelectionState = {
    selected: new Set([importSkillKey(skill)]),
    overwrite: false,
  };
  const enabled = setImportOverwrite(state, true);
  assert.equal(enabled.overwrite, true);
  assert.equal(enabled.selected.size, 1);
  const disabled = setImportOverwrite(enabled, false);
  assert.equal(disabled.overwrite, false);
});

test("buildImportRequest translates the selection into the API payload", () => {
  const skills = [
    makeSkill({
      name: "a",
      sourcePath: "/Users/me/.anita/skills/a/SKILL.md",
    }),
    makeSkill({
      name: "b",
      providerId: "codex",
      sourcePath: "/Users/me/.codex/skills/b/SKILL.md",
    }),
    makeSkill({
      name: "c",
      providerId: "claude",
      sourcePath: "/Users/me/.claude/skills/c/SKILL.md",
    }),
  ];
  const state: ImportSelectionState = {
    selected: new Set([importSkillKey(skills[0]), importSkillKey(skills[2])]),
    overwrite: false,
  };
  const { selections } = buildImportRequest(state, skills);
  assert.equal(selections.length, 2);
  const byName = Object.fromEntries(selections.map((s) => [s.sourcePath, s]));
  assert.ok(byName[skills[0].sourcePath]);
  assert.equal(byName[skills[0].sourcePath].providerId, "anita");
  assert.equal(byName[skills[0].sourcePath].overwrite, false);
  assert.ok(byName[skills[2].sourcePath]);
  assert.equal(byName[skills[2].sourcePath].providerId, "claude");
  // The unselected skill should not be in the payload
  assert.equal(byName[skills[1].sourcePath], undefined);
});

test("buildImportRequest forwards the overwrite flag to every selection", () => {
  const skills = [
    makeSkill({
      name: "a",
      sourcePath: "/Users/me/.anita/skills/a/SKILL.md",
    }),
    makeSkill({
      name: "b",
      sourcePath: "/Users/me/.anita/skills/b/SKILL.md",
    }),
  ];
  const state: ImportSelectionState = {
    selected: new Set(skills.map(importSkillKey)),
    overwrite: true,
  };
  const { selections } = buildImportRequest(state, skills);
  assert.equal(selections.length, 2);
  for (const s of selections) {
    assert.equal(s.overwrite, true);
  }
});

test("buildImportRequest drops stale keys not in the discoverable list", () => {
  const orphan = makeSkill({
    name: "orphan",
    sourcePath: "/Users/me/.anita/skills/orphan/SKILL.md",
  });
  const visible = makeSkill({
    name: "visible",
    sourcePath: "/Users/me/.anita/skills/visible/SKILL.md",
  });
  const state: ImportSelectionState = {
    selected: new Set([importSkillKey(orphan), importSkillKey(visible)]),
    overwrite: false,
  };
  const { selections } = buildImportRequest(state, [visible]);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].providerId, "anita");
  assert.equal(selections[0].sourcePath, visible.sourcePath);
});

test("summarizeImportResults tallies per-status counts", () => {
  const results: SkillImportResult[] = [
    {
      providerId: "anita",
      scope: "user",
      name: "a",
      status: "imported",
    },
    {
      providerId: "anita",
      scope: "user",
      name: "b",
      status: "skipped",
      reason: "collision",
    },
    {
      providerId: "anita",
      scope: "user",
      name: "c",
      status: "imported",
    },
    {
      providerId: "codex",
      scope: "system",
      name: "d",
      status: "error",
      reason: "missing file",
    },
  ];
  const summary = summarizeImportResults(results);
  assert.deepEqual(summary, { imported: 2, skipped: 1, error: 1 });
});

test("summarizeImportResults handles an empty list", () => {
  assert.deepEqual(summarizeImportResults([]), {
    imported: 0,
    skipped: 0,
    error: 0,
  });
});

test("buildCollisionMap flags skills whose names collide with existing unified skills", () => {
  const skills = [
    makeSkill({ name: "review" }),
    makeSkill({ name: "lint" }),
    makeSkill({ name: "REVIEW", providerId: "codex" }),
  ];
  const map = buildCollisionMap(skills, ["review"]);
  // Both `review` and `REVIEW` should collide (case-insensitive match),
  // grouped by the frontmatter name from the importable entry.
  assert.equal(map.size, 2);
  assert.equal(map.get("review")?.length, 1);
  assert.equal(map.get("REVIEW")?.length, 1);
  assert.equal(map.has("lint"), false);
});

test("buildCollisionMap returns an empty map when no names collide", () => {
  const skills = [makeSkill({ name: "review" })];
  const map = buildCollisionMap(skills, ["lint"]);
  assert.equal(map.size, 0);
});

test("buildCollisionMap handles an empty existing list", () => {
  const skills = [makeSkill({ name: "review" })];
  const map = buildCollisionMap(skills, []);
  assert.equal(map.size, 0);
});
