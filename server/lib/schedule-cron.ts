import parser from "cron-parser";

/*
 * Thin wrapper around `cron-parser` (issue #243).
 *
 * Cron is the on-the-wire source of truth for repeat; the CLI/UI is
 * structured-first (`--every weekday`) and only surfaces raw cron under a
 * "custom" option. This module centralizes the few cron operations the
 * scheduler needs — computing the next fire time in a given IANA timezone,
 * validating an expression, building presets from structured input, and
 * producing a human-readable summary — so the rest of the codebase never
 * touches `cron-parser` directly.
 */

export interface CronPresetOptions {
  /** "minute" | "hour" | "day" | "weekday". */
  every?: "minute" | "hour" | "day" | "weekday";
  /** 0-6 (Sun-Sat); pairs with a weekly preset. */
  onDay?: number;
  /** Hour 0-23 for day/weekly presets. Defaults to 9. */
  atHour?: number;
  /** Minute 0-59 for day/weekly presets. Defaults to 0. */
  atMinute?: number;
}

/** Resolve the server's IANA timezone, used as the schedule default. */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Throw if `cron` is not a parseable 5-field cron expression. */
export function validateCron(cron: string): void {
  try {
    parser.parseExpression(cron);
  } catch (error) {
    throw new Error(
      `Invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Throw if `timezone` is not a valid IANA zone the runtime understands. */
export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Invalid timezone "${timezone}"`);
  }
}

/**
 * Compute the next fire time strictly after `from` for `cron` in `timezone`,
 * as an ISO-8601 string. `cron-parser` handles DST transitions for the zone,
 * so a `0 9 * * 1-5` schedule keeps firing at 09:00 wall-clock across a US
 * spring-forward / fall-back boundary.
 */
export function computeNextRunAt(
  cron: string,
  timezone: string,
  from: Date = new Date()
): string {
  const interval = parser.parseExpression(cron, {
    currentDate: from,
    tz: timezone,
  });
  return interval.next().toDate().toISOString();
}

/** Translate structured preset options into a cron expression. */
export function presetToCron(options: CronPresetOptions): string {
  const minute = clamp(options.atMinute ?? 0, 0, 59);
  const hour = clamp(options.atHour ?? 9, 0, 23);
  switch (options.every) {
    case "minute":
      return "* * * * *";
    case "hour":
      return `${minute} * * * *`;
    case "day":
      return `${minute} ${hour} * * *`;
    case "weekday":
      return `${minute} ${hour} * * 1-5`;
    default:
      // No `--every`: a weekly schedule keyed off `--on-day`.
      if (options.onDay != null) {
        return `${minute} ${hour} * * ${clamp(options.onDay, 0, 6)}`;
      }
      throw new Error("presetToCron requires --every or --on-day");
  }
}

/** Best-effort human-readable summary of a cron expression. */
export function humanizeCron(cron: string): string {
  const trimmed = cron.trim();
  const presets: Record<string, string> = {
    "* * * * *": "every minute",
    "0 * * * *": "every hour",
  };
  if (presets[trimmed]) return presets[trimmed];

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed;
  const [minute, hour, dom, month, dow] = fields;
  const atTime =
    /^\d+$/.test(minute) && /^\d+$/.test(hour)
      ? `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : null;

  if (dom === "*" && month === "*") {
    if (dow === "*") return atTime ? `daily ${atTime}` : trimmed;
    if (dow === "1-5") return atTime ? `every weekday ${atTime}` : "every weekday";
    const day = WEEKDAY_NAMES[Number(dow)];
    if (day) return atTime ? `every ${day} ${atTime}` : `every ${day}`;
  }
  return trimmed;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
