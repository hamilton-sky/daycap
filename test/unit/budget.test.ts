import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/domain/budget.ts";
import {
  describe as describeSignal,
  evaluate,
  fractionOf,
  signalId,
} from "../../src/domain/budget.ts";

const cfg = { thresholds: [0.8, 1] as const };
const usd = (spent: number | null, limit: number | null): Signal => ({ kind: "usd", spent, limit });

describe("evaluate — threshold boundaries", () => {
  it.each<[number, number[], string]>([
    [0.79, [], "below"],
    [0.8, [0.8], "exactly at 0.8 counts"],
    [0.81, [0.8], "above"],
    [0.999, [0.8], "below 1.0"],
    [1, [0.8, 1], "exactly at 1.0 counts, and both fire ascending"],
    [1.5, [0.8, 1], "well over"],
  ])("fraction %s crosses %j (%s)", (fraction, expected) => {
    expect(evaluate(usd(fraction * 10, 10), cfg).crossed).toEqual(expected);
  });

  it("0.7999999999999999 does NOT cross 0.8 — no fudge factor", () => {
    // The float immediately below 0.8. A tolerance here would make a threshold that fires early
    // indistinguishable from one that fires correctly.
    const signal: Signal = { kind: "usd", spent: 0.7999999999999999, limit: 1 };
    expect(evaluate(signal, cfg).crossed).toEqual([]);
    expect(fractionOf(signal)).toBeLessThan(0.8);
  });

  it("8 of 10 lands exactly on 0.8 despite float division", () => {
    expect(evaluate(usd(8, 10), cfg).crossed).toEqual([0.8]);
  });

  it("returns thresholds ascending regardless of config order", () => {
    expect(evaluate(usd(10, 10), { thresholds: [1, 0.5, 0.8] }).crossed).toEqual([0.5, 0.8, 1]);
  });
});

describe("evaluate — state", () => {
  it.each<[number, string]>([
    [0.5, "under"],
    [0.8, "amber"],
    [0.99, "amber"],
    [1, "over"],
    [2, "over"],
  ])("fraction %s => %s", (f, state) => {
    expect(evaluate(usd(f * 10, 10), cfg).state).toBe(state);
  });
});

describe("evaluate — nothing to evaluate", () => {
  it.each<[string, Signal]>([
    ["budget 0", usd(5, 0)],
    ["budget absent", usd(5, null)],
    ["budget negative", usd(5, -1)],
    ["spend unknown", usd(null, 10)],
    ["spend negative", usd(-1, 10)],
    ["spend not finite", usd(Number.NaN, 10)],
  ])("%s => fraction null, state unknown, nothing crossed", (_n, signal) => {
    // `unknown`, not `ok`: with no budget there is nothing to be under, and reporting `ok` would
    // assert a safety we cannot vouch for.
    expect(evaluate(signal, cfg)).toEqual({ fraction: null, state: "unknown", crossed: [] });
  });

  it("a genuine zero spend against a real budget is under, not unknown", () => {
    expect(evaluate(usd(0, 10), cfg)).toEqual({ fraction: 0, state: "under", crossed: [] });
  });
});

describe("rate-limit signals", () => {
  const rl = (usedPct: number, window: "5h" | "7d" = "7d"): Signal => ({
    kind: "rate-limit",
    window,
    usedPct,
    resetsAt: "Thu 14:00",
  });

  it("uses percentage-of-100 as the fraction", () => {
    expect(fractionOf(rl(80))).toBe(0.8);
    expect(evaluate(rl(80), cfg).crossed).toEqual([0.8]);
  });

  it("keeps 5h and 7d on separate latch tracks", () => {
    expect(signalId(rl(1, "5h"))).toBe("rate-limit:5h");
    expect(signalId(rl(1, "7d"))).toBe("rate-limit:7d");
    expect(signalId(usd(1, 1))).toBe("usd");
  });

  it("rejects nonsense percentages rather than inventing a fraction", () => {
    expect(fractionOf(rl(Number.NaN))).toBeNull();
    expect(fractionOf(rl(-5))).toBeNull();
  });
});

describe("describe — the alert must name the window it is about", () => {
  it("a rate-limit crossing never says 'budget' or a dollar figure", () => {
    const signal: Signal = { kind: "rate-limit", window: "7d", usedPct: 80, resetsAt: "Thu 14:00" };
    const out = describeSignal(signal, evaluate(signal, cfg), { imputed: true });
    expect(out.title).toContain("7-day");
    expect(out.title).toContain("80%");
    expect(`${out.title} ${out.body}`).not.toMatch(/budget|\$/);
    expect(out.body).toContain("Thu 14:00");
  });

  it("says 'usage allowance' for imputed money and 'budget' for real money", () => {
    const s = usd(8, 10);
    const v = evaluate(s, cfg);
    expect(describeSignal(s, v, { imputed: true }).body).toContain("usage allowance");
    expect(describeSignal(s, v, { imputed: false }).body).toContain("budget");
  });

  it("names the amounts for a usd crossing", () => {
    const s = usd(8, 10);
    expect(describeSignal(s, evaluate(s, cfg), { imputed: false }).body).toContain(
      "$8.00 of $10.00",
    );
  });
});
