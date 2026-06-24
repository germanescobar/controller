import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendEvent, getEvents, type AgentEvent } from "../sessions.js";
import {
  dedupeUserMessageEvents,
  getPersistedEventType,
  getPersistedEventData,
} from "../../routes/sessions.js";
import type { AgentStreamEvent } from "../agents.js";

/*
 * Regression test for issue #163: the orchestrator must persist the Anita
 * transcript (assistant text + tool calls/results) to its own event store
 * and read it back via `getEvents` for a multi-turn session.
 *
 * Persistence was once skipped for Anita; the orchestrator's event store then
 * held only the orchestrator-written `user_message`/`run_diff` events, so the
 * UI rendered user bubbles and file-edit cards but empty assistant turns. The
 * fix makes the orchestrator persist every provider's parsed transcript events
 * itself (like Codex/Claude), so this test mirrors that persistence path. The
 * store now lives under the Controller home rather than a project-local
 * `.coding-agent/` to avoid colliding with the `anita` CLI's own storage.
 */

/*
 * Run with an isolated project dir and an isolated Controller home. Session
 * and event storage now lives under the Controller home (see
 * `projectStoreDir`), so the home is overridden via
 * `CONTROLLER_HOME` to keep test writes out of the real home and
 * clean them up afterward.
 */
function withTempProject(run: (projectPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "anita-transcript-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "orch-home-"));
  const prevHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = home;
  return run(dir).finally(() => {
    if (prevHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

/* Persist a parsed agent stream event exactly as the session stream handler does. */
async function persist(
  projectPath: string,
  sessionId: string,
  event: AgentStreamEvent
): Promise<void> {
  const agentEvent: AgentEvent = {
    id: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    type: getPersistedEventType(event),
    data: getPersistedEventData(event),
  };
  await appendEvent(projectPath, sessionId, agentEvent);
}

test("orchestrator reads back the full Anita transcript for a multi-turn session", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "anita-multi-turn";

    // Turn 1: the orchestrator writes the user_message, then Anita streams an
    // assistant response and a tool call/result that edits a file.
    await appendEvent(projectPath, sessionId, {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: "user_message",
      data: { text: "Edit the README", attachments: [] },
    });
    await persist(projectPath, sessionId, {
      type: "assistant.text",
      text: "Editing the README now.",
    });
    await persist(projectPath, sessionId, {
      type: "tool.call",
      id: "call-1",
      name: "edit_file",
      input: { path: "README.md" },
    });
    await persist(projectPath, sessionId, {
      type: "tool.result",
      id: "call-1",
      name: "edit_file",
      content: "ok",
      isError: false,
    });

    // Turn 2: a follow-up that changes no files. Before the fix this turn
    // produced no `run_diff` and Anita's assistant text was never persisted,
    // so the turn rendered completely empty.
    await appendEvent(projectPath, sessionId, {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: "user_message",
      data: { text: "Open a PR", attachments: [] },
    });
    await persist(projectPath, sessionId, {
      type: "assistant.text",
      text: "Opened the PR.",
    });

    const events = dedupeUserMessageEvents(await getEvents(projectPath, sessionId));
    const types = events.map((event) => event.type);

    // Both assistant turns and the tool call/result survive the round-trip.
    assert.deepEqual(types, [
      "user_message",
      "assistant_response",
      "tool_call",
      "tool_result",
      "user_message",
      "assistant_response",
    ]);

    const assistantTexts = events
      .filter((event) => event.type === "assistant_response")
      .map((event) => {
        const content = event.data.content as Array<{ type: string; text: string }>;
        return content.find((block) => block.type === "text")?.text;
      });
    assert.deepEqual(assistantTexts, ["Editing the README now.", "Opened the PR."]);

    const toolCall = events.find((event) => event.type === "tool_call");
    assert.equal(toolCall?.data.tool, "edit_file");
  });
});
