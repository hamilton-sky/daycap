/**
 * `notifyEveryUsd` — dollar-step notifications. P-post-v0.1.0.
 *
 * The feature is "tell me every $15". It is implemented by turning each dollar milestone into an
 * ordinary fractional threshold, so the latch's nine mutation-verified rules apply to steps
 * unchanged instead of gaining a second, less-tested implementation of "fire once per day".
 *
 * The interesting behaviour is not the arithmetic — it is what happens when fourteen of them cross
 * in one evaluation, which is the normal first run of a busy day.
 */

import { describe, expect, it } from "vitest";
import { stepFractions } from "../../src/domain/budget.ts";
import { DEFAULT_CONFIG, parseConfig } from "../../src/domain/config.ts";

describe("stepFractions — dollars become fractions of the budget", () => {
  it("puts $15 steps of a $200 budget at 7.5% intervals", () => {
    const f = stepFractions(15, 200);
    expect(f.slice(0, 4)).toEqual([0.075, 0.15, 0.225, 0.3]);
  });

  it("starts at the first step, never at zero — crossing $0 is not news", () => {
    expect(stepFractions(15, 200)[0]).toBe(0.075);
  });

  it("passes 1.0 exactly when a step lands on the budget", () => {
    // $50 steps of a $200 budget must include 1.0, or the over-budget moment has no step on it.
    expect(stepFractions(50, 200)).toContain(1);
  });

  it("is off when either side is missing", () => {
    expect(stepFractions(null, 200)).toEqual([]);
    expect(stepFractions(15, null)).toEqual([]);
    expect(stepFractions(null, null)).toEqual([]);
  });

  it("is off for a nonsense step or budget rather than throwing", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stepFractions(bad, 200), `everyUsd ${bad}`).toEqual([]);
      expect(stepFractions(15, bad), `limit ${bad}`).toEqual([]);
    }
  });

  it("is BOUNDED at 10x the budget, so a tiny step cannot generate forever", () => {
    // The failure this prevents: $1 step against a $1 budget on a $500 day. Unbounded, that is 500
    // thresholds and 500 attempted notifications. 10x matches the ceiling config.ts already puts on
    // a single threshold, stated in the same units.
    const f = stepFractions(1, 1);
    expect(f.length).toBe(10);
    expect(Math.max(...f)).toBe(10);
  });

  it("never generates more than 1000 entries even under a pathological step", () => {
    expect(stepFractions(1e-9, 1000).length).toBeLessThanOrEqual(1000);
  });

  it("is ascending, because the latch and the coalescer both assume order", () => {
    const f = stepFractions(15, 200);
    expect([...f].sort((a, b) => a - b)).toEqual(f);
  });
});

describe("config — notifyEveryUsd", () => {
  it("is off by default", () => {
    expect(DEFAULT_CONFIG.notifyEveryUsd).toBeNull();
  });

  it("accepts a positive number with no warnings, given a budget", () => {
    const r = parseConfig({ dailyBudgetUsd: 200, notifyEveryUsd: 15 });
    expect(r.config.notifyEveryUsd).toBe(15);
    expect(r.warnings).toEqual([]);
  });

  it("accepts explicit null as 'off', without complaining", () => {
    expect(parseConfig({ notifyEveryUsd: null }).warnings).toEqual([]);
  });

  it.each([0, -5, "15", true])("rejects %j and says so", (bad) => {
    const r = parseConfig({ dailyBudgetUsd: 200, notifyEveryUsd: bad });
    expect(r.config.notifyEveryUsd).toBeNull();
    expect(r.warnings.join(" ")).toContain("notifyEveryUsd");
  });

  it("warns when steps are set but no budget is — they cannot fire", () => {
    // Steps are fractions of the budget, so without one there is nothing to be a fraction of. Said
    // at parse time rather than discovered as silence.
    const r = parseConfig({ notifyEveryUsd: 15 });
    expect(r.warnings.join(" ")).toContain("dailyBudgetUsd is not");
  });
});
