/**
 * Pure helpers for the composer's `/` skill picker, isolated from React so
 * they can be unit-tested with the `node --import tsx --test` runner.
 *
 * Two capabilities live here (issue #217):
 *
 *  - Position-agnostic parsing: the picker scans the token at the caret
 *    rather than only the start of the input, so `/` opens the picker from
 *    any position that begins a new token.
 *  - Multi-skill assembly: the composer can stack several skills into one
 *    turn. The server transport stays single-valued — the first skill rides
 *    through the `skillName` query param (so the server prepends its body and
 *    re-adds its `[/skill: first]` history marker), and the remaining skills
 *    ride through as `[/skill: name]` markers prepended to the message text,
 *    which the server records in history verbatim.
 */

export interface SkillToken {
  /** The skill name typed after `/` (empty while the user is mid-type). */
  token: string;
  /** Index of the leading `/` of the token within the message. */
  start: number;
  /** Caret index — the exclusive end of the token. */
  end: number;
}

/** A token looks like a skill invocation only if it is exactly `/<name>`. */
const SKILL_TOKEN = /^\/([A-Za-z0-9._-]*)$/;

/**
 * Parse the in-progress skill token at the caret. Whitespace and the start of
 * the string are token boundaries; the current token is the trailing run of
 * non-whitespace characters before the caret. Returns null when that token
 * does not look like a `/<skill>` invocation — a `/` inside a path or URL is
 * preceded by non-whitespace, so its token never matches `^\/<name>$`.
 */
export function parseSkillTokenAtCaret(
  message: string,
  caret: number
): SkillToken | null {
  const clamped = Math.max(0, Math.min(caret, message.length));
  const before = message.slice(0, clamped);
  // The trailing non-whitespace run is the current token.
  const run = /(\S*)$/.exec(before);
  if (!run) return null;
  const tokenText = run[1];
  const start = run.index;
  const match = SKILL_TOKEN.exec(tokenText);
  if (!match) return null;
  return { token: match[1], start, end: clamped };
}

/**
 * Remove the in-progress `/<token>` from the message, returning the cleaned
 * message and the caret position where the token started. Leading prose is
 * preserved verbatim; the seam left by removing a mid-message token (or the
 * leading whitespace of a position-0 token) is collapsed so the composer does
 * not show a dangling space.
 */
export function removeSkillToken(
  message: string,
  token: SkillToken
): { message: string; caret: number } {
  const before = message.slice(0, token.start);
  let after = message.slice(token.end);
  if (before === "") {
    // Position-0 token: drop leading whitespace the way the old single-skill
    // picker did, so the composer shows just the rest of the text.
    after = after.replace(/^\s+/, "");
  } else if (/\s$/.test(before) && /^\s/.test(after)) {
    // Mid-message token between two spaces — keep a single separating space.
    after = after.replace(/^\s+/, "");
  }
  return { message: before + after, caret: before.length };
}

/** `"[/skill: a] [/skill: b]"` for the given names (no trailing space). */
export function buildSkillMarkers(skillNames: string[]): string {
  return skillNames.map((name) => `[/skill: ${name}]`).join(" ");
}

/**
 * The history/visible text the client mirrors locally — every active skill as
 * a `[/skill: name]` marker followed by the user's text. This matches what the
 * server persists: it prepends `[/skill: first]` and the remaining markers
 * already ride through `buildSkillAgentText`.
 */
export function buildSkillHistoryText(skillNames: string[], text: string): string {
  if (skillNames.length === 0) return text;
  return `${buildSkillMarkers(skillNames)} ${text}`;
}

/**
 * The message text handed to the single-valued server transport. The first
 * skill travels via the `skillName` query param, so only the remaining skills
 * (index 1+) are prepended as markers here; the server re-adds the first
 * marker when it builds the history message.
 */
export function buildSkillAgentText(skillNames: string[], text: string): string {
  if (skillNames.length <= 1) return text;
  return `${buildSkillMarkers(skillNames.slice(1))} ${text}`;
}

/**
 * Strip a chain of leading `[/skill: name]` markers from a persisted history
 * message. Generalizes the old single-marker parser so a multi-skill turn
 * (`[/skill: a] [/skill: b] <text>`) yields every skill name in declaration
 * order plus the remaining visible text.
 */
export function parseSkillMarkers(rawText: string): {
  skillNames: string[];
  text: string;
} {
  const marker = /^\[\/skill:\s*([A-Za-z0-9._-]+)\]\s*/;
  const skillNames: string[] = [];
  let rest = rawText;
  let match = marker.exec(rest);
  while (match) {
    skillNames.push(match[1]);
    rest = rest.slice(match[0].length);
    match = marker.exec(rest);
  }
  return { skillNames, text: rest };
}
