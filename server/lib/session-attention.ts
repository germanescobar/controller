import fs from "node:fs/promises";
import path from "node:path";
import { orchestratorHome } from "./paths.js";
import type { AgentEvent } from "./sessions.js";

const APPROVAL_SETTLED_TYPES = new Set([
  "tool_approval_response",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run_cancelled",
]);

/** Rebuild whether a persisted transcript still contains an unresolved prompt. */
export function hasPendingSessionAttention(events: AgentEvent[]): boolean {
  let pendingUserInput = false;
  let pendingApproval = false;

  for (const event of events) {
    if (event.type === "user_input_requested") pendingUserInput = true;
    else if (event.type === "user_input_response") pendingUserInput = false;

    if (event.type === "tool_approval_requested") pendingApproval = true;
    else if (APPROVAL_SETTLED_TYPES.has(event.type)) pendingApproval = false;
  }

  return pendingUserInput || pendingApproval;
}

interface CachedAttention {
  mtimeMs: number;
  size: number;
  pending: boolean;
  sessionId: string;
}

const cache = new Map<string, CachedAttention>();

/**
 * Discover unresolved prompts from Controller's persisted JSONL event logs.
 * File mtimes keep the polling path cheap: transcripts are reparsed only when
 * they change, while a cold server still reconstructs attention after restart.
 */
export async function listPersistedAttentionSessionIds(): Promise<Set<string>> {
  const storesRoot = path.join(orchestratorHome(), "projects");
  let stores: string[];
  try {
    stores = await fs.readdir(storesRoot);
  } catch {
    return new Set();
  }

  const seen = new Set<string>();
  await Promise.all(
    stores.map(async (store) => {
      const eventsDir = path.join(storesRoot, store, "events");
      let files: string[];
      try {
        files = await fs.readdir(eventsDir);
      } catch {
        return;
      }

      await Promise.all(
        files.filter((file) => file.endsWith(".jsonl")).map(async (file) => {
          const filePath = path.join(eventsDir, file);
          seen.add(filePath);
          try {
            const stat = await fs.stat(filePath);
            const cached = cache.get(filePath);
            if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return;
            const content = await fs.readFile(filePath, "utf8");
            const events = content
              .trim()
              .split("\n")
              .filter(Boolean)
              .flatMap((line) => {
                try {
                  return [JSON.parse(line) as AgentEvent];
                } catch {
                  return [];
                }
              });
            cache.set(filePath, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              pending: hasPendingSessionAttention(events),
              sessionId: path.basename(file, ".jsonl"),
            });
          } catch {
            cache.delete(filePath);
          }
        }),
      );
    }),
  );

  for (const filePath of cache.keys()) {
    if (!seen.has(filePath)) cache.delete(filePath);
  }

  return new Set(
    [...cache.values()]
      .filter((entry) => entry.pending)
      .map((entry) => entry.sessionId),
  );
}
