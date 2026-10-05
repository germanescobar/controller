/*
 * Dedupe consecutive `user_message` events that represent the same turn
 * (issue #404 — shared between the server's full-transcript endpoint and
 * the client's paginated open path).
 *
 * The server-side `GET /:projectId/sessions/:sessionId/events` endpoint
 * returns this deduped view by default (preserving the existing
 * byte-equivalent contract). The same logic is reused by the client
 * when it stitches together paginated history pages so the seam between
 * two adjacent pages produces the same final timeline as a single-shot
 * read.
 *
 * Two cases trigger a collapse:
 *
 * 1. **Identical text.** The orchestrator and the agent sometimes each
 *    write a `user_message` for the same turn (the orchestrator to
 *    persist attachments, the agent to log what it received). Identical
 *    text means the same turn.
 *
 * 2. **Skill marker vs. agent echo.** When a skill is active the
 *    orchestrator writes a `user_message` whose text is
 *    `[/skill: name] <user text>`, and the agent writes its own
 *    `user_message` with the full prompt (skill body + user text). The
 *    two texts differ, but the orchestrator's text is the canonical user
 *    turn; the agent's is just an echo of the wire payload. Collapse
 *    them, keeping the orchestrator's marker so the UI can render a
 *    `Skill: <name>` badge.
 *
 * Kept in shared/ so the server's full-transcript path and the client's
 * paginated open path apply identical rules — both call sites reference
 * this module directly. No DOM/Node-specific APIs so the same module
 * runs in the renderer and the server.
 */

export interface SharedAgentEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export function sharedParseSkillMarker(
  text: string
): { skillName: string; rest: string } | null {
  const match = /^\[\/skill:\s*([A-Za-z0-9._-]+)\]\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { skillName: match[1], rest: match[2] };
}

function sharedGetUserMessageText(event: SharedAgentEvent): string {
  const text = (event.data as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function sharedPickUserMessageAttachments(
  event: SharedAgentEvent
): unknown[] | undefined {
  const attachments = (event.data as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments;
}

export function sharedDedupeUserMessageEvents<T extends SharedAgentEvent>(
  events: T[]
): T[] {
  const result: T[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === "user_message" &&
      event.type === "user_message"
    ) {
      const previousText = sharedGetUserMessageText(previous);
      const currentText = sharedGetUserMessageText(event);

      if (previousText !== "" && previousText === currentText) {
        const previousAttachments = sharedPickUserMessageAttachments(previous);
        const currentAttachments = sharedPickUserMessageAttachments(event);
        result[result.length - 1] = {
          ...previous,
          data: {
            ...previous.data,
            ...event.data,
            attachments: previousAttachments ?? currentAttachments,
          },
        };
        continue;
      }

      const previousMarker = sharedParseSkillMarker(previousText);
      if (
        previousMarker &&
        !sharedParseSkillMarker(currentText) &&
        currentText.endsWith(previousMarker.rest) &&
        currentText.includes(previousMarker.rest)
      ) {
        const previousAttachments = sharedPickUserMessageAttachments(previous);
        const currentAttachments = sharedPickUserMessageAttachments(event);
        result[result.length - 1] = {
          ...previous,
          data: {
            ...previous.data,
            attachments: previousAttachments ?? currentAttachments,
          },
        };
        continue;
      }

      const currentMarker = sharedParseSkillMarker(currentText);
      if (
        currentMarker &&
        !previousMarker &&
        previousText.endsWith(currentMarker.rest) &&
        previousText.includes(currentMarker.rest)
      ) {
        const previousAttachments = sharedPickUserMessageAttachments(previous);
        const currentAttachments = sharedPickUserMessageAttachments(event);
        result[result.length - 1] = {
          ...event,
          data: {
            ...event.data,
            attachments: currentAttachments ?? previousAttachments,
          },
        };
        continue;
      }
    }
    result.push(event);
  }
  return result;
}