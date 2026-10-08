/*
 * Helpers for line-range selection chips seeded from a diff (issue #416).
 *
 * The user selects one or more lines in a rendered diff and the gesture
 * becomes a mention chip in the composer. The wire format is a strict
 * superset of the `@`-mention token from #312: a selection chip is
 * `path:start-end` for a contiguous range, `path:42` for a single
 * line, or `path:42,57,61-65` for a non-contiguous multi-range
 * selection. The single-path chip is the only shape the backend ever
 * needs to resolve; the multi-range shape is collapsed to the union
 * of ranges when the chip is sent so the agent prompt and persisted
 * history stay byte-identical across re-renders.
 *
 * Why a dedicated module: the chip is parsed and serialized in three
 * places (composer render, persisted-history parser, backend
 * resolver) and the format is the only contract between them. Keeping
 * the format logic in one place — and covered by unit tests — is the
 * cheapest way to keep the three callers honest.
 */

/**
 * A single contiguous range of line numbers in a file. `start` and
 * `end` are inclusive and one-based to match the line numbers the
 * diff renderer already prints in the gutter.
 */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * A mention chip seeded from a line selection in a rendered diff.
 * The `path` is the repo-relative path the chip references; `ranges`
 * is the list of contiguous line ranges the user picked. The
 * `preview` is the client-captured snippet (capped — see
 * SELECTION_PREVIEW_LINE_LIMIT below) so the backend can include
 * selection text in the prompt even when the file no longer exists
 * on disk (e.g. a deletion diff).
 */
export interface SelectionMention {
  path: string;
  ranges: LineRange[];
  /** Plain-text preview captured client-side at selection time. */
  preview: string;
}

const MAX_RANGES_PER_CHIP = 32;
/** Cap on preview size — matches the byte cap on @-mention previews. */
export const SELECTION_PREVIEW_LINE_LIMIT = 50;
export const SELECTION_PREVIEW_BYTE_LIMIT = 4 * 1024;

/**
 * Normalize a list of user-selected ranges into the canonical form:
 *  - each range is collapsed to `[min(start,end), max(start,end)]`,
 *  - ranges are sorted by start, and overlapping / adjacent ranges
 *    are merged (so `5-10` and `11-12` collapse to `5-12`).
 * Returns `null` if the input is empty or every range is invalid
 * (non-positive line numbers). This is the function the diff
 * renderer calls before a chip is inserted into the composer; the
 * canonical form keeps the token stable across re-renders and
 * across users who click the same lines in different orders.
 */
export function normalizeRanges(ranges: LineRange[]): LineRange[] | null {
  if (ranges.length === 0) return null;
  const cleaned: LineRange[] = [];
  for (const range of ranges) {
    const start = Math.floor(range.start);
    const end = Math.floor(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 1 || end < 1) continue;
    cleaned.push({ start: Math.min(start, end), end: Math.max(start, end) });
  }
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const range of cleaned) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Render a normalized list of ranges as the trailing portion of a
 * selection token. The caller prepends the path and colon. The
 * output is deterministic — sorted, deduped — so two selections of
 * the same lines always serialize to the same chip.
 *
 * Examples:
 *   [{start:42,end:42}]  -> "42"
 *   [{start:42,end:58}]  -> "42-58"
 *   [{start:42,end:58},{start:61,end:65}]  -> "42-58,61-65"
 */
export function formatRanges(ranges: LineRange[]): string {
  return ranges
    .map((range) =>
      range.start === range.end ? String(range.start) : `${range.start}-${range.end}`,
    )
    .join(",");
}

/**
 * Build the full selection token (`path:start-end[,start-end...]`)
 * for a normalized list of ranges. Returns `null` if the input is
 * empty or not yet normalized.
 */
export function formatSelectionToken(path: string, ranges: LineRange[]): string | null {
  const normalized = normalizeRanges(ranges);
  if (!normalized) return null;
  if (normalized.length > MAX_RANGES_PER_CHIP) return null;
  return `${path}:${formatRanges(normalized)}`;
}

/**
 * Token regex. We deliberately keep the path part permissive
 * (letters, digits, dot, dash, underscore, slash, plus) because real
 * paths can contain spaces, parentheses, or non-ASCII characters.
 * The match is anchored to the start of the string so a token
 * embedded mid-prose is rejected — chips must be inserted by the
 * composer machinery, not hand-typed.
 *
 *   ^                  start
 *   ([^:\n]+?)         path (non-greedy, must not contain colon or newline)
 *   :                  colon
 *   (\d+(?:-\d+)?      one range: "42" or "42-58"
 *   (?:,\d+(?:-\d+)?)* zero or more additional ranges
 *   )$
 */
