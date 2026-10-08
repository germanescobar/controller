import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRanges,
  formatSelectionToken,
  normalizeRanges,
  parseSelectionToken,
  parseSelectionBlock,
  buildSelectionContextBlock,
  buildSelectionPromptPrefix,
  truncatePreview,
  type LineRange,
  type SelectionMention,
} from "./diff-selection.ts";

// --- normalizeRanges -------------------------------------------------------

test("normalizeRanges returns null for an empty list", () => {
  assert.equal(normalizeRanges([]), null);
});

test("normalizeRanges returns null when every range is invalid", () => {
  assert.equal(normalizeRanges([{ start: 0, end: 0 }]), null);
  assert.equal(normalizeRanges([{ start: -3, end: 1 }]), null);
});

test("normalizeRanges flips reversed ranges so start <= end", () => {
  assert.deepEqual(normalizeRanges([{ start: 9, end: 5 }]), [
    { start: 5, end: 9 },
  ]);
});

test("normalizeRanges merges overlapping ranges", () => {
  assert.deepEqual(
    normalizeRanges([
      { start: 1, end: 5 },
      { start: 3, end: 9 },
    ]),
    [{ start: 1, end: 9 }],
  );
});

test("normalizeRanges merges adjacent ranges", () => {
  assert.deepEqual(
    normalizeRanges([
      { start: 1, end: 5 },
      { start: 6, end: 9 },
    ]),
    [{ start: 1, end: 9 }],
  );
});

test("normalizeRanges keeps disjoint ranges sorted by start", () => {
  assert.deepEqual(
    normalizeRanges([
      { start: 20, end: 22 },
      { start: 5, end: 7 },
    ]),
    [
      { start: 5, end: 7 },
      { start: 20, end: 22 },
    ],
  );
});

// --- formatRanges / formatSelectionToken -----------------------------------

test("formatRanges renders a single line as just the number", () => {
  assert.equal(formatRanges([{ start: 42, end: 42 }]), "42");
});

test("formatRanges renders a range as start-end", () => {
  assert.equal(formatRanges([{ start: 42, end: 58 }]), "42-58");
});

test("formatRanges joins disjoint ranges with commas", () => {
  assert.equal(
    formatRanges([
      { start: 42, end: 58 },
      { start: 61, end: 65 },
    ]),
    "42-58,61-65",
  );
});

test("formatSelectionToken composes path + ranges", () => {
  assert.equal(
    formatSelectionToken("server/lib/sessions.ts", [{ start: 42, end: 58 }]),
    "server/lib/sessions.ts:42-58",
  );
});

test("formatSelectionToken returns null for an empty range list", () => {
  assert.equal(formatSelectionToken("a.ts", []), null);
});

// --- parseSelectionToken ---------------------------------------------------

test("parseSelectionToken parses a single-line selection", () => {
  const parsed = parseSelectionToken("server/lib/sessions.ts:42");
  assert.deepEqual(parsed, {
    path: "server/lib/sessions.ts",
    ranges: [{ start: 42, end: 42 }],
  });
});

test("parseSelectionToken parses a contiguous range", () => {
  const parsed = parseSelectionToken("server/lib/sessions.ts:42-58");
  assert.deepEqual(parsed, {
    path: "server/lib/sessions.ts",
    ranges: [{ start: 42, end: 58 }],
  });
});

test("parseSelectionToken parses a multi-range selection", () => {
  const parsed = parseSelectionToken("server/lib/sessions.ts:42-58,61-65");
  assert.deepEqual(parsed, {
    path: "server/lib/sessions.ts",
    ranges: [
      { start: 42, end: 58 },
      { start: 61, end: 65 },
    ],
  });
});

test("parseSelectionToken rejects tokens with no colon", () => {
  assert.equal(parseSelectionToken("server/lib/sessions.ts"), null);
});

test("parseSelectionToken rejects tokens with non-numeric ranges", () => {
  assert.equal(parseSelectionToken("a.ts:abc"), null);
  assert.equal(parseSelectionToken("a.ts:42-"), null);
});

test("parseSelectionToken rejects tokens with non-positive line numbers", () => {
  assert.equal(parseSelectionToken("a.ts:0"), null);
  assert.equal(parseSelectionToken("a.ts:-3"), null);
});

