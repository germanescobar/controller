/*
 * Navigation/permission policy for the preview browser (issue #109).
 *
 * Mirrors the v1 Preview pane policy enforced in `electron/main.ts`: localhost
 * and project-local file URLs are allowed by default, plus web URLs. The
 * Electron main process remains the ultimate enforcer for live navigation (via
 * its `will-navigate` guard); this server-side check gives the CLI a fast,
 * clear error before a command is forwarded to the renderer.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

function isLocalhostUrl(input: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(input);
}

function looksLikeRelativeProjectPath(input: string): boolean {
  return (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.includes("/") ||
    input.includes("\\")
  );
}

function hasUrlScheme(input: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

function normalizePreviewUrl(input: string, projectRoot?: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL to preview");

  if (isLocalhostUrl(trimmed)) {
    return `http://${trimmed}`;
  }

  if (path.isAbsolute(trimmed)) {
    return pathToFileURL(trimmed).toString();
  }

  if (hasUrlScheme(trimmed)) {
    return new URL(trimmed).toString();
  }

  if (projectRoot && looksLikeRelativeProjectPath(trimmed)) {
    return pathToFileURL(path.resolve(projectRoot, trimmed)).toString();
  }

  return new URL(trimmed).toString();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export interface PreviewUrlCheck {
  allowed: boolean;
  url?: string;
  error?: string;
}

export interface PreviewFileCheck {
  allowed: boolean;
  /** Canonical absolute path on disk; populated when allowed. */
  path?: string;
  /**
   * `inside-project` — the path is under the worktree root.
   * `outside-project` — the path is outside the worktree root and the
   *   caller has explicitly opted in via `--allow-outside`.
   * `invalid` — the path could not be resolved (missing, symlink loop, etc.).
   */
  scope?: "inside-project" | "outside-project" | "invalid";
  error?: string;
}

export interface ValidateBrowserFileOptions {
  /**
   * Caller has acknowledged the path is outside the active worktree and is
   * intentionally granting access. Default `false` — paths outside the
   * worktree are rejected unless the user (or the calling agent, with
   * appropriate consent) opts in. Mirrors the `--insecure` opt-in for the
   * URL side.
   */
  allowOutside?: boolean;
}

/**
 * Validate a path the agent wants to upload through a `<input type="file">`.
 * Mirrors `validateBrowserUrl` for symmetry: inside-project paths are
 * always allowed; outside-project paths require `allowOutside`. The
 * Electron main process re-checks this at file-read time.
 */
export function validateBrowserFilePath(
  input: string,
  projectRoot: string | undefined,
  options: ValidateBrowserFileOptions = {}
): PreviewFileCheck {
  if (typeof input !== "string" || input.trim() === "") {
    return { allowed: false, error: "Path must be a non-empty string" };
  }
  let resolved: string;
  try {
    resolved = path.resolve(input);
  } catch {
    return { allowed: false, error: "Could not resolve path" };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { allowed: false, scope: "invalid", error: "File does not exist" };
  }
  if (!stat.isFile()) {
    return { allowed: false, scope: "invalid", error: "Path is not a regular file" };
  }
  if (!projectRoot) {
    return {
      allowed: false,
      error: "File uploads can only run from inside an active worktree",
    };
  }
  if (isPathInside(projectRoot, resolved)) {
    return { allowed: true, path: resolved, scope: "inside-project" };
  }
  if (options.allowOutside) {
    return { allowed: true, path: resolved, scope: "outside-project" };
  }
  return {
    allowed: false,
    error:
      "File is outside the active worktree. Re-run with --allow-outside " +
      "to attach it; the Electron main process will surface a confirmation prompt " +
      "the user must approve before the file leaves the worktree boundary.",
  };
}

export interface ValidateBrowserUrlOptions {
  /**
   * The agent has opted in to bypassing TLS validation for this navigation
   * (via `controller browser open --insecure`). When true, `https` URLs are
   * only allowed for localhost-shaped hosts — the same `isLocalhostUrl`
   * shape used to gate non-`https` previews. This is a deliberate trust
   * bound: the bypass exists so dev servers with self-signed certs can be
   * reached, not so an agent can talk to an arbitrary external host without
   * cert validation.
   */
  insecure?: boolean;
}

/**
 * Validate and normalize a URL the agent wants to open. Returns the canonical
 * URL to forward to the renderer, or a reason it was rejected.
 */
export function validateBrowserUrl(
  input: string,
  projectRoot?: string,
  options: ValidateBrowserUrlOptions = {}
): PreviewUrlCheck {
  let url: URL;
  try {
    url = new URL(normalizePreviewUrl(input, projectRoot));
  } catch {
    return { allowed: false, error: "Enter a valid web or project file URL" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (options.insecure && !isLocalhostHost(url.hostname)) {
      return {
        allowed: false,
        error: "--insecure only applies to localhost URLs (got " + url.hostname + ")",
      };
    }
    return { allowed: true, url: url.toString() };
  }

  if (url.protocol === "file:") {
    if (!projectRoot) {
      return {
        allowed: false,
        error: "Project files can only be previewed after the worktree is loaded",
      };
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return { allowed: false, error: "Invalid file URL" };
    }
    if (!isPathInside(projectRoot, filePath)) {
      return {
        allowed: false,
        error: "File previews must stay inside the active project",
      };
    }
    return { allowed: true, url: url.toString() };
  }

  return {
    allowed: false,
    error: "Only web URLs and project file previews are allowed",
  };
}

/**
 * Returns true when `hostname` is a loopback address that the agent can
 * plausibly be running a local dev server on. Mirrors the `isLocalhostUrl`
 * matcher above so the policy and the Electron cert-verify bypass agree on
 * what counts as a localhost target.
 */
function isLocalhostHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "[::1]" ||
    lower === "::1"
  );
}