const SELECTION_TOKEN = /^([^:\n]+?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/;

/**
 * Parse a `path:start-end[,start-end...]` selection token. Returns
 * `null` for tokens that don't match the selection shape — callers
 * (the backend resolver, the history re-render) treat those as
 * regular file mentions and let the existing resolver handle them.
 *
 * The path is returned verbatim; the caller is responsible for
 * worktree-root resolution.
 */
export function parseSelectionToken(token: string): {
  path: string;
  ranges: LineRange[];
} | null {
  const match = SELECTION_TOKEN.exec(token);
  if (!match) return null;
  const path = match[1].trim();
  if (!path) return null;
  const rawRanges = match[2].split(",");
  const ranges: LineRange[] = [];
  for (const segment of rawRanges) {
    const dash = segment.indexOf("-");
    if (dash === -1) {
      const line = parseInt(segment, 10);
      if (!Number.isFinite(line) || line < 1) return null;
      ranges.push({ start: line, end: line });
    } else {
      const start = parseInt(segment.slice(0, dash), 10);
      const end = parseInt(segment.slice(dash + 1), 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (start < 1 || end < 1) return null;
      ranges.push({ start: Math.min(start, end), end: Math.max(start, end) });
    }
  }
  const normalized = normalizeRanges(ranges);
  if (!normalized) return null;
  return { path, ranges: normalized };
}

/**
 * Parse a `<selections>...</selections>` block the backend prepends
 * to the persisted history. The block is generated by
 * `buildSelectionContextBlock`; this parser is the inverse used to
 * re-render the chips in the user message bubble on reload. Lines
 * that don't match `- path:start-end[,start-end...]` are skipped so
 * a hand-edited transcript can't crash the renderer.
 *
 * The trailing separator (`\n` or `\n\n` between the block and the
 * next paragraph — typically the mention block, the skill marker
 * chain, or the user payload) is consumed so the rest of the
 * pipeline (`parseMentionBlock`, `parseSkillMarkers`, the
 * markdown view) sees a clean, unindented payload. Without this,
 * the next parser would have to skip a leading newline before its
 * leading-anchored regex matched.
 */
export function parseSelectionBlock(rawText: string): {
  selections: { path: string; ranges: LineRange[] }[];
  text: string;
} {
  const match = /^[ \t]*<selections>\n([\s\S]*?)\n[ \t]*<\/selections>[ \t]*\n?/.exec(
    rawText,
  );
  if (!match) return { selections: [], text: rawText };
  const selections: { path: string; ranges: LineRange[] }[] = [];
  for (const line of match[1].split("\n")) {
    const entry = /^[ \t]*-[ \t]+([^\n]+?)[ \t]*$/.exec(line);
    if (!entry) continue;
    const parsed = parseSelectionToken(entry[1]);
    if (!parsed) continue;
    selections.push(parsed);
  }
  const rest = rawText.slice(match[0].length).replace(/^\n+/, "");
  return { selections, text: rest };
}

/**
 * Build the deterministic `<selections>...</selections>` block the
 * backend prepends to the agent prompt. Mirrors
 * `buildMentionContextBlock` from the `@`-mention picker so the
 * resolved block is reproducible across runs.
 *
 * The block lists each selection as `- path:start-end` and adds
 * `### Selection: path:start-end` headers above the inlined snippet
 * so the agent can refer back to a specific span by name. The
 * persisted history carries only the listing (no previews) so the
 * transcript stays byte-identical across runs; the agent prompt
 * additionally carries the snippets as a `prefix`.
 */
export function buildSelectionContextBlock(selections: SelectionMention[]): string {
  if (selections.length === 0) return "";
  const lines: string[] = [
    "<selections>",
    "The user anchored this message to specific line ranges in the",
    "active worktree. Resolve each path with the worktree root as the",
    "base directory.",
  ];
  for (const selection of selections) {
    const token = formatSelectionToken(selection.path, selection.ranges);
    if (!token) continue;
    lines.push(`- ${token}`);
  }
  lines.push("</selections>");
  return lines.join("\n");
}

/**
 * Same block plus the inlined snippet for the agent prompt. The
 * snippet is captured client-side, so this function never re-reads
 * the file. That matters for deletion diffs (the path no longer
 * exists) and for selections captured mid-edit (the on-disk content
 * may have shifted by the time the prompt is assembled).
 */
export function buildSelectionPromptPrefix(selections: SelectionMention[]): string {
  const block = buildSelectionContextBlock(selections);
  if (selections.length === 0) return "";
  const bodies: string[] = [];
  for (const selection of selections) {
    const token = formatSelectionToken(selection.path, selection.ranges);
    if (!token) continue;
    const preview = truncatePreview(selection.preview);
    if (!preview) continue;
    bodies.push(`### Selection: ${token}\n\`\`\`\n${preview}\n\`\`\``);
  }
  if (bodies.length === 0) return block;
  return `${block}\n\n${bodies.join("\n\n")}\n`;
}

/**
 * Cap a preview to the documented line + byte budget so a
 * pathological selection (10k lines) doesn't blow the agent prompt
 * or the persisted history.
 */
export function truncatePreview(preview: string): string {
  const lines = preview.split("\n").slice(0, SELECTION_PREVIEW_LINE_LIMIT);
  let text = lines.join("\n");
  if (text.length > SELECTION_PREVIEW_BYTE_LIMIT) {
    text = text.slice(0, SELECTION_PREVIEW_BYTE_LIMIT);
  }
  return text;
}
