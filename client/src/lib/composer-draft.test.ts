import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentSkill } from "../api.ts";
import {
  buildComposerDraftKey,
  loadComposerDraft,
  saveComposerDraft,
  clearComposerDraft,
} from "./composer-draft.ts";

/*
 * A minimal in-memory localStorage so the persistence helpers can be exercised
 * without a browser (the test runner is plain node:test).
 */
function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  (globalThis as unknown as { window: { localStorage: typeof localStorage } }).window =
    { localStorage };
}

const skill: AgentSkill = {
  name: "deep-research",
  description: "Run a deep research pass",
  path: "/skills/deep-research",
  scope: "repo",
};

beforeEach(() => {
  installFakeLocalStorage();
});

test("keys real sessions by sessionId", () => {
  assert.equal(buildComposerDraftKey("sess-1", "proj-1", "wt-1"), "composerDraft:sess-1");
});

test("keys the new-session view by project + worktree", () => {
  assert.equal(
    buildComposerDraftKey(undefined, "proj-1", "wt-1"),
    "composerDraft:new:proj-1:wt-1"
  );
  assert.equal(
    buildComposerDraftKey(undefined, "proj-1"),
    "composerDraft:new:proj-1:main"
  );
});

test("round-trips text and skill chips", () => {
  const key = buildComposerDraftKey("sess-1", "proj-1");
  saveComposerDraft(key, { text: "half a thought", skills: [skill] });

  const loaded = loadComposerDraft(key);
  assert.equal(loaded.text, "half a thought");
  assert.deepEqual(loaded.skills, [skill]);
});

test("returns an empty draft when nothing is stored", () => {
  assert.deepEqual(loadComposerDraft("composerDraft:missing"), { text: "", skills: [] });
});

test("drafts do not bleed across sessions", () => {
  const keyA = buildComposerDraftKey("sess-A", "proj-1");
  const keyB = buildComposerDraftKey("sess-B", "proj-1");
  saveComposerDraft(keyA, { text: "draft for A", skills: [] });

  assert.equal(loadComposerDraft(keyA).text, "draft for A");
  assert.equal(loadComposerDraft(keyB).text, "");
});

test("clearComposerDraft removes the stored draft", () => {
  const key = buildComposerDraftKey("sess-1", "proj-1");
  saveComposerDraft(key, { text: "to be sent", skills: [] });
  clearComposerDraft(key);
  assert.deepEqual(loadComposerDraft(key), { text: "", skills: [] });
});

test("tolerates corrupted JSON", () => {
  const key = "composerDraft:corrupt";
  window.localStorage.setItem(key, "{not valid json");
  assert.deepEqual(loadComposerDraft(key), { text: "", skills: [] });
});

test("drops malformed skill entries while keeping valid text", () => {
  const key = "composerDraft:partial";
  window.localStorage.setItem(
    key,
    JSON.stringify({ text: "keep me", skills: [skill, { name: "broken" }, null, 42] })
  );
  const loaded = loadComposerDraft(key);
  assert.equal(loaded.text, "keep me");
  assert.deepEqual(loaded.skills, [skill]);
});

test("round-trips agent + run options", () => {
  const key = buildComposerDraftKey(undefined, "proj-1", "wt-1");
  saveComposerDraft(key, {
    text: "draft with options",
    skills: [],
    provider: "claude",
    model: "claude-opus-4-8",
    mode: "plan",
    reasoningEffort: "high",
    serviceTier: "fast",
  });

  const loaded = loadComposerDraft(key);
  assert.equal(loaded.provider, "claude");
  assert.equal(loaded.model, "claude-opus-4-8");
  assert.equal(loaded.mode, "plan");
  assert.equal(loaded.reasoningEffort, "high");
  assert.equal(loaded.serviceTier, "fast");
});

test("omits options entirely when not provided", () => {
  const key = buildComposerDraftKey(undefined, "proj-1");
  saveComposerDraft(key, { text: "no options", skills: [] });

  const loaded = loadComposerDraft(key);
  assert.equal(loaded.provider, undefined);
  assert.equal(loaded.model, undefined);
  assert.equal(loaded.mode, undefined);
  assert.equal(loaded.reasoningEffort, undefined);
  assert.equal(loaded.serviceTier, undefined);
});

test("drops invalid enum-typed options but keeps valid ones", () => {
  const key = "composerDraft:bad-options";
  window.localStorage.setItem(
    key,
    JSON.stringify({
      text: "keep me",
      skills: [],
      provider: "claude",
      mode: "bogus",
      reasoningEffort: "turbo",
      serviceTier: 7,
    })
  );

  const loaded = loadComposerDraft(key);
  assert.equal(loaded.text, "keep me");
  // Free-form string survives; invalid enums are dropped to fall back to defaults.
  assert.equal(loaded.provider, "claude");
  assert.equal(loaded.mode, undefined);
  assert.equal(loaded.reasoningEffort, undefined);
  assert.equal(loaded.serviceTier, undefined);
});
