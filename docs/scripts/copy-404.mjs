// Copy the docs index.html to 404.html so GitHub Pages' SPA fallback
// (which serves 404.html for unknown paths) reloads into the Fumadocs
// shell instead of returning a hard 404 page.
//
// GitHub Pages project sites (under /<repo>/) lack an automatic SPA
// fallback, so any deep link would 404 on cold load. Copying
// `out/404.html` (which Pages actually serves for unknown routes)
// back to a mirror of the index lets the client-side router pick up
// the route from the URL after the 404 shell renders.
import { copyFile, stat } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";

const OUT_DIR = resolve(process.cwd(), "out");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyIndexTo(dir, fallbackName = "404.html") {
  // Each pre-rendered route sits at <dir>/<route>/index.html. We mirror
  // each one to <dir>/<route>/<fallbackName> so client-side routes that
  // resolve to a directory + index still work when Pages reissues them.
  // We also mirror the root index.html as 404.html at the top level.
  const rootIndex = resolve(dir, "index.html");
  if (await exists(rootIndex)) {
    await copyFile(rootIndex, resolve(dir, fallbackName));
  }
}

await copyIndexTo(OUT_DIR);
console.log("[copy-404] mirrored index.html → 404.html");
