/*
 * Pure helpers for the import-skills dialog (issue #145).
 *
 * Kept dependency-free so they can be exercised in node:test without a DOM.
 * The dialog imports these; the dialog handles state, this file handles
 * data shape.
 */

import type { ImportableSkill, SkillImportResult, SkillImportStatus } from "../api.ts";

/** Stable, unique key per importable skill (provider + scope + path). */
export function importSkillKey(skill: ImportableSkill): string {
  return `${skill.providerId}\u0000${skill.scope}\u0000${skill.sourcePath}`;
}

export interface ImportSelectionState {
  selected: Set<string>;
  overwrite: boolean;
}

/** Toggle a skill in/out of the selection set. Returns a new state object. */
export function toggleImportSelection(
  state: ImportSelectionState,
  skill: ImportableSkill
): ImportSelectionState {
  const next = new Set(state.selected);
  const k = importSkillKey(skill);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return { ...state, selected: next };
}

/** Replace the selection set with one containing every discoverable skill. */
export function selectAllImportable(
  state: ImportSelectionState,
  skills: ImportableSkill[]
): ImportSelectionState {
  return { ...state, selected: new Set(skills.map(importSkillKey)) };
}

/** Empty the selection set. */
export function clearImportSelection(
  state: ImportSelectionState
): ImportSelectionState {
  return { ...state, selected: new Set() };
}

/** Set the overwrite flag. */
export function setImportOverwrite(
  state: ImportSelectionState,
  overwrite: boolean
): ImportSelectionState {
  return { ...state, overwrite };
}

/** Translate the selection into the shape the import endpoint expects. */
export function buildImportRequest(
  state: ImportSelectionState,
  skills: ImportableSkill[]
): {
  selections: Array<{
    providerId: string;
    sourcePath: string;
    scope: ImportableSkill["scope"];
    overwrite: boolean;
  }>;
} {
  const byKey = new Map(skills.map((s) => [importSkillKey(s), s]));
  const selections = Array.from(state.selected)
    .map((key) => byKey.get(key))
    .filter((s): s is ImportableSkill => Boolean(s))
    .map((s) => ({
      providerId: s.providerId,
      sourcePath: s.sourcePath,
      scope: s.scope,
      overwrite: state.overwrite,
    }));
  return { selections };
}

/** Count per-status results for the summary chips. */
export function summarizeImportResults(
  results: SkillImportResult[]
): Record<SkillImportStatus, number> {
  const counts: Record<SkillImportStatus, number> = {
    imported: 0,
    skipped: 0,
    error: 0,
  };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/**
 * Group importable skills by name + case-insensitive collision with the
 * existing unified catalog. The map value is the list of colliding
 * importable skills, so the UI can flag rows that would be skipped.
 */
export function buildCollisionMap(
  skills: ImportableSkill[],
  existingNames: string[]
): Map<string, ImportableSkill[]> {
  const map = new Map<string, ImportableSkill[]>();
  const existing = new Set(existingNames.map((name) => name.toLowerCase()));
  for (const s of skills) {
    if (!existing.has(s.name.toLowerCase())) continue;
    const list = map.get(s.name) ?? [];
    list.push(s);
    map.set(s.name, list);
  }
  return map;
}