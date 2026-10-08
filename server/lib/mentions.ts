/*
 * Server-side resolver for `@`-mention chips (issue #312) and
 * line-range selection chips (issue #416).
 *
 * The client is the source of truth for what the user typed; this module
 * is the authorization + assembly layer. Every path is re-validated
 * against the active worktree root (a path the user typed in a different
 * project is not a path they can mention in this one), and the resolved
 * mention is rendered as a deterministic `<mentions>...</mentions>`
 * block. That block is prepended to the agent prompt *and* persisted to
 * history verbatim, so two runs that mention the same files produce
 * identical transcripts — the acceptance criterion for replay
 * determinism.
 *
 * The function is a pure transformation over the filesystem: it does
 * not touch the session/event store, and its output is the same
 * regardless of which provider is being spawned. That keeps the call
 * site (the session-start route) provider-agnostic and makes the
 * function easy to unit-test in isolation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseSelectionToken,
  buildSelectionContextBlock,
  buildSelectionPromptPrefix,
  type LineRange,
} from "../../shared/diff-selection.js";

export interface ResolvedMention {
  path: string;
  type: "file" | "directory";
}

/**
 * A selection chip seeded from a line-range gesture in a rendered
 * diff (issue #416). The client captures the snippet at click time
 * so the backend can include selection text in the prompt even
 * when the file no longer exists on disk (e.g. a deletion diff).
 */
export interface ResolvedSelection {
  path: string;
  ranges: LineRange[];
  preview: string;
}

export interface MentionResolution {
  /** Resolved mentions in the order the user requested them. */
  mentions: ResolvedMention[];
  /** Resolved selections in the order the user requested them. */
  selections: ResolvedSelection[];
  /**
   * Deterministic `<mentions>...</mentions>` block. Prepended to the
   * agent prompt AND persisted to history verbatim so two runs that
   * mention the same files produce identical prompts.
   */
  contextBlock: string;
  /**
   * Same block plus inline file/directory previews. The agent prompt
   * carries this; the persisted history carries only `contextBlock`
   * (no previews) so the transcript stays byte-identical across
   * runs of the same prompt.
   */
  prefix: string;
}

const MENTION_PREVIEW_LINE_LIMIT = 200;
const MENTION_PREVIEW_BYTE_LIMIT = 8 * 1024;

/**
 * Resolve a list of `@`-mentions against a worktree. Each path is
 * re-validated against the worktree root and a short preview is inlined
 * so the agent can ground its response without an extra round trip.
 *
 * Errors are non-fatal: a missing or unreadable mention is recorded as
 * a one-line annotation in the block rather than failing the whole
 * turn. The user is more likely to fix the path on the next turn than
 * to retry from scratch, and the resolved block still tells the agent
 * what was intended.
 *
 * `selections` (issue #416) is an optional list of line-range
 * selection chips seeded from a rendered diff. Each chip carries the
 * client-captured preview, so the resolver does not re-read the file
 * (this is the only way to surface a snippet for a deletion diff
 * where the path no longer exists on disk). The same worktree-root
 * boundary check applies; out-of-tree selections are dropped silently.
 */
