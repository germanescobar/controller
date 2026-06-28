import type { AgentEvent } from "../api.ts";

export interface PendingToolApproval {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PendingToolApprovalOptions {
  hasSettledStreamItem?: boolean;
}

const TOOL_APPROVAL_SETTLED_EVENT_TYPES = new Set([
  "tool_approval_response",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run_cancelled",
]);

export function getLatestPendingToolApproval(
  events: AgentEvent[],
  options: PendingToolApprovalOptions = {}
): PendingToolApproval | null {
  if (options.hasSettledStreamItem) return null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    // A response or terminal run marker settles every earlier request. Without
    // the run markers, a killed Claude process leaves a stale approval card
    // that cannot be answered by any live control channel.
    if (TOOL_APPROVAL_SETTLED_EVENT_TYPES.has(event.type)) return null;
    if (event.type === "tool_approval_requested") {
      const requestId = event.data.requestId as string | undefined;
      if (!requestId) return null;
      return {
        requestId,
        toolName: (event.data.toolName as string | undefined) ?? "tool",
        input: (event.data.input as Record<string, unknown> | undefined) ?? {},
      };
    }
  }

  return null;
}
