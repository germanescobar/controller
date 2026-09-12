import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMemoryBlock,
  buildPreview,
  deleteMemory,
  ensureMemoryDirs,
  getMemoryBackend,
  listMemory,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_PINNED_MAX_LENGTH,
  MEMORY_PREVIEW_CHARS,
  MEMORY_SLUG_MAX_LENGTH,
  MEMORY_SLUG_RE,
  NullMemoryBackend,
  readMemory,
  readPinnedMemory,
  resetMemoryBackendForTests,
  RgMemoryBackend,
  validateMemorySlug,
  writeMemory,
  writePinnedMemory,
  type MemoryEntry,
} from "../memory.js";
import {
  buildControllerPreamble,
} from "../agent-preamble.js";
import {
  memoryNoteFile,
  memoryPinnedFile,
  memoryDir,
} from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  const previousHome = process.env.HOME;
  const previousOrchHome = process.env.CONTROLLER_HOME;
  process.env.HOME = dir;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOrchHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousOrchHome;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function seedGlobalNote(slug: string, content: string): Promise<void> {
  const result = await writeMemory({ scope: "global", slug, content });
  assert.deepEqual(result, { ok: true });
}

async function seedProjectNote(
  projectId: string,
  slug: string,
  content: string
): Promise<void> {
  const result = await writeMemory({ scope: "project", projectId, slug, content });
  assert.deepEqual(result, { ok: true });
}

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

test("validateMemorySlug accepts the documented charset", () => {
  assert.equal(validateMemorySlug("deploy-via-github-action"), null);
  assert.equal(validateMemorySlug("2026-01-15-foo"), null);
  assert.equal(validateMemorySlug("a.b_c-d.e"), null);
});

test("validateMemorySlug rejects empty, too-long, and bad chars", () => {
  assert.match(validateMemorySlug("") ?? "", /required/);
  assert.match(validateMemorySlug("a".repeat(MEMORY_SLUG_MAX_LENGTH + 1)) ?? "", /characters or fewer/);
  assert.match(validateMemorySlug("has spaces") ?? "", /letters, numbers/);
  assert.match(validateMemorySlug("slash/in/slug") ?? "", /letters, numbers/);
  assert.match(validateMemorySlug(".leading-dot") ?? "", /must not start/);
  assert.match(validateMemorySlug("-leading-dash") ?? "", /must not start/);
});

test("validateMemorySlug accepts the boundary length", () => {
  assert.equal(validateMemorySlug("a".repeat(MEMORY_SLUG_MAX_LENGTH)), null);
});

test("MEMORY_SLUG_RE matches the documented charset", () => {
  assert.match("a-b_c.1", MEMORY_SLUG_RE);
  assert.doesNotMatch("a b", MEMORY_SLUG_RE);
  assert.doesNotMatch("a/b", MEMORY_SLUG_RE);
});

// ---------------------------------------------------------------------------
// CRUD round-trip — global scope
// ---------------------------------------------------------------------------

test("writeMemory + readMemory round-trips for the global scope", async () => {
  await withTempHome(async () => {
    const write = await writeMemory({
      scope: "global",
      slug: "deploy-via-gh",
      content: "All deploys go through the GH Action.",
    });
    assert.deepEqual(write, { ok: true });
    const read = await readMemory({ scope: "global", slug: "deploy-via-gh" });
    assert.ok(read);
    assert.equal(read?.slug, "deploy-via-gh");
    assert.equal(read?.scope, "global");
    assert.equal(read?.content, "All deploys go through the GH Action.");
    assert.equal(read?.preview, "All deploys go through the GH Action.");
  });
});

test("writeMemory rejects an empty slug", async () => {
  await withTempHome(async () => {
    const result = await writeMemory({ scope: "global", slug: "  ", content: "x" });
    assert.equal("error" in result, true);
  });
});

test("writeMemory rejects a body that is too long", async () => {
  await withTempHome(async () => {
    const result = await writeMemory({
      scope: "global",
      slug: "huge",
      content: "x".repeat(MEMORY_CONTENT_MAX_LENGTH + 1),
    });
    assert.equal("error" in result, true);
    if (!("error" in result)) return;
    assert.match(result.error, /characters or fewer/);
  });
});

