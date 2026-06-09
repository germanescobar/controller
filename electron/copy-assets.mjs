import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "dist/electron");
mkdirSync(outDir, { recursive: true });

// Files that live next to this script.
const localAssets = ["welcome.html", "welcome.css"];
for (const name of localAssets) {
  const from = resolve(here, name);
  const to = resolve(outDir, name);
  copyFileSync(from, to);
  console.log(`Copied ${name} -> dist/electron/${name}`);
}

// Files that live in build/ at the repo root. The welcome screen
// references build/icon.png as welcome-icon.png, so the packaged app
// has a self-contained icon without exposing the broader build/ tree.
const buildAssets = [{ from: "build/icon.png", to: "welcome-icon.png" }];
for (const { from, to } of buildAssets) {
  const fromPath = resolve(repoRoot, from);
  const toPath = resolve(outDir, to);
  copyFileSync(fromPath, toPath);
  console.log(`Copied ${from} -> dist/electron/${to}`);
}
