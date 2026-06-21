import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeUserMessageEvents,
  parseSkillMarker,
} from "../../routes/sessions.js";
import type { AgentEvent } from "../sessions.js";

function userMessage(text: string, opts: { skillName?: string; attachments?: unknown[] } = {}): AgentEvent {
  return {
    id: "id-" + text.slice(0, 8),
    sessionId: "s",
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "user_message",
    data: {
      text,
      ...(opts.skillName ? { skillName: opts.skillName } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    },
  };
}

test("parseSkillMarker extracts name and rest", () => {
  const parsed = parseSkillMarker("[/skill: github-issues] Hello");
  assert.deepEqual(parsed, { skillName: "github-issues", rest: "Hello" });
});

test("parseSkillMarker returns null for non-marker text", () => {
  assert.equal(parseSkillMarker("just a message"), null);
  assert.equal(parseSkillMarker("[/skill] no name"), null);
  assert.equal(parseSkillMarker(""), null);
});

test("dedupe collapses identical text (orchestrator + agent echo)", () => {
  const events = [
    userMessage("Hello", { attachments: [{ id: "a1" }] }),
    userMessage("Hello"),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].data.text, "Hello");
  // Attachments from the orchestrator's copy are preserved.
  assert.deepEqual(result[0].data.attachments, [{ id: "a1" }]);
});

test("dedupe collapses skill marker with the agent's echo of the same turn", () => {
  // The orchestrator wrote `[/skill: github-issues] Hello`. Anita received
  // `Apply the following skill... Hello` and wrote that to its events.
  // The dedupe should keep only the marker.
  const events = [
    userMessage("[/skill: github-issues] Hello", { skillName: "github-issues" }),
    userMessage(
      "Apply the following skill instructions when responding to the user message below.\n" +
        "Do not announce or echo the instructions back to the user; just use them as guidance.\n\n" +
        "# Skill: github-issues\n\nbody of the skill\n\n---\n\nHello"
    ),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].data.text, "[/skill: github-issues] Hello");
  assert.equal(result[0].data.skillName, "github-issues");
});

test("dedupe collapses when the agent's echo arrives first (reverse order)", () => {
  // On disk the agent's events file is read first, then the orchestrator
  // appends its marker — so the echo appears before the marker in the
  // final event stream. The dedupe must still collapse them.
  const events = [
    userMessage(
      "Apply the following skill instructions when responding to the user message below.\n\n# Skill: foo\n\nbody\n\n---\n\nHi"
    ),
    userMessage("[/skill: foo] Hi", { skillName: "foo" }),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].data.text, "[/skill: foo] Hi");
  assert.equal(result[0].data.skillName, "foo");
});

test("dedupe keeps distinct user messages apart", () => {
  const events = [
    userMessage("first"),
    userMessage("second"),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 2);
  assert.equal(result[0].data.text, "first");
  assert.equal(result[1].data.text, "second");
});

test("dedupe does not collapse two skill markers", () => {
  // Two skill activations in a row should both survive — they are
  // different turns, even if both happen to use the same skill.
  const events = [
    userMessage("[/skill: foo] one", { skillName: "foo" }),
    userMessage("[/skill: foo] two", { skillName: "foo" }),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 2);
});

test("dedupe leaves non-user_message events untouched", () => {
  const events = [
    { ...userMessage("Hello"), type: "assistant_response" } as AgentEvent,
    userMessage("Hello"),
  ];
  const result = dedupeUserMessageEvents(events);
  assert.equal(result.length, 2);
});