export async function resolveMentions(
  worktreePath: string,
  mentions: ResolvedMention[],
  selections: ResolvedSelection[] = []
): Promise<MentionResolution> {
  if (mentions.length === 0 && selections.length === 0) {
    return { mentions: [], selections: [], contextBlock: "", prefix: "" };
  }
  const resolved: ResolvedMention[] = [];
  const annotationLines: string[] = [];
  for (const mention of mentions) {
    const cleaned = mention.path.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!cleaned) continue;
    // Path-safety check. The original implementation rejected any
    // character outside `[A-Za-z0-9._/-]`, which is over-restrictive:
    // real repo paths can contain spaces, `+`, `()`, `,`, `:`, or
    // non-ASCII characters (`docs/API guide.md`,
    // `テスト/ファイル.md`, `package@1.0/README.md`). The actual
    // safety guarantee comes from `realpath` + the worktree-root
    // boundary check below; the regex here only exists to reject
    // input that would obviously break the resolver's own logic
    // (null bytes, embedded NULs, control characters, backslashes
    // that hint at Windows-style paths on a POSIX system). Length
    // is also bounded so a pathological input can't blow the
    // annotation line buffer.
    if (cleaned.length > 4096) {
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: path too long)`,
      );
      continue;
    }
    if (/[\0\u0000-\u001f\\]/.test(cleaned)) {
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: invalid path)`,
      );
      continue;
    }
    const absolutePath = path.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(worktreePath, cleaned);
    try {
      const [targetRealPath, worktreeRealPath] = await Promise.all([
        fs.realpath(absolutePath),
        fs.realpath(worktreePath),
      ]);
      const relativeToWorktree = path.relative(
        worktreeRealPath,
        targetRealPath
      );
      const isInsideWorktree =
        relativeToWorktree === "" ||
        (!relativeToWorktree.startsWith("..") &&
          !path.isAbsolute(relativeToWorktree));
      if (!isInsideWorktree) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: outside worktree)`
        );
        continue;
      }
      const stat = await fs.stat(targetRealPath);
      if (mention.type === "directory" && !stat.isDirectory()) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not a directory)`
        );
        continue;
      }
      if (mention.type === "file" && !stat.isFile()) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not a file)`
        );
        continue;
      }
      resolved.push({ path: relativeToWorktree || cleaned, type: mention.type });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not found)`
        );
        continue;
      }
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: ${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
  }
  if (
    resolved.length === 0 &&
    annotationLines.length === 0 &&
    selections.length === 0
  ) {
    return { mentions: [], selections: [], contextBlock: "", prefix: "" };
  }
  // Resolve line-range selections (issue #416). The same worktree-root
  // boundary check applies; out-of-tree selections are dropped
  // silently. We do not re-read the file — the client captured the
  // preview at click time so the snippet is available even when the
  // path no longer exists on disk (deletion diffs, mid-edit captures).
  const resolvedSelections: ResolvedSelection[] = [];
  const selectionAnnotations: string[] = [];
  let worktreeRealPath: string | null = null;
  if (selections.length > 0) {
    try {
      worktreeRealPath = await fs.realpath(worktreePath);
    } catch {
      // If the worktree itself is unreadable we cannot resolve
      // selections safely; record a single annotation and skip.
      selectionAnnotations.push(
        `- selections skipped: worktree not readable`,
      );
    }
  }
  for (const selection of selections) {
    if (!worktreeRealPath) break;
    const cleaned = selection.path.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!cleaned) continue;
    if (cleaned.length > 4096) {
      selectionAnnotations.push(
        `- ${cleaned} (skipped: path too long)`,
      );
      continue;
    }
    if (/[\0\u0000-\u001f\\]/.test(cleaned)) {
      selectionAnnotations.push(
        `- ${selection.path} (skipped: invalid path)`,
      );
      continue;
    }
    const absolutePath = path.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(worktreePath, cleaned);
    try {
      const targetRealPath = await fs.realpath(absolutePath);
      const relativeToWorktree = path.relative(
        worktreeRealPath,
        targetRealPath
      );
      const isInsideWorktree =
        relativeToWorktree === "" ||
        (!relativeToWorktree.startsWith("..") &&
          !path.isAbsolute(relativeToWorktree));
      if (!isInsideWorktree) {
        selectionAnnotations.push(
          `- ${selection.path} (skipped: outside worktree)`,
        );
        continue;
      }
      resolvedSelections.push({
        path: relativeToWorktree || cleaned,
        ranges: selection.ranges,
        preview: selection.preview,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // The path no longer exists on disk — the normal case for a
        // selection made on a deletion diff. This is exactly what the
        // client-captured preview is for, so keep the chip. The
        // worktree boundary is still enforced: we realpath the
        // deepest *existing* ancestor (so a symlinked parent can't
        // smuggle the path outside) and check containment of the
        // re-joined path. `absolutePath` came through `path.resolve`,
        // so it carries no `..` segments.
        const contained = await resolveMissingPathWithinWorktree(
          worktreeRealPath,
          absolutePath,
        );
        if (contained) {
          resolvedSelections.push({
            path: contained,
            ranges: selection.ranges,
            preview: selection.preview,
          });
        } else {
          selectionAnnotations.push(
            `- ${selection.path} (skipped: outside worktree)`,
          );
        }
        continue;
      }
      selectionAnnotations.push(
        `- ${selection.path} (skipped: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
  // Assemble the `<mentions>` block first (existing behavior) then
  // append a sibling `<selections>` block when selections are
  // present. Keeping the two blocks separate keeps the wire format
  // additive — old transcripts without a `<selections>` block keep
  // re-parsing correctly.
  const blocks: string[] = [];
  const prefixBlocks: string[] = [];
  if (resolved.length > 0 || annotationLines.length > 0) {
    const header = [
      "<mentions>",
      "The user referenced the following paths in the active worktree. Each",
      "preview is a short snippet; the agent's file-reading tools can resolve",
      "the full file by joining the path with the worktree root.",
    ];
    const bodyLines = [
      ...resolved.map((mention) => `- ${mention.type}: ${mention.path}`),
      ...annotationLines,
    ];
    blocks.push([...header, ...bodyLines, "</mentions>"].join("\n"));
    const previewLines: string[] = [];
    for (const mention of resolved) {
      if (mention.type === "file") {
        try {
          const absolutePath = path.resolve(worktreePath, mention.path);
          const handle = await fs.open(absolutePath, "r");
          try {
            const buffer = Buffer.alloc(MENTION_PREVIEW_BYTE_LIMIT);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const raw = buffer.subarray(0, bytesRead).toString("utf-8");
            const lines = raw.split("\n").slice(0, MENTION_PREVIEW_LINE_LIMIT);
            const preview = lines.join("\n");
            previewLines.push(
              `--- ${mention.path} (first ${lines.length} line(s)) ---\n${preview}`
            );
          } finally {
            await handle.close();
          }
        } catch {
          // The agent can read the file itself; don't fail the turn.
        }
      } else {
        try {
          const absolutePath = path.resolve(worktreePath, mention.path);
          const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
          const names = dirents
            .filter((entry) => entry.isDirectory() || entry.isFile())
            .map((entry) =>
              entry.isDirectory() ? `${entry.name}/` : entry.name
            )
            .slice(0, 200);
          previewLines.push(
            `--- ${mention.path}/ (${names.length} entries) ---\n${names.join("\n")}`
          );
        } catch {
          // As above, leave the block to the agent.
        }
      }
    }
    if (previewLines.length > 0) {
      prefixBlocks.push(`${blocks[blocks.length - 1]}\n\n${previewLines.join("\n\n")}\n`);
    } else {
      prefixBlocks.push(blocks[blocks.length - 1]);
    }
  }
  if (resolvedSelections.length > 0 || selectionAnnotations.length > 0) {
    const selectionsBlock = buildSelectionContextBlock(
      resolvedSelections,
    );
    if (selectionsBlock) blocks.push(selectionsBlock);
    if (selectionAnnotations.length > 0) {
      const annotated = selectionAnnotations.map((line) => `  ${line}`).join("\n");
      blocks.push(`<selection-annotations>\n${annotated}\n</selection-annotations>`);
    }
    const selectionsPrefix = buildSelectionPromptPrefix(resolvedSelections);
    if (selectionsPrefix) prefixBlocks.push(selectionsPrefix);
  }
  const contextBlock = blocks.join("\n\n");
  const prefix = prefixBlocks.join("\n\n");
  return {
    mentions: resolved,
    selections: resolvedSelections,
    contextBlock,
    prefix,
  };
}

/**
 * Parse the `mentions` query param shared by the SSE and headless
 * session-start routes. The wire format is `path|type,path|type,…`;
 * missing or unknown `type` values default to `file` so a hand-crafted
 * URL still parses. Malformed rows (empty path, non-string) are
 * dropped silently — the orchestrator is the source of truth, and a
 * bad row should not fail the whole turn.
 */
export function parseMentionsQuery(
  raw: string | string[] | undefined
): ResolvedMention[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((entry) => {
      const [pathValue, typeValue] = entry.split("|");
      if (typeof pathValue !== "string" || !pathValue.trim()) return null;
      const type: "file" | "directory" =
        typeValue === "directory" ? "directory" : "file";
      return { path: pathValue.trim(), type };
    })
    .filter((value): value is ResolvedMention => value !== null);
}

/**
 * Walk up from a non-existent `absolutePath` to the deepest ancestor
 * that still exists on disk, realpath that ancestor (the same symlink
 * hardening the existing-path branch gets from realpathing the target
 * itself), re-join the missing segments, and return the
 * worktree-relative path when the result stays inside the worktree —
 * `null` otherwise. This keeps deletion-diff selections alive: the
 * file is gone, but the chip's client-captured preview is still valid
 * and the boundary check must not depend on the leaf existing.
 * `absolutePath` must already be normalized (`path.resolve`), so it
 * carries no `..` segments the re-join could resurrect.
 */
async function resolveMissingPathWithinWorktree(
  worktreeRealPath: string,
  absolutePath: string
): Promise<string | null> {
  let ancestor = path.dirname(absolutePath);
  const missing: string[] = [path.basename(absolutePath)];
  for (;;) {
    try {
      const ancestorRealPath = await fs.realpath(ancestor);
      const candidate = path.join(ancestorRealPath, ...missing);
      const relativeToWorktree = path.relative(worktreeRealPath, candidate);
      const isInsideWorktree =
        relativeToWorktree !== "" &&
        !relativeToWorktree.startsWith("..") &&
        !path.isAbsolute(relativeToWorktree);
      return isInsideWorktree ? relativeToWorktree : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Parse the `selections` query param (issue #416). The wire format is
 * one `encodedToken|previewBase64` entry per chip, joined by commas,
 * where `encodedToken` is `encodeURIComponent("path:start-end[,…]")`.
 * The token is URI-encoded because it can itself contain commas
 * (multi-range chips like `a.ts:42,57,61-65`, or a path with a
 * comma); the preview is base64-encoded so commas and newlines
 * inside the snippet don't break the comma split. Empty / malformed
 * rows are dropped silently; the composer is the source of truth and
 * a bad row should never fail the whole turn. The encoder is
 * `encodeSelectionsWire` in `shared/diff-selection.ts`.
 */
export function parseSelectionsQuery(
  raw: string | string[] | undefined
): ResolvedSelection[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((entry) => {
      const lastPipe = entry.lastIndexOf("|");
      if (lastPipe === -1) return null;
      let token: string;
      try {
        token = decodeURIComponent(entry.slice(0, lastPipe));
      } catch {
        return null;
      }
      const previewB64 = entry.slice(lastPipe + 1);
      const parsed = parseSelectionToken(token);
      if (!parsed) return null;
      let preview = "";
      if (previewB64) {
        try {
          preview = Buffer.from(previewB64, "base64").toString("utf-8");
        } catch {
          preview = "";
        }
      }
      return { path: parsed.path, ranges: parsed.ranges, preview };
    })
    .filter((value): value is ResolvedSelection => value !== null);
}
