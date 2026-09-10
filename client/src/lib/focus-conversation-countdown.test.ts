import test from "node:test";
import assert from "node:assert/strict";
import { getConversationCountdown } from "./focus-conversation-countdown.ts";

test("new-session view does not dereference a missing countdown", () => {
  assert.equal(getConversationCountdown(null, undefined), null);
});

test("countdown is only exposed in its originating session", () => {
  const onCancel = () => {};
  const countdown = {
    sentFromSessionId: "session-a",
    scheduledAt: 123,
    durationMs: 4_000,
    onCancel,
  };

  assert.equal(getConversationCountdown(countdown, "session-b"), null);
  assert.deepEqual(getConversationCountdown(countdown, "session-a"), {
    scheduledAt: 123,
    durationMs: 4_000,
    onStay: onCancel,
  });
});
