/*
 * Controller-owned memory layer (issue #350).
 *
 * Memory is a small, app-owned surface where the user (and the agent, on
 * request) can persist facts that survive across sessions: preferences,
 * conventions, deploy processes, "we agreed X". It is *explicit* — every
 * note is a Markdown file the user can see and edit — and *visible* — the
 * Settings → Memory panel is the editorial control, not a hidden sidecar.
 *
 * On-disk shape (see `server/lib/paths.ts`):
 *
 *   <controllerHome>/memory/
 *     global/
 *       pinned.md            # injected verbatim into every turn preamble
 *       notes/<slug>.md      # individual global facts (one file per note)
 *     projects/<projectId>/
 *       pinned.md            # injected when the active session is in this project
 *       notes/<slug>.md      # individual project facts (one file per note)
 *
 * The retrieval backend sits behind a `MemoryBackend` interface so a
 * future `ZgMemoryBackend` (or anything else) can be swapped in without
 * touching the routes, the preamble, or the Settings panel. The v0
 * implementation is `RgMemoryBackend`, which uses `rg` when available
 * and falls back to a Node `fs.readFile` substring scan. A no-op
 * `NullMemoryBackend` is exposed so a deployment that explicitly opts
 * out still has a backend to install.
 *
 * Selection between backends is driven by the `CONTROLLER_MEMORY_BACKEND`
 * env var (`auto` | `rg` | `null`, default `auto`); `auto` picks `rg`
 * today and `zg` once it's available.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  memoryDir,
  memoryNoteFile,
  memoryPinnedFile,
  memoryScopeDir,
  orchestratorHome,
} from "./paths.js";

/** Valid slug characters. Same charset as unified-skill names so users get one mental model. */
export const MEMORY_SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Maximum length for a memory note slug. */
export const MEMORY_SLUG_MAX_LENGTH = 96;

/** Maximum length for a memory note body. */
export const MEMORY_CONTENT_MAX_LENGTH = 64 * 1024;

/** Maximum length for a `pinned.md` body. */
export const MEMORY_PINNED_MAX_LENGTH = 16 * 1024;

/** Pre-allocated preview length for `MemoryEntry.preview`. */
export const MEMORY_PREVIEW_CHARS = 80;

export type MemoryScope = "global" | "project";

/** Public entry shape used by the routes and the agent preamble. */
export interface MemoryEntry {
  /** Filename stem — the slug the user sees and the agent passes to `read`. */
  slug: string;
  scope: MemoryScope;
  /** Project id when `scope === "project"`, otherwise omitted. */
  projectId?: string;
  /** First line of the note, truncated to ~80 chars. */
  preview: string;
  /** File mtime in ms — used to sort the listing (newest first). */
  mtimeMs: number;
}

export interface MemoryNote extends MemoryEntry {
  content: string;
}

export interface MemorySearchResult {
  slug: string;
  scope: MemoryScope;
  projectId?: string;
  preview: string;
}

/** Pluggable search interface. */
export interface MemoryBackend {
  search(args: {
    scope: MemoryScope;
    projectId?: string;
    query: string;
    limit?: number;
  }): Promise<MemorySearchResult[]>;
}

/**
 * The v0 backend. Uses `rg` if it's on `PATH`, otherwise falls back to a
 * Node substring scan. Both code paths produce the same `preview` shape so
 * callers don't have to special-case either.
 */
export class RgMemoryBackend implements MemoryBackend {
  async search(args: {
    scope: MemoryScope;
    projectId?: string;
    query: string;
    limit?: number;
  }): Promise<MemorySearchResult[]> {
    const trimmed = args.query.trim();
    if (!trimmed) return [];
    const scopeDir = memoryScopeDir(args.scope, args.projectId);
    const notesDir = path.join(scopeDir, "notes");
    const limit = Math.max(1, Math.min(args.limit ?? 10, 50));

    // Two-stage lookup: filename hit first (a note literally named after
    // the query is the most relevant result), then content hit. Both
    // stages are scoped to the requested scope, so global and project
    // never bleed.
    const filenameHits = await this.searchFilenames(notesDir, trimmed, limit);
    if (filenameHits.length > 0) return filenameHits;
    return this.searchContent(notesDir, trimmed, limit, args.scope, args.projectId);
  }

