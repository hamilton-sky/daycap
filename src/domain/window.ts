/**
 * The usage-day boundary. PURE — no fs, no net, no `Date.now()`, no `node:*`.
 *
 * Timezone maths goes through `Intl` (ECMA-402), which is part of the language, not the platform.
 * `Date.now()` is never called: every function takes the instant as an argument so C14 (clock
 * independence) can hold.
 *
 * PRE-G (OPEN) decides which zone the product passes in. This module does not decide it — it makes
 * the axis an explicit, testable parameter instead of an implied one. Measured consequence of
 * getting it wrong: 1.90x on the spike machine ($16.37 UTC vs $31.13 local for one date).
 * See SPIKE_RESULT.md §4, §7.
 */

import type { UsageWindow } from "./types.ts";

/** Thrown for a malformed zone, reset hour, or day label. Never a bare RangeError. */
export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

type CivilTime = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
};

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The host's zone, used when `tz` is null (e.g. `TZ` unset). Prefer injecting
 * `ClockPort.timezone()`; this is the last resort so a missing zone degrades to something
 * defensible rather than throwing.
 */
function hostZone(): string {
  const resolved = new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
  // Node's Intl always resolves a zone. This fallback exists so a stripped or broken ICU build
  // degrades to UTC instead of throwing; it is unreachable in test, hence the ignore.
  /* v8 ignore start */
  if (resolved === undefined || resolved.length === 0) {
    return "UTC";
  }
  /* v8 ignore stop */
  return resolved;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone);
  if (cached !== undefined) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(zone, fmt);
  return fmt;
}

function resolveZone(tz: string | null): string {
  const zone = tz === null ? hostZone() : tz;
  try {
    // Constructing the formatter is the only reliable validity check for an IANA name.
    formatterFor(zone);
  } catch {
    throw new WindowError(`unknown IANA time zone: ${JSON.stringify(tz)}`);
  }
  return zone;
}

