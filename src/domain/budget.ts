/**
 * Budget evaluation. PURE — no clock, no fs.
 *
 * Takes a `Signal` rather than a bare USD number. That is the whole point: OPEN-F asks whether
 * thresholds should fire on imputed dollars or on a real rate-limit percentage, and it is not
 * answered. Parameterising the signal makes that answer a DEFAULT (~20 lines) instead of a
 * rewrite of every caller. Build both branches now, pick later.
 *
 * The surfaces genuinely know different things, which is why this cannot be one global answer:
 * a real `rate_limits.used_percentage` reaches only the statusline's stdin, on a Pro/Max account,
 * after the first response of a session. `lum today` can never see it. See M1_RESULT.md and
 * BUILD_PLAN_v3 §5.
 */

import type { BudgetVerdict, Config, Threshold } from "./types.ts";

export type Signal =
  /** Imputed or real dollars against a configured daily allowance. Available on every surface. */
  | { kind: "usd"; spent: number | null; limit: number | null }
  /**
   * Provider-reported quota usage. Only ever available to the statusline, and only sometimes:
   * subscription accounts, after the first response, and absent entirely on some Claude Code
   * versions. Anything reading this must have a USD fallback.
   */
  | { kind: "rate-limit"; window: "5h" | "7d"; usedPct: number; resetsAt: string };

/** Latch tracks are per-signal, so a 7-day crossing and a USD crossing cannot cancel each other. */
export type SignalId = "usd" | "rate-limit:5h" | "rate-limit:7d";

export function signalId(signal: Signal): SignalId {
  return signal.kind === "usd" ? "usd" : (`rate-limit:${signal.window}` as SignalId);
}

/** How far through the allowance this signal is, or `null` when that cannot be known. */
export function fractionOf(signal: Signal): number | null {
  if (signal.kind === "rate-limit") {
    if (!Number.isFinite(signal.usedPct) || signal.usedPct < 0) return null;
    return signal.usedPct / 100;
  }
  const { spent, limit } = signal;
  // A budget of 0 or absent means "not set" — absolute spend renders, nothing is evaluated.
  if (spent === null || limit === null || !(limit > 0)) return null;
  if (!Number.isFinite(spent) || spent < 0) return null;
  return spent / limit;
}

/**
 * The fractions at which $N steps land, for a given budget. PURE.
 *
 * `notifyEveryUsd: 15` against a $200 budget yields 0.075, 0.15, 0.225 … — so a dollar milestone
 * becomes an ordinary threshold and inherits every one of the latch's nine rules instead of getting
 * a second, less-tested implementation of "fire once per day".
 *
 * BOUNDED AT 10x THE BUDGET, deliberately. Spend can exceed the allowance without limit, and an
 * unbounded generator against a $1 budget and a $500 day would produce 500 thresholds and try to
 * notify 500 times. `config.ts` already caps a threshold at 10, so this is the same ceiling stated
 * in the same units, and a run past it stops generating rather than growing without end.
 *
 * The first step is `everyUsd`, never 0 — crossing $0 is not news.
 */
export function stepFractions(everyUsd: number | null, limitUsd: number | null): Threshold[] {
  if (everyUsd === null || limitUsd === null) return [];
  if (!Number.isFinite(everyUsd) || everyUsd <= 0) return [];
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return [];

  const out: Threshold[] = [];
  const maxUsd = limitUsd * 10;
  for (let usd = everyUsd; usd <= maxUsd; usd += everyUsd) {
    out.push(usd / limitUsd);
    // Belt and braces against a pathological `everyUsd` that rounds to no progress.
    if (out.length >= 1000) break;
  }
  return out;
}

export function evaluate(signal: Signal, config: Pick<Config, "thresholds">): BudgetVerdict {
  const fraction = fractionOf(signal);
  if (fraction === null) return { fraction: null, state: "unknown", crossed: [] };

  // `>=` and nothing else. 0.7999999999999999 is strictly less than 0.8 as a double, so it does
  // NOT cross — pinned by table tests, because a fudge factor here means a threshold that fires
  // early is indistinguishable from one that fires correctly.
  const crossed: Threshold[] = [...config.thresholds]
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b)
    .filter((t) => fraction >= t);

  const state = fraction >= 1 ? "over" : crossed.length > 0 ? "amber" : "under";
  return { fraction, state, crossed };
}

/**
 * How a crossing is worded.
 *
 * ARCH-Q3 ratified two wordings; a third is needed once thresholds can fire on a rate limit.
 * "AI Spend: Amber — $8.00 of $10.00" fired because the 7-day rate limit crossed 80% is the
 * wrong-number problem in new clothes — the alert must name the window it is actually about.
 */
export function describe(
  signal: Signal,
  verdict: BudgetVerdict,
  opts: { imputed: boolean },
): { title: string; body: string } {
  const pct = verdict.fraction === null ? "—" : `${Math.round(verdict.fraction * 100)}%`;
  if (signal.kind === "rate-limit") {
    const label = signal.window === "5h" ? "5-hour" : "7-day";
    return {
      title: `Claude ${label} limit at ${pct}`,
      body: `Resets ${signal.resetsAt}.`,
    };
  }
  const spent = signal.spent === null ? "—" : `$${signal.spent.toFixed(2)}`;
  const limit = signal.limit === null ? "—" : `$${signal.limit.toFixed(2)}`;
  // "usage allowance" for a subscription, where the dollars were never actually charged;
  // "budget" only where the money is real. ARCH-Q3's A+C hybrid.
  const noun = opts.imputed ? "daily usage allowance" : "daily budget";
  return {
    title: verdict.state === "over" ? `AI spend over ${noun}` : `AI spend at ${pct}`,
    body: `${spent} of ${limit} ${noun}.`,
  };
}
