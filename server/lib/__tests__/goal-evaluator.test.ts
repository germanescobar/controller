import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the goal evaluator (issue #339). The expensive path — the
 * LLM call — is replaced with a stub `callModel` so we can drive the
 * judge deterministically and assert the evaluator's bookkeeping
 * (`turnsEvaluated`, `lastReason`, the queue-enqueue safety net, and
 * the cap clears).
 */

import {
  buildSessionGoal,
  readSessionGoal,
  writeSessionGoal,
} from "../goal-state.js";
import {
  evaluateGoal,
  listGoalSessions,
  parseJudgeResponse,
  runGoalEvaluatorSweep,
  type GoalEvaluatorDeps,
} from "../goal-evaluator.js";
import { listQueue } from "../session-queue.js";
import { sessionGoalFile, sessionGoalsDir } from "../paths.js";
import { appendEvent } from "../sessions.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "goal-evaluator-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

const FIXED_NOW = new Date("2026-06-26T08:00:00.000Z");

function makeDeps(
  overrides: Partial<GoalEvaluatorDeps> = {}
): GoalEvaluatorDeps {
  return {
    // Default locateSession returns null; tests that need a real
    // location (e.g. the queue-enqueue safety net or the archived
    // check) supply their own. The evaluator treats null as
    // "session vanished, drop the goal" — a stricter contract than
    // before (issue #339 review), but the surviving tests don't
    // depend on the legacy "skip the safety net" semantics because
    // the no-project tests don't exercise the goal-attach path.
    locateSession: overrides.locateSession ?? (async () => null),
    // Default readSession returns null (no archived-signal). Tests
    // that want the "archived → clear without a model call" path
    // supply their own.
    readSession: overrides.readSession,
    // Default isSessionActive returns false. Tests that want to gate
    // on an active turn supply their own.
    isSessionActive: overrides.isSessionActive,
    // No advanceSessionQueue by default — the tests that exercise the
    // advance path supply their own.
    advanceSessionQueue: overrides.advanceSessionQueue,
    now: overrides.now ?? (() => FIXED_NOW),
    getApiKey: overrides.getApiKey ?? (async () => ({ openrouter: "test-key" })),
    model: overrides.model,
    followUpPrompt: overrides.followUpPrompt,
    callModel: overrides.callModel,
  };
}

test("parseJudgeResponse handles well-formed JSON", () => {
  const parsed = parseJudgeResponse('{"met": true, "reason": "CI is green"}');
  assert.equal(parsed.met, true);
  assert.equal(parsed.reason, "CI is green");
});

test("parseJudgeResponse defaults to not-met on malformed input", () => {
  // A malformed response must never accidentally clear the goal —
  // "default to false" is the safe direction.
  const parsed = parseJudgeResponse("not json at all");
  assert.equal(parsed.met, false);
  assert.match(parsed.reason, /could not be parsed/);
});

test("parseJudgeResponse extracts JSON from surrounding prose", () => {
  const parsed = parseJudgeResponse(
    'The judge said: {"met": false, "reason": "still failing"} — end.'
  );
  assert.equal(parsed.met, false);
  assert.match(parsed.reason, /still failing/);
});

test("evaluateGoal returns no-goal when no sidecar exists", async () => {
  await withTempHome(async () => {
    const outcome = await evaluateGoal("s-missing", makeDeps());
    assert.equal(outcome.goal, null);
    assert.equal(outcome.enqueued, false);
    assert.equal(outcome.reason, "no goal attached");
  });
});

test("evaluateGoal clears an expired goal without an LLM call", async () => {
  await withTempHome(async () => {
    await writeSessionGoal(
      buildSessionGoal("s1", {
        condition: "all checks pass",
        expiresAt: "2026-06-26T07:00:00.000Z",
      })
    );
    let callCount = 0;
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        now: () => new Date("2026-06-26T08:00:00.000Z"),
        callModel: async () => {
          callCount += 1;
          return { met: false, reason: "should not be called" };
        },
      })
    );
    assert.equal(callCount, 0, "expired goals don't hit the model");
    assert.equal(outcome.goal, null);
    assert.equal(outcome.reason, "expired");
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("evaluateGoal clears a goal that exceeds maxTurns", async () => {
  await withTempHome(async () => {
    const goal = buildSessionGoal("s1", {
      condition: "green CI",
      maxTurns: 2,
    });
    goal.turnsEvaluated = 2;
    await writeSessionGoal(goal);
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        callModel: async () => {
          throw new Error("should not be called");
        },
      })
    );
    assert.equal(outcome.goal, null);
    assert.equal(outcome.reason, "exceeded");
  });
});

