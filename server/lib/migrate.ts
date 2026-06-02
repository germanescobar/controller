import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestratorHome } from "./paths.js";

/**
 * One-time migration of data from legacy locations to the centralized
 * ~/.coding-orchestrator directory.
 *
 * Legacy locations:
 *   - ~/coding-orchestrator/  (worktrees, terminal-tabs, worktrees.json)
 *   - <cwd>/.data/            (projects.json, api-keys.json)
 *
 * After a successful migration a `.migrated` sentinel file is written
 * inside the new home directory so we don't attempt to re-migrate on
 * every startup.
 */
export async function migrateToCentralizedHome(): Promise<void> {
  const home = orchestratorHome();
  const sentinel = path.join(home, ".migrated");

  // Already migrated – skip.
  if (fsSync.existsSync(sentinel)) return;

  // Make sure the target directory exists.
  await fs.mkdir(home, { recursive: true });

  let migrated = false;

  // --- 1. Migrate from ~/coding-orchestrator (worktrees, terminal-tabs) ---
  const oldHome = path.join(os.homedir(), "coding-orchestrator");
  if (fsSync.existsSync(oldHome)) {
    for (const file of ["worktrees.json", "terminal-tabs.json"]) {
      const src = path.join(oldHome, file);
      const dest = path.join(home, file);
      if (fsSync.existsSync(src) && !fsSync.existsSync(dest)) {
        await fs.copyFile(src, dest);
        migrated = true;
      }
    }
    // Move worktrees directory
    const oldWorktrees = path.join(oldHome, "worktrees");
    const newWorktrees = path.join(home, "worktrees");
    if (fsSync.existsSync(oldWorktrees) && !fsSync.existsSync(newWorktrees)) {
      await fs.cp(oldWorktrees, newWorktrees, { recursive: true });
      migrated = true;
    }
  }

  // --- 2. Migrate from <cwd>/.data/ (projects, api-keys) ---
  const oldDataDir = path.join(process.cwd(), ".data");
  if (fsSync.existsSync(oldDataDir)) {
    for (const file of ["projects.json", "api-keys.json"]) {
      const src = path.join(oldDataDir, file);
      const dest = path.join(home, file);
      if (fsSync.existsSync(src) && !fsSync.existsSync(dest)) {
        await fs.copyFile(src, dest);
        migrated = true;
      }
    }
  }

  if (migrated) {
    console.log(`[migrate] Data migrated to ${home}`);
  }

  // Write sentinel so we never re-run migration.
  await fs.writeFile(sentinel, new Date().toISOString(), "utf-8");
}