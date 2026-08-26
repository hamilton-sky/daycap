import { describe, expect, it } from "vitest";
import {
  dayElapsedFraction,
  usageDayFor,
  usageDayLengthMinutes,
  usageDayRange,
  WindowError,
} from "../../src/domain/window.ts";

const NY = "America/New_York";
const LDN = "Europe/London";
const JLM = "Asia/Jerusalem";

/** Instant helper — explicit UTC, so no test depends on the host zone. */
const utc = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test instant: ${iso}`);
  return ms;
};

describe("usageDayFor — resetHourLocal 0", () => {
  it.each([
    // instant (UTC)            zone   expected day    why
    ["2026-08-25T00:00:00Z", "UTC", "2026-08-25", "midnight UTC is the new day"],
    ["2026-08-25T23:59:59Z", "UTC", "2026-08-25", "last second of the day"],
    ["2026-08-25T03:59:59Z", NY, "2026-08-24", "23:59 EDT is still the 24th"],
    ["2026-08-25T04:00:00Z", NY, "2026-08-25", "00:00 EDT rolls over"],
    ["2026-08-24T21:00:00Z", JLM, "2026-08-25", "UTC+3 is already tomorrow"],
    ["2026-08-24T20:59:59Z", JLM, "2026-08-24", "one second earlier is not"],
  ])("%s in %s -> %s (%s)", (instant, zone, expected) => {
    expect(usageDayFor(utc(instant as string), 0, zone as string)).toBe(expected);
  });
});

describe("usageDayFor — resetHourLocal 4", () => {
  it.each([
    ["2026-08-25T03:59:59Z", "UTC", "2026-08-24", "03:59 belongs to the previous day"],
    ["2026-08-25T04:00:00Z", "UTC", "2026-08-25", "04:00 starts the new day"],
    ["2026-08-25T00:00:00Z", "UTC", "2026-08-24", "midnight is not the boundary any more"],
    ["2026-08-25T07:59:59Z", NY, "2026-08-24", "03:59 EDT"],
    ["2026-08-25T08:00:00Z", NY, "2026-08-25", "04:00 EDT"],
  ])("%s in %s -> %s (%s)", (instant, zone, expected) => {
    expect(usageDayFor(utc(instant as string), 4, zone as string)).toBe(expected);
  });

  it("crosses the month boundary backwards", () => {
    expect(usageDayFor(utc("2026-09-01T02:00:00Z"), 4, "UTC")).toBe("2026-08-31");
  });

  it("crosses the year boundary backwards", () => {
    expect(usageDayFor(utc("2026-01-01T01:00:00Z"), 4, "UTC")).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(usageDayFor(utc("2028-03-01T02:00:00Z"), 4, "UTC")).toBe("2028-02-29");
  });
});

describe("boundary is exact to the millisecond", () => {
  it.each([
    [0, "2026-08-25T00:00:00.000Z", "2026-08-25"],
    [0, "2026-08-24T23:59:59.999Z", "2026-08-24"],
    [4, "2026-08-25T04:00:00.000Z", "2026-08-25"],
    [4, "2026-08-25T03:59:59.999Z", "2026-08-24"],
  ])("resetHour %i at %s -> %s", (resetHour, instant, expected) => {
    expect(usageDayFor(utc(instant as string), resetHour as number, "UTC")).toBe(expected);
  });
});

/**
 * DST. America/New_York springs forward 2026-03-08 (02:00 -> 03:00, a 23h day) and falls back
 * 2026-11-01 (01:00 -> 00:00 repeats, a 25h day). Europe/London springs forward 2026-03-29 and
 * falls back 2026-10-25.
 */
describe("DST — spring forward (23-hour day)", () => {
  it("New York 2026-03-08 is 23 hours long", () => {
    expect(usageDayLengthMinutes("2026-03-08", 0, NY)).toBe(23 * 60);
  });

  it("London 2026-03-29 is 23 hours long", () => {
    expect(usageDayLengthMinutes("2026-03-29", 0, LDN)).toBe(23 * 60);
  });

  it("labels instants either side of the New York gap", () => {
    // 06:59Z = 01:59 EST (still the 8th); 07:00Z = 03:00 EDT (the clock skipped 02:00)
    expect(usageDayFor(utc("2026-03-08T06:59:59Z"), 0, NY)).toBe("2026-03-08");
    expect(usageDayFor(utc("2026-03-08T07:00:00Z"), 0, NY)).toBe("2026-03-08");
  });

  /**
   * The two zones resolve a gap in opposite directions under a naive two-pass refinement — New
   * York backwards, London forwards — so both are pinned. A regression shows up as a 24-hour
   * spring-forward day.
   */
  it("resolves a New York gap forwards, not backwards", () => {
    // 02:00 local does not exist on 2026-03-08 in New York; the clock reaches 03:00 EDT = 07:00Z.
    expect(usageDayRange("2026-03-08", 2, NY).from).toBe("2026-03-08T07:00:00.000Z");
  });

  it("resolves a London gap forwards, not backwards", () => {
    // 01:00 local does not exist on 2026-03-29 in London; the clock reaches 02:00 BST = 01:00Z.
    expect(usageDayRange("2026-03-29", 1, LDN).from).toBe("2026-03-29T01:00:00.000Z");
  });

  it("keeps a London gap day 23 hours long at a reset hour inside the gap", () => {
    expect(usageDayLengthMinutes("2026-03-29", 1, LDN)).toBe(23 * 60);
  });

  it("a resetHour inside the skipped hour still yields a usable range", () => {
    // 02:00 local does not exist on 2026-03-08 in New York.
    const range = usageDayRange("2026-03-08", 2, NY);
    expect(Date.parse(range.to)).toBeGreaterThan(Date.parse(range.from));
    // The day is still shortened by the transition.
    expect(usageDayLengthMinutes("2026-03-08", 2, NY)).toBe(23 * 60);
  });
});

describe("DST — fall back (25-hour day)", () => {
  it("New York 2026-11-01 is 25 hours long", () => {
    expect(usageDayLengthMinutes("2026-11-01", 0, NY)).toBe(25 * 60);
  });

  it("London 2026-10-25 is 25 hours long", () => {
    expect(usageDayLengthMinutes("2026-10-25", 0, LDN)).toBe(25 * 60);
  });

  it("resolves an ambiguous local time to the first occurrence", () => {
    // 01:00 occurs twice on 2026-11-01 in New York: 05:00Z (EDT) then 06:00Z (EST).
    expect(usageDayRange("2026-11-01", 1, NY).from).toBe("2026-11-01T05:00:00.000Z");
  });

  it("labels both passes through the repeated hour as the same day", () => {
    // 05:00Z = 01:00 EDT (first pass), 06:00Z = 01:00 EST (second pass)
    expect(usageDayFor(utc("2026-11-01T05:00:00Z"), 0, NY)).toBe("2026-11-01");
    expect(usageDayFor(utc("2026-11-01T06:00:00Z"), 0, NY)).toBe("2026-11-01");
  });
});

describe("usageDayRange", () => {
  it("is half-open and contiguous with the next day", () => {
    const a = usageDayRange("2026-08-25", 0, "UTC");
    const b = usageDayRange("2026-08-26", 0, "UTC");
    expect(a.from).toBe("2026-08-25T00:00:00.000Z");
    expect(a.to).toBe("2026-08-26T00:00:00.000Z");
    expect(a.to).toBe(b.from);
  });

  it("honours resetHourLocal", () => {
    const r = usageDayRange("2026-08-25", 4, "UTC");
    expect(r.from).toBe("2026-08-25T04:00:00.000Z");
    expect(r.to).toBe("2026-08-26T04:00:00.000Z");
  });

  it("shifts by the zone offset", () => {
    // Asia/Jerusalem is UTC+3 in August, so the local day starts at 21:00Z the day before.
    const r = usageDayRange("2026-08-25", 0, JLM);
    expect(r.from).toBe("2026-08-24T21:00:00.000Z");
    expect(r.to).toBe("2026-08-25T21:00:00.000Z");
  });

  it("round-trips with usageDayFor at both edges", () => {
    const day = "2026-08-25";
    const { from, to } = usageDayRange(day, 4, NY);
    expect(usageDayFor(Date.parse(from), 4, NY)).toBe(day);
    expect(usageDayFor(Date.parse(to) - 1, 4, NY)).toBe(day);
    expect(usageDayFor(Date.parse(to), 4, NY)).not.toBe(day);
  });

  it("is contiguous across a spring-forward transition", () => {
    const a = usageDayRange("2026-03-07", 0, NY);
    const b = usageDayRange("2026-03-08", 0, NY);
    const c = usageDayRange("2026-03-09", 0, NY);
    expect(a.to).toBe(b.from);
    expect(b.to).toBe(c.from);
  });

  it("is contiguous across a fall-back transition", () => {
    const a = usageDayRange("2026-10-31", 0, NY);
    const b = usageDayRange("2026-11-01", 0, NY);
    const c = usageDayRange("2026-11-02", 0, NY);
    expect(a.to).toBe(b.from);
    expect(b.to).toBe(c.from);
  });
});

/**
 * PRE-G in one test. This is the 1.90x the spike measured, reduced to an assertion: the same
 * instant belongs to different usage days depending on the axis. Whichever axis PRE-G picks, this
 * test documents that the choice is observable.
 */
describe("PRE-G — the axis is observable", () => {
  it("puts one instant on different days under UTC and local", () => {
    const instant = utc("2026-08-24T22:30:00Z");
    expect(usageDayFor(instant, 0, "UTC")).toBe("2026-08-24");
    expect(usageDayFor(instant, 0, JLM)).toBe("2026-08-25");
  });
});

describe("dayElapsedFraction", () => {
  it("is 0 at the boundary and ~0.5 at midday", () => {
    expect(dayElapsedFraction(utc("2026-08-25T00:00:00Z"), 0, "UTC")).toBe(0);
    expect(dayElapsedFraction(utc("2026-08-25T12:00:00Z"), 0, "UTC")).toBeCloseTo(0.5, 10);
  });

  it("clamps to [0,1]", () => {
    const f = dayElapsedFraction(utc("2026-08-25T23:59:59.999Z"), 0, "UTC");
    expect(f).toBeGreaterThan(0.999);
    expect(f).toBeLessThanOrEqual(1);
  });

  it("uses real elapsed time on a 23-hour day, not 24", () => {
    // Midday local on the short day is past the halfway point of a 23h span.
    const f = dayElapsedFraction(utc("2026-03-08T16:00:00Z"), 0, NY); // 12:00 EDT
    expect(f).toBeCloseTo((12 - 1) / 23, 6);
  });

  it("uses real elapsed time on a 25-hour day", () => {
    const f = dayElapsedFraction(utc("2026-11-01T16:00:00Z"), 0, NY); // 11:00 EST
    expect(f).toBeCloseTo(12 / 25, 6);
  });
});

describe("TZ unset / null zone", () => {
  it("resolves to the host zone and returns a well-formed label", () => {
    const day = usageDayFor(utc("2026-08-25T12:00:00Z"), 0, null);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is self-consistent with the range it produces", () => {
    const ts = utc("2026-08-25T12:00:00Z");
    const day = usageDayFor(ts, 0, null);
    const { from, to } = usageDayRange(day, 0, null);
    expect(Date.parse(from)).toBeLessThanOrEqual(ts);
    expect(Date.parse(to)).toBeGreaterThan(ts);
  });

  it("agrees with an explicit zone equal to the host zone", () => {
    const host = new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
    const ts = utc("2026-08-25T12:00:00Z");
    expect(usageDayFor(ts, 0, null)).toBe(usageDayFor(ts, 0, host));
  });

  it("computes a day length for the host zone", () => {
    expect(usageDayLengthMinutes("2026-08-25", 0, null)).toBeGreaterThan(0);
  });
});

describe("no hidden clock (C14)", () => {
  it("is a pure function of its arguments", () => {
    const ts = utc("2026-08-25T12:00:00Z");
    const first = usageDayFor(ts, 0, NY);
    const second = usageDayFor(ts, 0, NY);
    expect(first).toBe(second);
  });

  it("never reads Date.now — a stubbed now cannot change the answer", () => {
    const ts = utc("2026-08-25T12:00:00Z");
    const before = usageDayFor(ts, 0, NY);
    const realNow = Date.now;
    try {
      Date.now = () => utc("1999-01-01T00:00:00Z");
      expect(usageDayFor(ts, 0, NY)).toBe(before);
      expect(usageDayRange("2026-08-25", 0, NY).from).toBe(usageDayRange("2026-08-25", 0, NY).from);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("input validation", () => {
  it.each([
    [Number.NaN, "NaN instant"],
    [Number.POSITIVE_INFINITY, "infinite instant"],
  ])("rejects %s (%s)", (ts) => {
    expect(() => usageDayFor(ts as number, 0, "UTC")).toThrow(WindowError);
  });

  it.each([-1, 24, 1.5, Number.NaN])("rejects resetHourLocal %s", (h) => {
    expect(() => usageDayFor(utc("2026-08-25T12:00:00Z"), h as number, "UTC")).toThrow(WindowError);
  });

  it("accepts the extreme legal reset hours", () => {
    expect(usageDayFor(utc("2026-08-25T12:00:00Z"), 0, "UTC")).toBe("2026-08-25");
    expect(usageDayFor(utc("2026-08-25T23:59:00Z"), 23, "UTC")).toBe("2026-08-25");
  });

  it("rejects an unknown IANA zone with a typed error, not a RangeError", () => {
    expect(() => usageDayFor(utc("2026-08-25T12:00:00Z"), 0, "Mars/Olympus_Mons")).toThrow(
      WindowError,
    );
  });

  it.each(["2026-8-25", "26-08-25", "", "2026-08-25T00:00:00Z", "2026-13-01", "2026-01-32"])(
    "rejects malformed usageDay %s",
    (label) => {
      expect(() => usageDayRange(label as string, 0, "UTC")).toThrow(WindowError);
    },
  );

  it("rejects a bad reset hour in usageDayRange too", () => {
    expect(() => usageDayRange("2026-08-25", 99, "UTC")).toThrow(WindowError);
  });
});