test("evaluateGoal clears the goal when the model says met", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "green CI" }));
    // Plant a session file so `locateSession` resolves; the new
    // evaluator gates on a located session before paying for a model
    // call (issue #339 review).
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: true, reason: "all green" }),
      })
    );
    assert.equal(outcome.goal, null);
    assert.equal(outcome.enqueued, false);
    assert.equal(outcome.reason, "all green");
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("evaluateGoal increments turnsEvaluated on a not-met judgment", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: false, reason: "not yet" }),
      })
    );
    assert.ok(outcome.goal);
    assert.equal(outcome.goal?.turnsEvaluated, 1);
    assert.equal(outcome.goal?.lastReason, "not yet");
    // enqueue + advance fire — assert that the queue has the message.
    const queue = await listQueue("s1");
    assert.equal(queue.length, 1);
  });
});

test("evaluateGoal enqueues a follow-up when the queue is empty", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    // Plant a session file + events file so locateSession can find the
    // worktree path the evaluator needs to append events.
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: false, reason: "still going" }),
      })
    );
    assert.equal(outcome.enqueued, true);
    const queue = await listQueue("s1");
    assert.equal(queue.length, 1, "evaluator enqueues a follow-up");
    assert.match(queue[0].text, /active goal/);
  });
});

test("evaluateGoal does not enqueue when the agent already queued a follow-up", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    // Plant an item in the queue first by writing to the queue file
    // directly — `enqueueMessage` requires importing the queue module,
    // and the goal evaluator's contract is independent of how the
    // agent's queued message arrived.
    const queuesDir = path.join(home, "queues");
    mkdirSync(queuesDir, { recursive: true });
    writeFileSync(
      path.join(queuesDir, "s1.json"),
      JSON.stringify([
        {
          id: "pre-existing",
          text: "agent-queued follow-up",
          visibleText: "agent-queued follow-up",
          provider: "claude",
          model: "claude/test",
          mode: "default",
          attachmentIds: [],
          createdAt: new Date().toISOString(),
        },
      ])
    );
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: false, reason: "still going" }),
      })
    );
    assert.equal(outcome.enqueued, false, "evaluator leaves the existing queue alone");
    const queue = await listQueue("s1");
    assert.equal(queue.length, 1, "evaluator does not append");
    assert.equal(queue[0].id, "pre-existing");
  });
});

test("evaluateGoal surfaces judge failures via lastReason without losing the goal", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    // Plant a session file so the evaluator can locate the session
    // before paying for a model call.
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => {
          throw new Error("rate-limited");
        },
      })
    );
    assert.ok(outcome.goal);
    assert.match(outcome.goal?.lastReason ?? "", /judge failed: rate-limited/);
    // Goal is preserved — a transient failure must not clear it.
    const reloaded = await readSessionGoal("s1");
    assert.ok(reloaded);
    assert.match(reloaded.lastReason ?? "", /judge failed: rate-limited/);
  });
});

test("runGoalEvaluatorSweep processes every candidate", async () => {
  await withTempHome(async () => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "a" }));
    await writeSessionGoal(buildSessionGoal("s2", { condition: "b" }));
    const cleared: string[] = [];
    await runGoalEvaluatorSweep(["s1", "s2"], {
      ...makeDeps({
        callModel: async (params) => {
          // Both goals clear at the same time; the sweep iterates both.
          return { met: true, reason: "ok" };
        },
      }),
    });
    assert.equal(await readSessionGoal("s1"), null);
    assert.equal(await readSessionGoal("s2"), null);
  });
});

