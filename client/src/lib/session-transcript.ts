import type { AgentEvent } from "../api.ts";

export interface SessionTranscript {
  sessionId: string | null;
  events: AgentEvent[];
}

const EMPTY_EVENTS: AgentEvent[] = [];

/** Keep responses from an older view from replacing the visible transcript. */
export function updateSessionTranscript(
  previous: SessionTranscript,
  activeSessionId: string | undefined,
  targetSessionId: string,
  update: AgentEvent[] | ((events: AgentEvent[]) => AgentEvent[]),
): SessionTranscript {
  if (activeSessionId !== targetSessionId) return previous;
  const currentEvents = previous.sessionId === targetSessionId ? previous.events : [];
  return {
    sessionId: targetSessionId,
    events: typeof update === "function" ? update(currentEvents) : update,
  };
}

export function visibleSessionEvents(
  transcript: SessionTranscript,
  sessionId: string | undefined,
): AgentEvent[] {
  return sessionId && transcript.sessionId === sessionId
    ? transcript.events
    : EMPTY_EVENTS;
}
