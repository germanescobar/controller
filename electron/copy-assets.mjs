import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "dist/electron");
mkdirSync(outDir, { recursive: true });

const assets = ["welcome.html", "welcome.css"];
for (const name of assets) {
  const from = resolve(here, name);
  const to = resolve(outDir, name);
  copyFileSync(from, to);
  console.log(`Copied ${name} -> dist/electron/${name}`);
}
