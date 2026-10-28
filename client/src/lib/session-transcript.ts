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

/** Keep the optimistic bubble until a fetched transcript contains its user turn. */
export function pendingMessageAfterRefresh(
  pendingMessage: string | null,
  events: AgentEvent[],
  afterEventId: string | null = null,
  sentMessage: string = pendingMessage ?? "",
): string | null {
  if (!pendingMessage) return null;
  const afterIndex = afterEventId
    ? events.findIndex((event) => event.id === afterEventId)
    : -1;
  if (afterEventId && afterIndex === -1) return pendingMessage;
  const matchesSentTurn = (event: AgentEvent): boolean => {
    if (event.type !== "user_message" || typeof event.data.text !== "string") return false;
    const persistedText = event.data.text;
    const hasContextPrefix = /^(?:<mentions>|<selections>|<selection-annotations>)/.test(persistedText);
    // Mention and selection context is persisted before the user-facing text.
    return [pendingMessage, sentMessage].some(
      (text) => persistedText === text || (hasContextPrefix && persistedText.endsWith(`\n\n${text}`)),
    );
  };
  return events.slice(afterIndex + 1).some(matchesSentTurn) ? null : pendingMessage;
}
