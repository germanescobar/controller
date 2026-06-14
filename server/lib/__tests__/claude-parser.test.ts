import test from "node:test";
import assert from "node:assert/strict";
import { getAgentProvider, type AgentStreamEvent } from "../agents.js";

const claude = getAgentProvider("claude");
assert.ok(claude, "claude provider must be registered");

type ParserLine = (line: string) => AgentStreamEvent | AgentStreamEvent[] | null;
type ParserFactory = () => ParserLine;

function createParser(): ParserLine {
  assert.ok(claude, "claude provider must be registered");
  assert.ok(
    typeof claude.createParser === "function",
    "claude provider must expose createParser"
  );
  const factory = claude.createParser as ParserFactory;
  return factory();
}

/** Flatten a single parser return into the sequence of normalized events. */
function emit(result: AgentStreamEvent | AgentStreamEvent[] | null): AgentStreamEvent[] {
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

test("can_use_tool control_request maps to a tool.approval_requested event", () => {
  const parse = createParser();
  const events = emit(
    parse(
      JSON.stringify({
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          input: { command: "touch x" },
          permission_suggestions: [
            { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow" },
          ],
        },
      })
    )
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "tool.approval_requested");
  if (event.type !== "tool.approval_requested") return;
  assert.equal(event.id, "req-1");
  assert.equal(event.toolUseId, "toolu_1");
  assert.equal(event.toolName, "Bash");
  assert.deepEqual(event.input, { command: "touch x" });
  assert.equal(event.suggestions.length, 1);
});

test("a control_request without a request_id is dropped", () => {
  const parse = createParser();
  const events = emit(
    parse(
      JSON.stringify({
        type: "control_request",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
      })
    )
  );
  assert.deepEqual(events, []);
});

test("the init-handshake control_response is ignored", () => {
  const parse = createParser();
  const events = emit(
    parse(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "init", response: {} },
      })
    )
  );
  assert.deepEqual(events, []);
});

test("ExitPlanMode tool_use surfaces only the plan text (approval drives the gate)", () => {
  const parse = createParser();
  const events = emit(
    parse(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "ExitPlanMode",
              input: { plan: "Step 1\nStep 2" },
            },
          ],
        },
      })
    )
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "assistant.text", text: "Step 1\nStep 2" });
});