/** The wall clock in `zone` at instant `tsMs`. */
function civilAt(tsMs: number, zone: string): CivilTime {
  const parts = formatterFor(zone).formatToParts(new Date(tsMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    // Intl emits every field the formatter requested; this guards a non-conforming
    // implementation rather than any reachable input.
    /* v8 ignore start */
    if (part === undefined) throw new WindowError(`Intl omitted "${type}" for zone ${zone}`);
    /* v8 ignore stop */
    return Number.parseInt(part.value, 10);
  };
  const rawHour = get("hour");
  // Some older ICU builds report midnight as 24 under h23; normalise defensively.
  /* v8 ignore next */
  const hour = rawHour === 24 ? 0 : rawHour;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset in ms such that `civil-as-if-UTC = tsMs + offset`. */
function offsetAt(tsMs: number, zone: string): number {
  const c = civilAt(tsMs, zone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - tsMs;
}

/**
 * Instant for a wall-clock time in `zone`.
 *
 * Both plausible offsets are probed — the one in force a day before the target and the one a day
 * after — which brackets any DST transition (real transitions are months apart, never within
 * 24 h of each other). Each resulting candidate is verified by formatting it back and comparing
 * the local hour.
 *
 * Disambiguation follows Temporal's `compatible` mode:
 * - **Unambiguous:** both probes yield the same instant; it round-trips; return it.
 * - **Ambiguous** (fall back — the local time occurs twice): both candidates round-trip; return
 *   the *earlier*, i.e. the first occurrence.
 * - **Gap** (spring forward — the local time never occurs): neither round-trips; return the
 *   *later*, which is the instant the shifted clock actually reaches. Taking the earlier here
 *   would resolve backwards and silently turn a 23-hour day into a 24-hour one.
 *
 * A naive two-pass refinement (offset at the guess, then offset at that result) is NOT sufficient:
 * it resolves gaps backwards in `America/New_York` and forwards in `Europe/London`, depending on
 * which side of the transition the naive guess lands.
 */
function civilToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  zone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const candidates = [
    guess - offsetAt(guess - MS_PER_DAY, zone),
    guess - offsetAt(guess + MS_PER_DAY, zone),
  ];
  const valid = candidates.filter((c) => civilAt(c, zone).hour === hour);
  if (valid.length === 0) {
    return Math.max(...candidates); // gap: shift forward
  }
  return Math.min(...valid); // unambiguous, or first of two occurrences
}

function assertResetHour(resetHourLocal: number): void {
  if (!Number.isInteger(resetHourLocal) || resetHourLocal < 0 || resetHourLocal > 23) {
    throw new WindowError(`resetHourLocal must be an integer 0-23, got ${resetHourLocal}`);
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function label(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Civil date arithmetic — DST-safe because it never touches instants. */
function addCivilDays(year: number, month: number, day: number, delta: number): CivilTime {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/**
 * The usage-day label (`YYYY-MM-DD`) that instant `tsMs` belongs to.
 *
 * With `resetHourLocal = 0` this is simply the local calendar date. With `resetHourLocal = 4`,
 * anything before 04:00 local counts toward the previous day — so 03:59 on the 5th is "the 4th".
 *
 * @param tsMs epoch milliseconds. Never defaulted to now.
 * @param resetHourLocal integer 0-23.
 * @param tz IANA zone, or null for the host zone.
 */
export function usageDayFor(tsMs: number, resetHourLocal: number, tz: string | null): string {
  if (!Number.isFinite(tsMs)) {
    throw new WindowError(`tsMs must be a finite number, got ${tsMs}`);
  }
  assertResetHour(resetHourLocal);
  const zone = resolveZone(tz);
  const c = civilAt(tsMs, zone);
  if (c.hour >= resetHourLocal) return label(c.year, c.month, c.day);
  const prev = addCivilDays(c.year, c.month, c.day, -1);
  return label(prev.year, prev.month, prev.day);
}

const DAY_LABEL = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLabel(usageDay: string): { year: number; month: number; day: number } {
  const m = DAY_LABEL.exec(usageDay);
  if (m === null) {
    throw new WindowError(`usageDay must be YYYY-MM-DD, got ${JSON.stringify(usageDay)}`);
  }
  const year = Number.parseInt(m[1] as string, 10);
  const month = Number.parseInt(m[2] as string, 10);
  const day = Number.parseInt(m[3] as string, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new WindowError(`usageDay is not a real date: ${usageDay}`);
  }
  return { year, month, day };
}

/**
 * The half-open instant range `[from, to)` covering a usage day.
 *
 * Half-open is deliberate and is the shape every collector query needs. It also matches budi's
 * HTTP `until`, which is EXCLUSIVE — while budi's own CLI `--until` is INCLUSIVE, and ccusage's is
 * INCLUSIVE. Adapters convert; the domain has exactly one convention. See SPIKE_RESULT.md §3.
 */
export function usageDayRange(
  usageDay: string,
  resetHourLocal: number,
  tz: string | null,
): UsageWindow {
  assertResetHour(resetHourLocal);
  const zone = resolveZone(tz);
  const { year, month, day } = parseLabel(usageDay);
  const startMs = civilToInstant(year, month, day, resetHourLocal, zone);
  const next = addCivilDays(year, month, day, 1);
  const endMs = civilToInstant(next.year, next.month, next.day, resetHourLocal, zone);
  return { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() };
}

/**
 * How far through the usage day `tsMs` is, in [0, 1]. Feeds pacing (P2).
 *
 * Length is measured in real elapsed time, so a 23-hour spring-forward day and a 25-hour
 * fall-back day both pace correctly — a fixed 86_400_000 divisor would drift by an hour.
 */
export function dayElapsedFraction(
  tsMs: number,
  resetHourLocal: number,
  tz: string | null,
): number {
  const day = usageDayFor(tsMs, resetHourLocal, tz);
  const { from, to } = usageDayRange(day, resetHourLocal, tz);
  const startMs = Date.parse(from);
  const endMs = Date.parse(to);
  const span = endMs - startMs;
  const fraction = (tsMs - startMs) / span;
  // usageDayFor guarantees tsMs lies inside its own day, so neither clamp can trigger today.
  // Retained so a future caller passing an arbitrary instant cannot emit a nonsensical ratio.
  /* v8 ignore start */
  if (fraction < 0) return 0;
  if (fraction > 1) return 1;
  /* v8 ignore stop */
  return fraction;
}

/** Real length of a usage day in minutes. 1440 normally; 1380 or 1500 across a DST shift. */
export function usageDayLengthMinutes(
  usageDay: string,
  resetHourLocal: number,
  tz: string | null,
): number {
  const { from, to } = usageDayRange(usageDay, resetHourLocal, tz);
  return (Date.parse(to) - Date.parse(from)) / MS_PER_MINUTE;
}