  private async searchFilenames(
    notesDir: string,
    query: string,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    let names: string[];
    try {
      names = await fs.readdir(notesDir);
    } catch {
      return [];
    }
    const lower = query.toLowerCase();
    return names
      .filter((name) => name !== "pinned.md" && name.toLowerCase().includes(lower))
      .slice(0, limit)
      .map((name) => ({
        slug: name.replace(/\.md$/, ""),
        scope: path.basename(path.dirname(notesDir)) === "global" ? "global" : ("project" as MemoryScope),
        projectId: path.basename(path.dirname(notesDir)) === "global" ? undefined : path.basename(path.dirname(notesDir)),
        preview: "",
      }));
  }

  private async searchContent(
    notesDir: string,
    query: string,
    limit: number,
    scope: MemoryScope,
    projectId: string | undefined,
  ): Promise<MemorySearchResult[]> {
    // Try `rg` first; it's the documented v0 path and a fast substring
    // search across all notes. When `rg` isn't installed we fall back to
    // a Node-side scan that reads every note — slow on a large catalog
    // but never returns wrong results.
    const rgResult = await this.runRg(notesDir, query, limit, scope, projectId);
    if (rgResult !== null) return rgResult;
    return this.fallbackScan(notesDir, query, limit, scope, projectId);
  }

  private async runRg(
    notesDir: string,
    query: string,
    limit: number,
    scope: MemoryScope,
    projectId: string | undefined,
  ): Promise<MemorySearchResult[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: MemorySearchResult[] | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn("rg", ["-l", "--no-heading", "--", query, notesDir]);
      } catch {
        settle(null);
        return;
      }
      child.on("error", () => settle(null));
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.on("close", (code) => {
        if (code === null || code > 1) {
          // `rg` exits 1 on no matches, >1 on a real error (e.g. binary
          // missing on systems where spawn didn't error). Either way,
          // fall back to the Node scan so a missing match isn't silently
          // misreported.
          settle(null);
          return;
        }
        const text = Buffer.concat(out).toString("utf-8");
        const lines = text.split("\n").filter(Boolean);
        const hits: MemorySearchResult[] = [];
        for (const line of lines) {
          if (hits.length >= limit) break;
          const slug = path.basename(line).replace(/\.md$/, "");
          if (!slug) continue;
          hits.push({
            slug,
            scope,
            projectId: scope === "project" ? projectId : undefined,
            preview: "",
          });
        }
        settle(hits);
      });
    });
  }

  private async fallbackScan(
    notesDir: string,
    query: string,
    limit: number,
    scope: MemoryScope,
    projectId: string | undefined,
  ): Promise<MemorySearchResult[]> {
    let names: string[];
    try {
      names = await fs.readdir(notesDir);
    } catch {
      return [];
    }
    const lower = query.toLowerCase();
    const hits: MemorySearchResult[] = [];
    for (const name of names) {
      if (hits.length >= limit) break;
      if (!name.endsWith(".md")) continue;
      if (name === "pinned.md") continue; // defensive: stray pinned.md in notes/ must never surface
      let body: string;
      try {
        body = await fs.readFile(path.join(notesDir, name), "utf-8");
      } catch {
        continue;
      }
      const matchIdx = body.toLowerCase().indexOf(lower);
      if (matchIdx < 0) continue;
      const preview = buildPreview(body, matchIdx);
      hits.push({
        slug: name.replace(/\.md$/, ""),
        scope,
        projectId: scope === "project" ? projectId : undefined,
        preview,
      });
    }
    return hits;
  }
}

/** No-op backend used when the operator explicitly disables memory. */
export class NullMemoryBackend implements MemoryBackend {
  async search(): Promise<MemorySearchResult[]> {
    return [];
  }
}

let cachedBackend: MemoryBackend | null = null;
let cachedBackendKey: string | null = null;

/** Pick a backend per the `CONTROLLER_MEMORY_BACKEND` env var. */
export function getMemoryBackend(): MemoryBackend {
  const setting = (process.env.CONTROLLER_MEMORY_BACKEND ?? "auto").trim().toLowerCase();
  const key = `${setting}|${process.env.PATH ?? ""}`;
  if (cachedBackend && cachedBackendKey === key) return cachedBackend;

  if (setting === "null" || setting === "off" || setting === "disabled") {
    cachedBackend = new NullMemoryBackend();
  } else {
    // `auto` and `rg` both resolve to the rg-backed implementation today.
    // When the `zg`-backed v1 lands, the `auto` branch will check for
    // `zg` first and prefer it; `rg` stays explicit for users who want
    // to lock the backend.
    cachedBackend = new RgMemoryBackend();
  }
  cachedBackendKey = key;
  return cachedBackend;
}