test("listMemory returns notes sorted newest-first", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("alpha", "first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedGlobalNote("beta", "second");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedGlobalNote("gamma", "third");
    const entries = await listMemory({ scope: "global" });
    assert.deepEqual(
      entries.map((e) => e.slug),
      ["gamma", "beta", "alpha"]
    );
  });
});

test("listMemory scopes never bleed into each other", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("only-global", "g-body");
    await seedProjectNote("project-1", "only-project-1", "p1-body");
    await seedProjectNote("project-2", "only-project-2", "p2-body");
    const global = await listMemory({ scope: "global" });
    const p1 = await listMemory({ scope: "project", projectId: "project-1" });
    const p2 = await listMemory({ scope: "project", projectId: "project-2" });
    assert.deepEqual(global.map((e) => e.slug), ["only-global"]);
    assert.deepEqual(p1.map((e) => e.slug), ["only-project-1"]);
    assert.deepEqual(p2.map((e) => e.slug), ["only-project-2"]);
    assert.equal(p1[0]?.projectId, "project-1");
    assert.equal(p2[0]?.projectId, "project-2");
  });
});

test("listMemory includes a preview built from the first line", async () => {
  await withTempHome(async () => {
    await writeMemory({
      scope: "global",
      slug: "frontmatter",
      content: "Title\n\nBody line 1\nBody line 2",
    });
    const [entry] = await listMemory({ scope: "global" });
    assert.equal(entry?.preview, "Title");
  });
});

test("listMemory skips the pinned.md file when it happens to share the notes dir", async () => {
  await withTempHome(async () => {
    await writePinnedMemory({ scope: "global", content: "pinned body" });
    const entries = await listMemory({ scope: "global" });
    assert.equal(entries.length, 0, "pinned.md must never appear in the notes listing");
    // Pinned lives at the scope root, notes/ in a sibling — even if a
    // user manually drops a `pinned.md` inside notes/, listing must skip
    // it (defensive against manual edits).
    const notesDir = path.join(memoryDir(), "global", "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(path.join(notesDir, "pinned.md"), "stray pinned");
    const stillEmpty = await listMemory({ scope: "global" });
    assert.equal(stillEmpty.length, 0);
  });
});

test("deleteMemory is idempotent and removes the file", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("doomed", "body");
    assert.ok(existsSync(memoryNoteFile("global", "doomed")));
    await deleteMemory({ scope: "global", slug: "doomed" });
    assert.equal(existsSync(memoryNoteFile("global", "doomed")), false);
    // Missing-then-delete is a no-op success (mirrors unified-skills).
    await deleteMemory({ scope: "global", slug: "missing" });
  });
});

test("deleteMemory with a bad slug is a no-op", async () => {
  await withTempHome(async () => {
    await deleteMemory({ scope: "global", slug: "bad/slug" });
  });
});

// ---------------------------------------------------------------------------
// Pinned.md — independent from notes/
// ---------------------------------------------------------------------------

