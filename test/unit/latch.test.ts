import { describe, expect, it } from "vitest";
import { evaluateLatch, firedKey, isLatchState, type LatchState } from "../../src/app/latch.ts";
import type { Threshold } from "../../src/domain/types.ts";

const DAY = "2026-08-26";
const NOW = "2026-08-26T15:02:11.442Z";
const TH: Threshold[] = [0.8, 1];

type Step = Partial<Parameters<typeof evaluateLatch>[0]>;
const step = (over: Step = {}) =>
  evaluateLatch({
    prev: null,
    day: DAY,
    signal: "usd",
    fraction: 0,
    thresholds: TH,
    nowIso: NOW,
    trusted: true,
    ...over,
  });

/** Replay a sequence of fractions through the latch, threading state. */
function replay(fractions: number[], opts: Step = {}): { fires: Threshold[]; state: LatchState } {
  // `prev` is threaded from the previous iteration, so it is pulled out of `opts` up front rather
  // than spread in — spreading it would silently reset the chain on every step.
  const { prev: seed, ...rest } = opts;
  let prev: LatchState | null = (seed as LatchState | null) ?? null;
  const fires: Threshold[] = [];
  for (const fraction of fractions) {
    const r = evaluateLatch({
      day: DAY,
      signal: "usd",
      fraction,
      thresholds: TH,
      nowIso: NOW,
      trusted: true,
      ...rest,
      prev,
    });
    prev = r.next;
    fires.push(...r.toFire);
  }
  return { fires, state: prev as LatchState };
}

describe("L1/L2 — fire once, at or above the threshold", () => {
  it("L1 fires when the fraction reaches the threshold", () => {
    expect(step({ fraction: 0.8 }).toFire).toEqual([0.8]);
  });
  it("does not fire below it", () => {
    expect(step({ fraction: 0.79 }).toFire).toEqual([]);
  });
  it("L2 does not fire again for a threshold already recorded today", () => {
    const first = step({ fraction: 0.85 });
    const second = evaluateLatch({
      prev: first.next,
      day: DAY,
      signal: "usd",
      fraction: 0.9,
      thresholds: TH,
      nowIso: NOW,
      trusted: true,
    });
    expect(first.toFire).toEqual([0.8]);
    expect(second.toFire).toEqual([]);
  });
});

describe("L3 — a new day replaces, never merges", () => {
  it("discards yesterday's fires entirely and re-arms", () => {
    const yesterday: LatchState = {
      schema: 1,
      usageDay: "2026-08-25",
      fired: { [firedKey("usd", 0.8)]: NOW, [firedKey("usd", 1)]: NOW },
    };
    const r = step({ prev: yesterday, fraction: 0.85 });
    expect(r.toFire).toEqual([0.8]);
    expect(r.next.usageDay).toBe(DAY);
    // Merging would leak the 1.0 entry into today and silence today's over-budget alert.
    expect(Object.keys(r.next.fired)).toEqual([firedKey("usd", 0.8)]);
  });
});

describe("L4 — a dip never re-arms", () => {
  it("crossing, dipping, and crossing again fires exactly once", () => {
    expect(replay([0.85, 0.5, 0.9]).fires).toEqual([0.8]);
  });

  it("a sawtooth across the threshold fifty times still fires once", () => {
    const saw = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.85 : 0.5));
    expect(replay(saw).fires).toEqual([0.8]);
  });
});

describe("L5 — several thresholds in one step fire ascending", () => {
  it("a single jump from 0 to 1.2 fires 0.8 then 1.0, in that order", () => {
    expect(replay([0, 1.2]).fires).toEqual([0.8, 1]);
  });
});

describe("L6 — an unreadable latch fails quiet", () => {
  it("fires nothing and marks every threshold as already fired today", () => {
    const r = step({ fraction: 1.5, recovered: true });
    expect(r.toFire).toEqual([]);
    expect(Object.keys(r.next.fired).sort()).toEqual(
      [firedKey("usd", 0.8), firedKey("usd", 1)].sort(),
    );
  });

  it("stays silent for the rest of the day after recovery", () => {
    const recovered = step({ fraction: 1.5, recovered: true }).next;
    expect(replay([1.6, 2], { prev: recovered }).fires).toEqual([]);
  });
});

describe("L9 — untrusted data never fires and never advances", () => {
  it.each([0.85, 1.5])("fraction %s from an untrusted read fires nothing", (fraction) => {
    expect(step({ fraction, trusted: false }).toFire).toEqual([]);
  });

  it("leaves the previous state byte-identical, so the next trusted read behaves normally", () => {
    const prev: LatchState = { schema: 1, usageDay: DAY, fired: {} };
    const untrusted = evaluateLatch({
      prev,
      day: DAY,
      signal: "usd",
      fraction: 1.5,
      thresholds: TH,
      nowIso: NOW,
      trusted: false,
    });
    expect(untrusted.next).toEqual(prev);
    // The crossing is still live: a later trusted read must fire it.
    const trusted = evaluateLatch({
      prev: untrusted.next,
      day: DAY,
      signal: "usd",
      fraction: 1.5,
      thresholds: TH,
      nowIso: NOW,
      trusted: true,
    });
    expect(trusted.toFire).toEqual([0.8, 1]);
  });
});

