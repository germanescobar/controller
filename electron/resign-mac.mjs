// Re-sign the packaged macOS Controller.app with an ad-hoc signature.
//
// electron-builder's default signing on macOS 14+ produces a bundle whose
// Mach-O is `linker-signed` but whose Info.plist is not bound, which makes
// Gatekeeper treat the app as damaged on first launch (showing the dead-end
// "Move to Trash / Done" dialog instead of the regular "developer cannot be
// verified" dialog with an Open button). Re-signing the whole bundle with
// `codesign --force --deep --sign -` produces a properly-formed ad-hoc
// signature that produces the standard right-click → Open flow.
//
// This is a workaround for the unsigned v0.1.0 release. Once we ship a
// Developer ID-signed build, this script can be deleted.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const releaseDir = resolve(repoRoot, "release");

function findAppBundles(root) {
  const found = [];
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry.endsWith(".app") && existsSync(resolve(full, "Contents/MacOS"))) {
        found.push(full);
      } else if (entry !== "builder-debug.yml" && entry !== "builder-effective-config.yaml") {
        found.push(...findAppBundles(full));
      }
    }
  }
  return found;
}

const apps = findAppBundles(releaseDir);
if (apps.length === 0) {
  console.log("resign-mac: no .app bundles found under release/; nothing to do");
  process.exit(0);
}

for (const app of apps) {
  console.log(`resign-mac: signing ${app}`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", app],
    { stdio: "inherit" }
  );
  // Verify
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "inherit",
  });
  const info = execFileSync("codesign", ["-dv", app], { encoding: "utf8" });
  console.log(info);
}