test("parseSelectionToken rejects tokens that look like plain file paths", () => {
  // The backend resolver falls back to the file-mention path when
  // the selection parser returns null, so it's important the parser
  // doesn't accidentally swallow ordinary `@`-mention tokens.
  assert.equal(parseSelectionToken("server/lib/sessions.ts"), null);
  assert.equal(parseSelectionToken("path/with:colon"), null);
});

// --- parseSelectionBlock ---------------------------------------------------

test("parseSelectionBlock parses a single-selection block", () => {
  const raw = "<selections>\n- server/lib/sessions.ts:42-58\n</selections>\nrest of text";
  const parsed = parseSelectionBlock(raw);
  assert.equal(parsed.selections.length, 1);
  assert.equal(parsed.selections[0].path, "server/lib/sessions.ts");
  assert.deepEqual(parsed.selections[0].ranges, [{ start: 42, end: 58 }]);
  assert.equal(parsed.text, "rest of text");
});

test("parseSelectionBlock parses a multi-selection block", () => {
  const raw =
    "<selections>\n- a.ts:1-3\n- b.ts:5\n- c.ts:7-9,11\n</selections>\nrest";
  const parsed = parseSelectionBlock(raw);
  assert.equal(parsed.selections.length, 3);
  assert.equal(parsed.selections[0].path, "a.ts");
  assert.equal(parsed.selections[1].path, "b.ts");
  assert.deepEqual(parsed.selections[2].ranges, [
    { start: 7, end: 9 },
    { start: 11, end: 11 },
  ]);
  assert.equal(parsed.text, "rest");
});

test("parseSelectionBlock returns empty for malformed blocks", () => {
  assert.deepEqual(parseSelectionBlock("no block here"), {
    selections: [],
    text: "no block here",
  });
  assert.deepEqual(parseSelectionBlock("<selections>\nbad line\n</selections>"), {
    selections: [],
    text: "",
  });
});

test("parseSelectionBlock strips leading blank lines after the block", () => {
  const raw = "<selections>\n- a.ts:1\n</selections>\n\nnext paragraph";
  const parsed = parseSelectionBlock(raw);
  assert.equal(parsed.text, "next paragraph");
});

test("parseSelectionToken round-trips through formatSelectionToken", () => {
  const original: LineRange[] = [
    { start: 1, end: 3 },
    { start: 7, end: 9 },
  ];
  const token = formatSelectionToken("a.ts", original);
  assert.ok(token);
  const parsed = parseSelectionToken(token);
  assert.ok(parsed);
  assert.equal(parsed.path, "a.ts");
  assert.deepEqual(parsed.ranges, original);
});

// --- buildSelectionContextBlock / buildSelectionPromptPrefix ---------------

test("buildSelectionContextBlock renders a deterministic listing", () => {
  const selections: SelectionMention[] = [
    {
      path: "server/lib/sessions.ts",
      ranges: [{ start: 42, end: 58 }],
      preview: "const x = 1;\nconst y = 2;",
    },
  ];
  const block = buildSelectionContextBlock(selections);
  assert.match(block, /<selections>/);
  assert.match(block, /- server\/lib\/sessions\.ts:42-58/);
  assert.match(block, /<\/selections>/);
});

test("buildSelectionContextBlock returns empty for an empty list", () => {
  assert.equal(buildSelectionContextBlock([]), "");
});

test("buildSelectionPromptPrefix includes a fenced snippet per selection", () => {
  const selections: SelectionMention[] = [
    {
      path: "server/lib/sessions.ts",
      ranges: [{ start: 42, end: 58 }],
      preview: "const x = 1;\nconst y = 2;",
    },
  ];
  const prefix = buildSelectionPromptPrefix(selections);
  assert.match(prefix, /### Selection: server\/lib\/sessions\.ts:42-58/);
  assert.match(prefix, /```/);
  assert.match(prefix, /const x = 1;/);
});

// --- truncatePreview -------------------------------------------------------

test("truncatePreview caps the line count to SELECTION_PREVIEW_LINE_LIMIT", () => {
  const preview = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const truncated = truncatePreview(preview);
  const lineCount = truncated.split("\n").length;
  assert.equal(lineCount, 50);
});

test("truncatePreview caps the byte count to SELECTION_PREVIEW_BYTE_LIMIT", () => {
  const preview = "x".repeat(8 * 1024);
  const truncated = truncatePreview(preview);
  assert.ok(truncated.length <= 4 * 1024);
});
