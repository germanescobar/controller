export interface FocusAdvanceCountdown {
  sentFromSessionId: string;
  scheduledAt: number;
  durationMs: number;
  onCancel: () => void;
}

export interface ConversationCountdown {
  scheduledAt: number;
  durationMs: number;
  onStay: () => void;
}

export function getConversationCountdown(
  countdown: FocusAdvanceCountdown | null,
  sessionId?: string,
): ConversationCountdown | null {
  if (!countdown || !sessionId || countdown.sentFromSessionId !== sessionId) {
    return null;
  }

  return {
    scheduledAt: countdown.scheduledAt,
    durationMs: countdown.durationMs,
    onStay: countdown.onCancel,
  };
}