/** Test seam: reset the cached backend so a different env var is picked up. */
export function resetMemoryBackendForTests(): void {
  cachedBackend = null;
  cachedBackendKey = null;
}

// ---------------------------------------------------------------------------
// CRUD — user-facing, parallel to `unified-skills.ts`.
// ---------------------------------------------------------------------------

/** Validate a slug; returns a human-readable error or `null` when valid. */
export function validateMemorySlug(slug: string): string | null {
  const trimmed = slug.trim();
  if (!trimmed) return "Memory slug is required.";
  if (trimmed.length > MEMORY_SLUG_MAX_LENGTH) {
    return `Memory slug must be ${MEMORY_SLUG_MAX_LENGTH} characters or fewer (got ${trimmed.length}).`;
  }
  if (!MEMORY_SLUG_RE.test(trimmed)) {
    return "Memory slug may only contain letters, numbers, dots, dashes, and underscores.";
  }
  if (trimmed.startsWith(".") || trimmed.startsWith("-")) {
    return "Memory slug must not start with a dot or dash.";
  }
  return null;
}

function validateContent(content: string, max: number, label: string): string | null {
  if (typeof content !== "string") return `${label} is required.`;
  if (content.length > max) {
    return `${label} must be ${max} characters or fewer (got ${content.length}).`;
  }
  return null;
}