describe("per-signal tracks", () => {
  it("a usd crossing and a rate-limit crossing do not cancel each other", () => {
    const a = step({ fraction: 0.85, signal: "usd" });
    const b = evaluateLatch({
      prev: a.next,
      day: DAY,
      signal: "rate-limit:7d",
      fraction: 0.85,
      thresholds: TH,
      nowIso: NOW,
      trusted: true,
    });
    expect(a.toFire).toEqual([0.8]);
    expect(b.toFire).toEqual([0.8]);
    expect(Object.keys(b.next.fired).sort()).toEqual(
      [firedKey("usd", 0.8), firedKey("rate-limit:7d", 0.8)].sort(),
    );
  });
});

describe("config changes mid-day", () => {
  it("adding a threshold below the current fraction fires it once, immediately", () => {
    const before = step({ fraction: 0.95 });
    expect(before.toFire).toEqual([0.8]);
    const after = evaluateLatch({
      prev: before.next,
      day: DAY,
      signal: "usd",
      fraction: 0.95,
      thresholds: [0.8, 0.9, 1],
      nowIso: NOW,
      trusted: true,
    });
    expect(after.toFire).toEqual([0.9]);
  });

  it("removing a threshold leaves its entry intact but inert", () => {
    const fired = step({ fraction: 0.85 }).next;
    const narrowed = evaluateLatch({
      prev: fired,
      day: DAY,
      signal: "usd",
      fraction: 0.85,
      thresholds: [1],
      nowIso: NOW,
      trusted: true,
    });
    expect(narrowed.toFire).toEqual([]);
    expect(narrowed.next.fired[firedKey("usd", 0.8)]).toBe(NOW);
  });
});

describe("robustness", () => {
  it("an unknown fraction fires nothing and preserves state", () => {
    const prev = step({ fraction: 0.85 }).next;
    const r = evaluateLatch({
      prev,
      day: DAY,
      signal: "usd",
      fraction: null,
      thresholds: TH,
      nowIso: NOW,
      trusted: true,
    });
    expect(r.toFire).toEqual([]);
    expect(r.next).toEqual(prev);
  });

  it("ignores non-positive or non-finite thresholds", () => {
    const r = step({ fraction: 5, thresholds: [0, -1, Number.NaN, 0.8] as Threshold[] });
    expect(r.toFire).toEqual([0.8]);
  });

  it.each([
    null,
    42,
    "x",
    [],
    { schema: 2 },
    { schema: 1, usageDay: 1 },
    { schema: 1, usageDay: "d", fired: [] },
  ])("isLatchState rejects %j", (v) => {
    expect(isLatchState(v)).toBe(false);
  });

  it("isLatchState accepts a well-formed state", () => {
    expect(isLatchState({ schema: 1, usageDay: DAY, fired: {} })).toBe(true);
  });
});

/**
 * The property, hand-rolled rather than via fast-check.
 *
 * fast-check would need a new dependency; a seeded PRNG plus the generators the acceptance
 * criteria name explicitly gives the same guarantee here, deterministically and with no install.
 * The invariant is the one that matters: within one usage day, each threshold appears AT MOST
 * ONCE across every `toFire` concatenated together.
 */
describe("property — at most one fire per threshold per day", () => {
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const named: Array<[string, number[]]> = [
    ["monotone rise", Array.from({ length: 200 }, (_, i) => i / 100)],
    [
      "sawtooth across 0.8, fifty times",
      Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.5 : 0.85)),
    ],
    ["exact boundaries", [0.8, 0.8, 1, 1, 0.8, 1]],
    ["single jump 0 -> 1.2", [0, 1.2]],
    ["float edge below 0.8", [0.7999999999999999, 0.7999999999999999, 0.8]],
    ["descending only", Array.from({ length: 50 }, (_, i) => 2 - i / 25)],
    ["all zeros", Array.from({ length: 20 }, () => 0)],
  ];

  it.each(named)("%s", (_name, fractions) => {
    const { fires } = replay(fractions);
    expect(new Set(fires).size).toBe(fires.length);
  });

  it("holds across 500 random walks", () => {
    for (let seed = 0; seed < 500; seed++) {
      const rnd = mulberry(seed);
      const fractions = Array.from({ length: 40 }, () => rnd() * 1.6);
      const { fires } = replay(fractions);
      expect(new Set(fires).size, `seed ${seed} double-fired: ${fires.join()}`).toBe(fires.length);
      // Anything that fired must be a configured threshold the walk actually reached.
      for (const t of fires) expect(TH).toContain(t);
    }
  });
});