test("pinned.md round-trips independently of notes/", async () => {
  await withTempHome(async () => {
    const beforeWrite = await readPinnedMemory({ scope: "global" });
    assert.equal(beforeWrite, "", "absent pinned.md reads as empty");
    const result = await writePinnedMemory({
      scope: "global",
      content: "always-injected pinned snippet",
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(
      await readPinnedMemory({ scope: "global" }),
      "always-injected pinned snippet"
    );
    // Round-tripping a note must not touch pinned.md.
    await seedGlobalNote("note-only", "n-body");
    assert.equal(
      await readPinnedMemory({ scope: "global" }),
      "always-injected pinned snippet"
    );
    // And the notes listing must not include pinned.md.
    const entries = await listMemory({ scope: "global" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.slug, "note-only");
  });
});

test("writePinnedMemory rejects bodies that are too long", async () => {
  await withTempHome(async () => {
    const result = await writePinnedMemory({
      scope: "global",
      content: "x".repeat(MEMORY_PINNED_MAX_LENGTH + 1),
    });
    assert.equal("error" in result, true);
  });
});

test("project-scoped pinned.md is independent from global pinned.md", async () => {
  await withTempHome(async () => {
    await writePinnedMemory({ scope: "global", content: "global pinned" });
    await writePinnedMemory({ scope: "project", projectId: "p-1", content: "p-1 pinned" });
    assert.equal(await readPinnedMemory({ scope: "global" }), "global pinned");
    assert.equal(await readPinnedMemory({ scope: "project", projectId: "p-1" }), "p-1 pinned");
    assert.equal(await readPinnedMemory({ scope: "project", projectId: "p-2" }), "");
  });
});

// ---------------------------------------------------------------------------
// Preamble block
// ---------------------------------------------------------------------------

test("buildMemoryBlock renders empty placeholders when the home is bare", async () => {
  await withTempHome(async () => {
    const block = await buildMemoryBlock({});
    assert.match(block, /<pinned_global>\s*\(empty\)\s*<\/pinned_global>/);
    assert.doesNotMatch(block, /<pinned_project>/);
    assert.match(block, /<memory_index>\s*\(no notes yet\)\s*<\/memory_index>/);
    assert.match(block, /<\/memory>/);
  });
});

test("buildMemoryBlock includes pinned_project and project notes when given a projectId", async () => {
  await withTempHome(async () => {
    await writePinnedMemory({ scope: "project", projectId: "p-1", content: "we use Jest" });
    await seedProjectNote("p-1", "test-runner", "Jest, not Vitest");
    const block = await buildMemoryBlock({ projectId: "p-1" });
    assert.match(block, /<pinned_project>\s*we use Jest\s*<\/pinned_project>/);
    assert.match(block, /project:p-1 \| test-runner \| Jest, not Vitest/);
  });
});

test("buildMemoryBlock shows the global index even when only project notes exist", async () => {
  await withTempHome(async () => {
    await seedProjectNote("p-1", "deploy", "go via GH action");
    const block = await buildMemoryBlock({ projectId: "p-1" });
    assert.match(block, /project:p-1 \| deploy \| go via GH action/);
  });
});

test("buildControllerPreamble threads projectId into the memory block", async () => {
  await withTempHome(async () => {
    await writePinnedMemory({ scope: "global", content: "global pinned" });
    await writePinnedMemory({ scope: "project", projectId: "p-1", content: "project pinned" });
    await seedGlobalNote("g-note", "g-body");
    await seedProjectNote("p-1", "p-note", "p-body");
    const preamble = await buildControllerPreamble({ projectId: "p-1" });
    // Memory intro lands.
    assert.match(preamble, /Controller has an app-owned \*\*memory\*\* layer/);
    // Block has both pinned snippets + both indexes.
    assert.match(preamble, /global pinned/);
    assert.match(preamble, /project pinned/);
    assert.match(preamble, /project:p-1 \| p-note \| p-body/);
    assert.match(preamble, /global \| g-note \| g-body/);
    // No full bodies leaked into the preamble.
    // (g-body and p-body are short — they appear *only* via the preview
    // line above, never as standalone lines.)
    assert.doesNotMatch(preamble, /^g-body$/m);
  });
});

test("buildControllerPreamble without projectId omits project memory", async () => {
  await withTempHome(async () => {
    await seedProjectNote("p-1", "p-note", "p-body");
    const preamble = await buildControllerPreamble();
    assert.doesNotMatch(preamble, /pinned_project/);
    assert.doesNotMatch(preamble, /p-note/);
  });
});

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

test("RgMemoryBackend returns filename hits before content hits", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("deploy-via-gh", "All deploys go through the GH action.");
    await seedGlobalNote("other", "Some unrelated text.");
    const backend = new RgMemoryBackend();
    const hits = await backend.search({ scope: "global", query: "deploy" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.slug, "deploy-via-gh");
  });
});

test("RgMemoryBackend falls back to a content search when no filename hits", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("misc", "we use Jest for tests, not Vitest");
    await seedGlobalNote("unrelated", "we deploy to staging on Tuesdays");
    const backend = new RgMemoryBackend();
    const hits = await backend.search({ scope: "global", query: "Jest" });
    assert.equal(hits.length >= 1, true);
    assert.equal(hits[0]?.slug, "misc");
  });
});

