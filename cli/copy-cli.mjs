import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copy the no-build CLI scripts into dist/cli so packaged builds can spawn
// them. The server resolves the CLI dir relative to its own location, which is
// `dist/server/lib` in a build and `server/lib` in dev, both of which point at
// a sibling `cli` directory.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "dist/cli");
mkdirSync(outDir, { recursive: true });

const scripts = ["controller-browser"];
for (const name of scripts) {
  const from = resolve(here, name);
  const to = resolve(outDir, name);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  console.log(`Copied ${name} -> dist/cli/${name}`);
}