test("runGoalEvaluatorSweep survives a per-session failure", async () => {
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "a" }));
    await writeSessionGoal(buildSessionGoal("s2", { condition: "b" }));
    // Plant session files so locateSession resolves a real path —
    // otherwise the new "session vanished → drop the goal" branch
    // would clear the goal before the judge can stamp `lastReason`.
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    for (const sid of ["s1", "s2"]) {
      writeFileSync(
        path.join(projectPath, "sessions", `${sid}.json`),
        JSON.stringify({ id: sid, workingDirectory: projectPath })
      );
    }
    // Always throw — the sweep must not abort on a single session's
    // failure. Per-session calls run in parallel (`Promise.all`), so we
    // can't assert which one keeps `lastReason`, only that the failure
    // surface is contained.
    await runGoalEvaluatorSweep(["s1", "s2", "s3"], {
      ...makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => {
          throw new Error("boom");
        },
      }),
    });
    const s1 = await readSessionGoal("s1");
    const s2 = await readSessionGoal("s2");
    assert.ok(s1, "s1's goal survives a judge failure");
    assert.ok(s2, "s2's goal survives a judge failure");
    assert.match(s1.lastReason ?? "", /judge failed: boom/);
    assert.match(s2.lastReason ?? "", /judge failed: boom/);
  });
});

test("listGoalSessions enumerates every sidecar in the goals directory", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await listGoalSessions(), []);
    mkdirSync(sessionGoalsDir(), { recursive: true });
    writeFileSync(
      sessionGoalFile("a"),
      JSON.stringify({ sessionId: "a", condition: "x", setAt: FIXED_NOW.toISOString() })
    );
    writeFileSync(
      sessionGoalFile("b"),
      JSON.stringify({ sessionId: "b", condition: "y", setAt: FIXED_NOW.toISOString() })
    );
    // A non-JSON file should be ignored.
    writeFileSync(sessionGoalFile("c"), "garbage");
    const sessions = await listGoalSessions();
    assert.deepEqual(sessions.sort(), ["a", "b"]);
  });
});

// Verify the goal evaluator integrates with `appendEvent` for the
// `goal_cleared` event — the route uses `appendEvent` to record the
// clear in the session event log so the UI can show it.
test("evaluateGoal emits a goal_cleared event when the cap clears the goal", async () => {
  await withTempHome(async (home) => {
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    const goal = buildSessionGoal("s1", {
      condition: "x",
      maxTurns: 1,
    });
    goal.turnsEvaluated = 1;
    await writeSessionGoal(goal);
    await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
      })
    );
    // Read the events log directly to confirm the `goal_cleared` event
    // landed. We import `appendEvent` to verify the side effect is
    // observable end-to-end without leaning on the UI surface.
    const events = await import("../sessions.js");
    const log = await events.getEvents(projectPath, "s1");
    const cleared = log.find((e) => e.type === "goal_cleared");
    assert.ok(cleared, "goal_cleared event is appended");
    assert.equal(cleared.data.reason, "exceeded");
  });
});

// --- Issue #339 review fixes ---

test("evaluateGoal skips judgment while the session is mid-turn", async () => {
  // Without this gate, a 5-turn goal could be exhausted by repeated
  // ticks of one long run, each one paying for an OpenRouter call
  // against an unchanged transcript.
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    let callCount = 0;
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        isSessionActive: () => true,
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => {
          callCount += 1;
          return { met: false, reason: "still going" };
        },
      })
    );
    assert.equal(callCount, 0, "no model call when the session is mid-turn");
    assert.equal(outcome.reason, "session is mid-turn");
    // Goal survives — the active gate is a skip, not a clear.
    const reloaded = await readSessionGoal("s1");
    assert.ok(reloaded);
    assert.equal(reloaded.turnsEvaluated, 0);
  });
});

