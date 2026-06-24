import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSkillTokenAtCaret,
  removeSkillToken,
  buildSkillMarkers,
  buildSkillHistoryText,
  buildSkillAgentText,
  parseSkillMarkers,
} from "./skill-picker.ts";

// --- parseSkillTokenAtCaret ------------------------------------------------

test("opens for a `/` token at the start of the input", () => {
  const message = "/git";
  const token = parseSkillTokenAtCaret(message, message.length);
  assert.deepEqual(token, { token: "git", start: 0, end: 4 });
});

test("opens for a bare `/` (empty query shows every skill)", () => {
  const token = parseSkillTokenAtCaret("/", 1);
  assert.deepEqual(token, { token: "", start: 0, end: 1 });
});

test("opens for a `/` token mid-message at the caret", () => {
  const message = "fix the bug /tav";
  const token = parseSkillTokenAtCaret(message, message.length);
  assert.deepEqual(token, { token: "tav", start: 12, end: 16 });
});

test("uses the token at the caret, not a `/` token later in the string", () => {
  // Caret sits inside the prose word "something"; the `/tavily` earlier in
  // the line is not the current token, so the picker stays closed.
  const message = "/tavily do something";
  const token = parseSkillTokenAtCaret(message, message.length);
  assert.equal(token, null);
});

test("does not open for a `/` inside a path or URL", () => {
  assert.equal(parseSkillTokenAtCaret("src/lib", 7), null);
  assert.equal(parseSkillTokenAtCaret("see https://x/y", 15), null);
});

test("only considers text up to the caret", () => {
  const message = "/github extra";
  // Caret right after `/git`, before the rest is typed.
  const token = parseSkillTokenAtCaret(message, 4);
  assert.deepEqual(token, { token: "git", start: 0, end: 4 });
});

// --- removeSkillToken ------------------------------------------------------

test("removeSkillToken strips a position-0 token and leading space", () => {
  const message = "/tavily rest of message";
  const token = parseSkillTokenAtCaret(message, 7)!;
  assert.deepEqual(removeSkillToken(message, token), {
    message: "rest of message",
    caret: 0,
  });
});

test("removeSkillToken preserves prose before a mid-message token", () => {
  const message = "fix the bug /tavily";
  const token = parseSkillTokenAtCaret(message, message.length)!;
  assert.deepEqual(removeSkillToken(message, token), {
    message: "fix the bug ",
    caret: 12,
  });
});

test("removeSkillToken collapses the seam between surrounding spaces", () => {
  const message = "fix /tav more";
  const token = parseSkillTokenAtCaret(message, 8)!;
  assert.deepEqual(removeSkillToken(message, token), {
    message: "fix more",
    caret: 4,
  });
});

// --- marker assembly -------------------------------------------------------

test("buildSkillMarkers chains markers in order", () => {
  assert.equal(buildSkillMarkers(["a", "b"]), "[/skill: a] [/skill: b]");
  assert.equal(buildSkillMarkers([]), "");
});

test("buildSkillHistoryText prefixes every marker before the text", () => {
  assert.equal(buildSkillHistoryText([], "hello"), "hello");
  assert.equal(buildSkillHistoryText(["a"], "hello"), "[/skill: a] hello");
  assert.equal(
    buildSkillHistoryText(["a", "b"], "hello"),
    "[/skill: a] [/skill: b] hello"
  );
});

test("buildSkillAgentText omits the first skill (sent via skillName param)", () => {
  // Zero/one skill: text is bare — the server adds the single marker itself.
  assert.equal(buildSkillAgentText([], "hello"), "hello");
  assert.equal(buildSkillAgentText(["a"], "hello"), "hello");
  // Two+ skills: only the trailing skills ride through as markers.
  assert.equal(buildSkillAgentText(["a", "b"], "hello"), "[/skill: b] hello");
  assert.equal(
    buildSkillAgentText(["a", "b", "c"], "hello"),
    "[/skill: b] [/skill: c] hello"
  );
});

test("agent + first marker reconstructs the full history text", () => {
  // The server builds history as `[/skill: first] <agentText>`; that must
  // equal what the client mirrors via buildSkillHistoryText.
  const names = ["a", "b", "c"];
  const text = "do the thing";
  const serverHistory = `[/skill: ${names[0]}] ${buildSkillAgentText(names, text)}`;
  assert.equal(serverHistory, buildSkillHistoryText(names, text));
});

// --- parseSkillMarkers -----------------------------------------------------

test("parseSkillMarkers returns no skills for plain text", () => {
  assert.deepEqual(parseSkillMarkers("just a message"), {
    skillNames: [],
    text: "just a message",
  });
});

test("parseSkillMarkers strips a single leading marker", () => {
  assert.deepEqual(parseSkillMarkers("[/skill: tavily] hello"), {
    skillNames: ["tavily"],
    text: "hello",
  });
});

test("parseSkillMarkers strips a chain of markers in order", () => {
  assert.deepEqual(
    parseSkillMarkers("[/skill: a] [/skill: b] [/skill: c] hello"),
    { skillNames: ["a", "b", "c"], text: "hello" }
  );
});

test("parseSkillMarkers leaves a non-leading marker in the text", () => {
  assert.deepEqual(parseSkillMarkers("hello [/skill: a] world"), {
    skillNames: [],
    text: "hello [/skill: a] world",
  });
});