/** List every note in a scope, sorted newest-first by mtime. */
export async function listMemory(args: {
  scope: MemoryScope;
  projectId?: string;
}): Promise<MemoryEntry[]> {
  const notesDir = path.join(memoryScopeDir(args.scope, args.projectId), "notes");
  let names: string[];
  try {
    names = await fs.readdir(notesDir);
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    if (name === "pinned.md") continue; // defensive: a stray pinned.md in notes/ must never surface
    const slug = name.replace(/\.md$/, "");
    const file = path.join(notesDir, name);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    let body = "";
    try {
      body = await fs.readFile(file, "utf-8");
    } catch {
      body = "";
    }
    out.push({
      slug,
      scope: args.scope,
      projectId: args.scope === "project" ? args.projectId : undefined,
      preview: buildPreview(body, 0),
      mtimeMs: stat.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Read one note. Returns `null` when the slug doesn't exist. */
export async function readMemory(args: {
  scope: MemoryScope;
  slug: string;
  projectId?: string;
}): Promise<MemoryNote | null> {
  const err = validateMemorySlug(args.slug);
  if (err) return null;
  const file = memoryNoteFile(args.scope, args.slug, args.projectId);
  let body: string;
  try {
    body = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    stat = null;
  }
  return {
    slug: args.slug,
    scope: args.scope,
    projectId: args.scope === "project" ? args.projectId : undefined,
    preview: buildPreview(body, 0),
    mtimeMs: stat?.mtimeMs ?? 0,
    content: body,
  };
}

/** Write a note. Overwrites any existing note with the same slug. */
export async function writeMemory(args: {
  scope: MemoryScope;
  slug: string;
  content: string;
  projectId?: string;
}): Promise<{ ok: true } | { error: string }> {
  const slugErr = validateMemorySlug(args.slug);
  if (slugErr) return { error: slugErr };
  const contentErr = validateContent(args.content, MEMORY_CONTENT_MAX_LENGTH, "Memory content");
  if (contentErr) return { error: contentErr };
  const file = memoryNoteFile(args.scope, args.slug, args.projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content, "utf-8");
  return { ok: true };
}

/** Delete a note. Missing notes are treated as success. */
export async function deleteMemory(args: {
  scope: MemoryScope;
  slug: string;
  projectId?: string;
}): Promise<void> {
  const err = validateMemorySlug(args.slug);
  if (err) return;
  const file = memoryNoteFile(args.scope, args.slug, args.projectId);
  await fs.rm(file, { force: true });
}

/** Read the per-scope `pinned.md`. Returns `""` when the file is absent. */
export async function readPinnedMemory(args: {
  scope: MemoryScope;
  projectId?: string;
}): Promise<string> {
  const file = memoryPinnedFile(args.scope, args.projectId);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return "";
  }
}

/** Write the per-scope `pinned.md`. */
export async function writePinnedMemory(args: {
  scope: MemoryScope;
  content: string;
  projectId?: string;
}): Promise<{ ok: true } | { error: string }> {
  const contentErr = validateContent(args.content, MEMORY_PINNED_MAX_LENGTH, "Pinned content");
  if (contentErr) return { error: contentErr };
  const file = memoryPinnedFile(args.scope, args.projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content, "utf-8");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Preamble integration (issue #350).
// ---------------------------------------------------------------------------

/**
 * Render the `<memory>` block that gets injected into the per-turn
 * preamble. The block is a manifest, not a body dump — the agent sees
 * the pinned snippets (which are exactly the case where "always
 * injected" is correct) plus a `slug + scope + 80-char preview` index
 * of every note. Full bodies are fetched on demand via the CLI.
 *
 * When both `pinnedGlobal` and the scope's note list are empty, the
 * caller should skip the block entirely (an empty `<memory></memory>`
 * tag is just noise). This helper always renders something because
 * the agent's job is to teach the user the surface exists.
 */
export async function buildMemoryBlock(args: {
  projectId?: string;
}): Promise<string> {
  const [pinnedGlobal, globalNotes, pinnedProject, projectNotes] = await Promise.all([
    readPinnedMemory({ scope: "global" }),
    listMemory({ scope: "global" }),
    args.projectId ? readPinnedMemory({ scope: "project", projectId: args.projectId }) : Promise.resolve(""),
    args.projectId
      ? listMemory({ scope: "project", projectId: args.projectId })
      : Promise.resolve([] as MemoryEntry[]),
  ]);

  const lines: string[] = ["<memory>"];
  lines.push(
    "<pinned_global>",
    pinnedGlobal.trim() ? pinnedGlobal.trimEnd() : "(empty)",
    "</pinned_global>",
  );
  if (args.projectId) {
    lines.push(
      "<pinned_project>",
      pinnedProject.trim()
        ? pinnedProject.trimEnd()
        : "(empty — no project memory yet)",
      "</pinned_project>",
    );
  }
  lines.push("<memory_index>");
  for (const entry of [...globalNotes, ...projectNotes]) {
    const scope = entry.scope === "global" ? "global" : `project:${entry.projectId}`;
    lines.push(`- ${scope} | ${entry.slug} | ${entry.preview}`);
  }
  if (globalNotes.length === 0 && projectNotes.length === 0) {
    lines.push("(no notes yet)");
  }
  lines.push("</memory_index>", "</memory>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Build a one-line preview of a memory note. The first call (index 0)
 * uses the first non-empty line so the user sees something meaningful
 * instead of the frontmatter or a blank line. A non-zero `matchIdx`
 * (the content search path) builds a window around the matched query
 * so the agent can see why a note was returned.
 */
export function buildPreview(body: string, matchIdx: number): string {
  if (!body) return "";
  if (matchIdx <= 0) {
    // First non-empty line, truncated.
    const newline = body.indexOf("\n");
    const first = newline >= 0 ? body.slice(0, newline) : body;
    return truncate(first.trim(), MEMORY_PREVIEW_CHARS);
  }
  const start = Math.max(0, matchIdx - 20);
  const end = Math.min(body.length, matchIdx + MEMORY_PREVIEW_CHARS);
  const window = body.slice(start, end).replace(/\s+/g, " ").trim();
  return truncate(window, MEMORY_PREVIEW_CHARS);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Ensure the `memory/` root directory exists. Idempotent; safe to call on startup. */
export async function ensureMemoryDirs(): Promise<void> {
  await fs.mkdir(memoryDir(), { recursive: true });
  // Touch the global scope so the agent can see `(empty)` placeholders
  // even before the first note is written. We don't create project
  // scopes here — those appear the first time a project-specific note
  // is written, so an onboarded project with no memory yet doesn't
  // ship an empty `projects/<id>/` directory.
  await fs.mkdir(path.join(memoryDir(), "global"), { recursive: true });
}

/** Sanity check used by the test suite — confirms the home dir is set up. */
export function memoryRootForDebug(): string {
  return path.join(orchestratorHome(), "memory");
}