test("evaluateGoal clears an archived session's goal without an LLM call", async () => {
  // The session was archived; the evaluator must not keep paying for
  // it. The clear path emits a goal_cleared event with reason
  // "archived" so the UI can show the cause.
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath, status: "archived" })
    );
    let callCount = 0;
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        readSession: async () => ({
          id: "s1",
          workingDirectory: projectPath,
          status: "archived",
        }),
        callModel: async () => {
          callCount += 1;
          return { met: false, reason: "x" };
        },
      })
    );
    assert.equal(callCount, 0, "no model call for archived sessions");
    assert.equal(outcome.goal, null);
    assert.equal(outcome.reason, "archived");
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("evaluateGoal drops the goal when locateSession cannot resolve the session", async () => {
  // Session was deleted between enqueue and tick; the sidecar would
  // accumulate as cruft otherwise.
  await withTempHome(async () => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => null,
      })
    );
    assert.equal(outcome.goal, null);
    assert.equal(outcome.reason, "session not found");
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("evaluateGoal reuses the session's provider/model on continuation enqueue", async () => {
  // A Codex (or any non-Claude) goal must not resume through Claude
  // just because the evaluator's payload hardcoded provider: "claude".
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({
        id: "s1",
        workingDirectory: projectPath,
        provider: "codex",
        model: "gpt-5",
        mode: "default",
      })
    );
    const advanceCalls: Array<{ projectId: string; sessionId: string }> = [];
    await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        readSession: async () => ({
          id: "s1",
          workingDirectory: projectPath,
          provider: "codex",
          model: "gpt-5",
          mode: "default",
        }),
        callModel: async () => ({ met: false, reason: "still going" }),
        advanceSessionQueue: async (projectId, _worktreeId, sessionId) => {
          advanceCalls.push({ projectId, sessionId });
        },
      })
    );
    const queue = await listQueue("s1");
    assert.equal(queue.length, 1);
    assert.equal(queue[0].provider, "codex");
    assert.equal(queue[0].model, "gpt-5");
    assert.equal(queue[0].origin, "goal");
    assert.equal(advanceCalls.length, 1, "evaluator fires the queue advance");
    assert.equal(advanceCalls[0].projectId, "proj-1");
    assert.equal(advanceCalls[0].sessionId, "s1");
  });
});

test("evaluateGoal does not fire advanceSessionQueue when the agent already queued", async () => {
  // If the queue is non-empty when the evaluator runs, the evaluator
  // should not enqueue nor advance — the agent's own queue item
  // drains through the existing pipeline.
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    // Plant a pre-existing queue item.
    const queuesDir = path.join(home, "queues");
    mkdirSync(queuesDir, { recursive: true });
    writeFileSync(
      path.join(queuesDir, "s1.json"),
      JSON.stringify([
        {
          id: "pre-existing",
          text: "agent follow-up",
          visibleText: "agent follow-up",
          provider: "codex",
          model: "gpt-5",
          mode: "default",
          attachmentIds: [],
          createdAt: new Date().toISOString(),
        },
      ])
    );
    let advanceCalls = 0;
    const outcome = await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: false, reason: "still going" }),
        advanceSessionQueue: async () => {
          advanceCalls += 1;
        },
      })
    );
    assert.equal(outcome.enqueued, false);
    assert.equal(advanceCalls, 0);
  });
});

test("evaluateGoal tolerates advanceSessionQueue failures", async () => {
  // A failed advance shouldn't undo the enqueue or clear the goal —
  // the message stays in the queue for the next scheduler tick /
  // run-completion to drain.
  await withTempHome(async (home) => {
    await writeSessionGoal(buildSessionGoal("s1", { condition: "x" }));
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
    mkdirSync(path.join(projectPath, "events"), { recursive: true });
    writeFileSync(
      path.join(projectPath, "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: projectPath })
    );
    await evaluateGoal(
      "s1",
      makeDeps({
        locateSession: async () => ({
          projectId: "proj-1",
          worktreeId: "wt-1",
          worktreePath: projectPath,
        }),
        callModel: async () => ({ met: false, reason: "still going" }),
        advanceSessionQueue: async () => {
          throw new Error("advance crashed");
        },
      })
    );
    // The enqueue still happened; the failure is logged not surfaced.
    const queue = await listQueue("s1");
    assert.equal(queue.length, 1);
    const reloaded = await readSessionGoal("s1");
    assert.ok(reloaded, "goal survives an advance failure");
    assert.equal(reloaded.turnsEvaluated, 1);
  });
});

// Silence an unused import warning — appendEvent is used via the events
// log read in the test above; the explicit reference keeps the
// dependency obvious to readers.
void appendEvent;