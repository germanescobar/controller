import fs from "node:fs/promises";
import path from "node:path";
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

  if (isLocalhostUrl(trimmed)) return `http://${trimmed}`;
  if (path.isAbsolute(trimmed)) return pathToFileURL(trimmed).toString();
  if (hasUrlScheme(trimmed)) return new URL(trimmed).toString();
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

/** Resolve symlinks for the main-process URL and file-read boundary checks. */
export async function canonicalizeForBoundary(input: string): Promise<string> {
  try {
    return await fs.realpath(input);
  } catch {
    return input;
  }
}

/** Final main-process check before a preview URL reaches the webview. */
export async function validatePreviewUrl(
  input: string,
  projectRoot?: string
): Promise<{ allowed: boolean; url?: string; error?: string }> {
  let url: URL;
  try {
    url = new URL(normalizePreviewUrl(input, projectRoot));
  } catch {
    return { allowed: false, error: "Enter a valid web or project file URL" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return { allowed: true, url: url.toString() };
  }

  if (url.protocol === "file:") {
    if (!projectRoot) {
      return { allowed: false, error: "Project files can only be previewed after the worktree is loaded" };
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return { allowed: false, error: "Invalid file URL" };
    }
    if (!isPathInside(
      await canonicalizeForBoundary(projectRoot),
      await canonicalizeForBoundary(filePath)
    )) {
      return { allowed: false, error: "File previews must stay inside the active project" };
    }
    return { allowed: true, url: url.toString() };
  }

  return { allowed: false, error: "Only web URLs and project file previews are allowed" };
}
