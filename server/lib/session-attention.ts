import { createReadStream } from "node:fs";
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
const ATTENTION_EVENT_PATTERN = /"type"\s*:\s*"(?:user_input_requested|user_input_response|tool_approval_requested|tool_approval_response|run\.completed|run\.failed|run\.cancelled|run_cancelled)"/;
const SCAN_CONCURRENCY = 4;

interface AttentionState {
  pendingUserInput: boolean;
  pendingApproval: boolean;
}

/** Rebuild whether a persisted transcript still contains an unresolved prompt. */
export function hasPendingSessionAttention(events: AgentEvent[]): boolean {
  const state: AttentionState = { pendingUserInput: false, pendingApproval: false };
  for (const event of events) applyAttentionEvent(state, event.type);
  return state.pendingUserInput || state.pendingApproval;
}

interface CachedAttention extends AttentionState {
  mtimeMs: number;
  size: number;
  processedSize: number;
  sessionId: string;
}

const cache = new Map<string, CachedAttention>();
const scans = new Map<string, Promise<Set<string>>>();
const completedSnapshots = new Map<string, Set<string>>();

/** Return the latest snapshot immediately while refreshing it in the background. */
export function getCachedPersistedAttentionSnapshot(): {
  sessionIds: Set<string>;
  ready: boolean;
} {
  const storesRoot = path.join(orchestratorHome(), "projects");
  const completed = completedSnapshots.get(storesRoot);
  void listPersistedAttentionSessionIds().catch((error: Error) => {
    console.error("Failed to refresh persisted session attention", error);
  });
  return { sessionIds: completed ?? new Set(), ready: Boolean(completed) };
}

/** Discover unresolved prompts without loading whole transcripts into memory. */
export function listPersistedAttentionSessionIds(): Promise<Set<string>> {
  const storesRoot = path.join(orchestratorHome(), "projects");
  const existing = scans.get(storesRoot);
  if (existing) return existing;

  const scan = scanPersistedAttention(storesRoot)
    .then((result) => {
      completedSnapshots.set(storesRoot, result);
      return result;
    })
    .finally(() => {
      scans.delete(storesRoot);
    });
  scans.set(storesRoot, scan);
  return scan;
}

async function scanPersistedAttention(storesRoot: string): Promise<Set<string>> {
  let stores: string[];
  try {
    stores = await fs.readdir(storesRoot);
  } catch {
    return new Set();
  }

  const files: string[] = [];
  for (const store of stores) {
    const eventsDir = path.join(storesRoot, store, "events");
    try {
      const entries = await fs.readdir(eventsDir);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) files.push(path.join(eventsDir, entry));
      }
    } catch {
      // Stores without an events directory have no persisted attention.
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const filePath = files[next++];
        await updateCachedAttention(filePath);
      }
    }),
  );

  const seen = new Set(files);
  for (const filePath of cache.keys()) {
    if (filePath.startsWith(`${storesRoot}${path.sep}`) && !seen.has(filePath)) {
      cache.delete(filePath);
    }
  }

  return new Set(
    files
      .map((filePath) => cache.get(filePath))
      .filter((entry): entry is CachedAttention => Boolean(entry))
      .filter((entry) => entry.pendingUserInput || entry.pendingApproval)
      .map((entry) => entry.sessionId),
  );
}

async function updateCachedAttention(filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const previous = cache.get(filePath);
    if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) return;

    // Session logs are append-only. A rewrite or truncation needs a full scan.
    const appended = previous && stat.size > previous.size;
    const state: AttentionState = appended
      ? { pendingUserInput: previous.pendingUserInput, pendingApproval: previous.pendingApproval }
      : { pendingUserInput: false, pendingApproval: false };
    const start = appended ? previous.processedSize : 0;
    let processedSize = start;
    if (start < stat.size) {
      const stream = createReadStream(filePath, { start, end: stat.size - 1 });
      let pendingLine = Buffer.alloc(0);
      let streamPosition = start;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        let lineEnd = bytes.indexOf(10, offset);
        while (lineEnd !== -1) {
          const fragment = bytes.subarray(offset, lineEnd);
          const line = pendingLine.length
            ? Buffer.concat([pendingLine, fragment]).toString("utf8")
            : fragment.toString("utf8");
          pendingLine = Buffer.alloc(0);
          processedSize = streamPosition + lineEnd + 1;
          offset = lineEnd + 1;
          lineEnd = bytes.indexOf(10, offset);
          if (!ATTENTION_EVENT_PATTERN.test(line)) continue;
          try {
            const event = JSON.parse(line) as AgentEvent;
            applyAttentionEvent(state, event.type);
          } catch {
            // Ignore a malformed event and continue to the next line.
          }
        }
        const remainder = bytes.subarray(offset);
        pendingLine = pendingLine.length
          ? Buffer.concat([pendingLine, remainder])
          : remainder;
        streamPosition += bytes.length;
      }
    }
    cache.set(filePath, {
      ...state,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      processedSize,
      sessionId: path.basename(filePath, ".jsonl"),
    });
  } catch {
    cache.delete(filePath);
  }
}

function applyAttentionEvent(state: AttentionState, type: string): void {
  if (type === "user_input_requested") state.pendingUserInput = true;
  else if (type === "user_input_response") state.pendingUserInput = false;

  if (type === "tool_approval_requested") state.pendingApproval = true;
  else if (APPROVAL_SETTLED_TYPES.has(type)) state.pendingApproval = false;
}