test("RgMemoryBackend scopes search to the requested scope only", async () => {
  await withTempHome(async () => {
    await seedGlobalNote("g-only", "Jest in global");
    await seedProjectNote("p-1", "p-only", "Jest in project");
    const backend = new RgMemoryBackend();
    const global = await backend.search({ scope: "global", query: "Jest" });
    const project = await backend.search({ scope: "project", projectId: "p-1", query: "Jest" });
    assert.equal(global.length, 1);
    assert.equal(global[0]?.slug, "g-only");
    assert.equal(project.length, 1);
    assert.equal(project[0]?.slug, "p-only");
  });
});

test("RgMemoryBackend honours the limit", async () => {
  await withTempHome(async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedGlobalNote(`note-${i}`, "matching body");
    }
    const backend = new RgMemoryBackend();
    const hits = await backend.search({ scope: "global", query: "matching", limit: 2 });
    assert.equal(hits.length, 2);
  });
});

test("NullMemoryBackend returns no results regardless of input", async () => {
  const backend = new NullMemoryBackend();
  const hits = await backend.search({ scope: "global", query: "anything" });
  assert.deepEqual(hits, []);
});

test("getMemoryBackend returns NullMemoryBackend when CONTROLLER_MEMORY_BACKEND=null", async () => {
  await withTempHome(async () => {
    const previous = process.env.CONTROLLER_MEMORY_BACKEND;
    process.env.CONTROLLER_MEMORY_BACKEND = "null";
    resetMemoryBackendForTests();
    try {
      const backend = getMemoryBackend();
      assert.ok(backend instanceof NullMemoryBackend);
    } finally {
      if (previous === undefined) delete process.env.CONTROLLER_MEMORY_BACKEND;
      else process.env.CONTROLLER_MEMORY_BACKEND = previous;
      resetMemoryBackendForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("buildPreview uses the first non-empty line when matchIdx is 0", () => {
  const preview = buildPreview("Title\n\nBody", 0);
  assert.equal(preview, "Title");
});

test("buildPreview centres the preview on the match for a content search", () => {
  const body = "x".repeat(40) + " we use Jest " + "y".repeat(40);
  const preview = buildPreview(body, 45);
  assert.match(preview, /we use Jest/);
  assert.ok(preview.length <= MEMORY_PREVIEW_CHARS, `preview length ${preview.length} > ${MEMORY_PREVIEW_CHARS}`);
});

test("buildPreview ellipsises long values", () => {
  const long = "x".repeat(MEMORY_PREVIEW_CHARS * 2);
  const preview = buildPreview(long, 0);
  assert.equal(preview.length, MEMORY_PREVIEW_CHARS);
  assert.match(preview, /…$/);
});

test("ensureMemoryDirs creates the global scope directory", async () => {
  await withTempHome(async () => {
    await ensureMemoryDirs();
    assert.ok(existsSync(memoryDir()));
    assert.ok(existsSync(path.join(memoryDir(), "global")));
  });
});

// ---------------------------------------------------------------------------
// on-disk shape — keep one explicit assertion that the files live where
// the issue promises (so a future refactor doesn't quietly change paths
// and surprise the user).
// ---------------------------------------------------------------------------

test("on-disk shape matches the issue (issue #350 §1)", async () => {
  await withTempHome(async () => {
    await writePinnedMemory({ scope: "global", content: "gp" });
    await writePinnedMemory({ scope: "project", projectId: "p-1", content: "pp" });
    await seedGlobalNote("g-slug", "g-body");
    await seedProjectNote("p-1", "p-slug", "p-body");
    assert.ok(existsSync(memoryPinnedFile("global")));
    assert.ok(existsSync(memoryPinnedFile("project", "p-1")));
    assert.ok(existsSync(memoryNoteFile("global", "g-slug")));
    assert.ok(existsSync(memoryNoteFile("project", "p-slug", "p-1")));
    // Pinned lives at the scope root, not under notes/.
    assert.equal(
      readFileSync(memoryPinnedFile("global"), "utf-8"),
      "gp"
    );
  });
});
