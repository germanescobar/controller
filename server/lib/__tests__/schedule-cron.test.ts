import test from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRunAt,
  humanizeCron,
  presetToCron,
  validateCron,
  validateTimezone,
} from "../schedule-cron.js";

/*
 * Issue #243: cron wrapper. The DST cases are the load-bearing ones — a
 * `0 9 * * 1-5` schedule must keep firing at 09:00 wall-clock in its zone
 * across both US transitions, which means the UTC instant shifts by an hour.
 */

test("computeNextRunAt returns the next occurrence strictly after `from`", () => {
  const from = new Date("2026-06-26T08:00:00.000Z");
  const next = computeNextRunAt("*/15 * * * *", "UTC", from);
  assert.equal(next, "2026-06-26T08:15:00.000Z");
});

test("computeNextRunAt holds 09:00 wall-clock across US spring-forward (EST→EDT)", () => {
  // DST 2026 begins Sunday March 8. The 09:00 ET weekday run on Friday
  // March 6 is EST (UTC-5 → 14:00Z); the next weekday run, Monday March 9,
  // is EDT (UTC-4 → 13:00Z).
  const fridayBefore = new Date("2026-03-06T15:00:00.000Z"); // after Fri 09:00 ET
  const next = computeNextRunAt("0 9 * * 1-5", "America/New_York", fridayBefore);
  assert.equal(next, "2026-03-09T13:00:00.000Z");
});

test("computeNextRunAt holds 09:00 wall-clock across US fall-back (EDT→EST)", () => {
  // DST 2026 ends Sunday November 1. Friday October 30 09:00 ET is EDT
  // (13:00Z); Monday November 2 09:00 ET is EST (14:00Z).
  const fridayBefore = new Date("2026-10-30T14:00:00.000Z"); // after Fri 09:00 ET
  const next = computeNextRunAt("0 9 * * 1-5", "America/New_York", fridayBefore);
  assert.equal(next, "2026-11-02T14:00:00.000Z");
});

test("validateCron throws on a malformed expression", () => {
  assert.throws(() => validateCron("not a cron"), /Invalid cron expression/);
  assert.doesNotThrow(() => validateCron("0 9 * * 1-5"));
});

test("validateTimezone throws on an unknown zone", () => {
  assert.throws(() => validateTimezone("Mars/Phobos"), /Invalid timezone/);
  assert.doesNotThrow(() => validateTimezone("America/New_York"));
});

test("presetToCron maps structured presets to cron expressions", () => {
  assert.equal(presetToCron({ every: "minute" }), "* * * * *");
  assert.equal(presetToCron({ every: "hour", atMinute: 30 }), "30 * * * *");
  assert.equal(presetToCron({ every: "day", atHour: 8, atMinute: 15 }), "15 8 * * *");
  assert.equal(presetToCron({ every: "weekday", atHour: 9 }), "0 9 * * 1-5");
  assert.equal(presetToCron({ onDay: 1, atHour: 7 }), "0 7 * * 1");
});

test("presetToCron clamps out-of-range values", () => {
  assert.equal(presetToCron({ every: "day", atHour: 99, atMinute: -5 }), "0 23 * * *");
});

test("presetToCron throws when given no preset", () => {
  assert.throws(() => presetToCron({}), /requires --every or --on-day/);
});

test("humanizeCron summarizes common shapes", () => {
  assert.equal(humanizeCron("* * * * *"), "every minute");
  assert.equal(humanizeCron("0 8 * * *"), "daily at 08:00");
  assert.equal(humanizeCron("0 9 * * 1-5"), "every weekday at 09:00");
  assert.equal(humanizeCron("30 7 * * 1"), "every Monday at 07:30");
});
