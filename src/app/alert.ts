/**
 * Turn a snapshot into (at most) a notification. The orchestration L7 describes.
 *
 * Order is not a detail here: **persist the latch, THEN notify.** A notifier crash costs one
 * alert; the reverse order costs an alert on every single invocation, forever, which is how a
 * budget tool teaches its user to mute it.
 */

import {
  describe as describeSignal,
  evaluate,
  type Signal,
  signalId,
  stepFractions,
} from "../domain/budget.ts";
import type { NotifierPort, StorePort } from "../domain/ports.ts";
import type { BudgetVerdict, Config, Threshold, UsageSnapshot } from "../domain/types.ts";
import { evaluateLatch, isLatchState, LATCH_KEY, type LatchState } from "./latch.ts";

export type AlertDeps = {
  snapshot: UsageSnapshot;
  config: Config;
  store: StorePort;
  notifier: NotifierPort;
  nowIso: string;
};

export type AlertResult = {
  verdict: BudgetVerdict;
  fired: Threshold[];
  /** True when the latch could not be read and the day was silenced (L6). */
  latchRecovered: boolean;
};

/**
 * L9 — only degradation states 0 and 1 may fire.
 *
 * `ok` covers fresh-full AND fresh-partial: a snapshot missing one tool's price is still a
 * trustworthy floor on spend. Everything else — stale, timeout, no-source, incompatible — is a
 * number we are not sure of, and an alert derived from one is worse than no alert because it
 * teaches the user to ignore alerts.
 */
export function isTrusted(snapshot: UsageSnapshot): boolean {
  return snapshot.health.kind === "ok";
}

export function signalFor(snapshot: UsageSnapshot, config: Config): Signal {
  return {
    kind: "usd",
    spent: snapshot.totalUsd,
    limit: config.dailyBudgetUsd > 0 ? config.dailyBudgetUsd : null,
  };
}

export async function runAlerts(deps: AlertDeps): Promise<AlertResult> {
  const { snapshot, config, store, notifier, nowIso } = deps;

  const signal = signalFor(snapshot, config);
  const verdict = evaluate(signal, config);

  // A corrupt latch is not the same as an absent one. Absent means "nothing has fired today";
  // corrupt means "we do not know what fired", and L6 says assume everything did.
  let prev: LatchState | null = null;
  let recovered = false;
  try {
    const raw = await store.read<unknown>(LATCH_KEY);
    if (raw !== null && !isLatchState(raw)) recovered = true;
    else prev = raw as LatchState | null;
  } catch {
    recovered = true;
  }

  // $N steps join the fractional thresholds as ordinary thresholds (see `stepFractions`), so the
  // latch treats them identically and nothing about L1-L9 changes.
  //
  // The `Set` is defensive clarity, NOT the thing that prevents a double fire. A step can land
  // exactly on a configured threshold — $100 of a $200 budget IS 0.5 — and the latch already
  // collapses that, because `fired` is keyed `${signal}|${threshold}` and two identical thresholds
  // produce one key. Verified rather than assumed: passing [0.5, 0.5, 0.3] returns toFire [0.3, 0.5].
  // Stated because a mutation that removed this Set changed no behaviour, and a reader deserves to
  // know which line is load-bearing.
  const steps = stepFractions(config.notifyEveryUsd, signal.kind === "usd" ? signal.limit : null);
  const allThresholds = [...new Set([...config.thresholds, ...steps])].sort((a, b) => a - b);

  const { next, toFire } = evaluateLatch({
    prev,
    day: snapshot.usageDay,
    signal: signalId(signal),
    fraction: verdict.fraction,
    thresholds: allThresholds,
    nowIso,
    trusted: isTrusted(snapshot),
    recovered,
  });

  // L7 — persist FIRST. If this write fails we do not notify at all, because a fired alert whose
  // latch never landed will re-fire on the next run.
  try {
    await store.write(LATCH_KEY, next);
  } catch {
    return { verdict, fired: [], latchRecovered: recovered };
  }

  // AT MOST ONE NOTIFICATION PER RUN, and this is the rule $N steps made necessary.
  //
  // The latch marks every newly-crossed threshold as fired, which is correct — each must fire at
  // most once per day. But NOTIFYING once per crossing is only right when crossings arrive one at a
  // time. They do not on the first run of a busy day: at $224 spent with $15 steps, fourteen
  // thresholds cross in a single evaluation, and fourteen banners about money already spent is how
  // a user learns to dismiss this tool without reading it. Invariant 3's reasoning, one level up —
  // a wrong alert costs trust, and fourteen right ones at once are functionally a wrong one.
  //
  // It reports the REAL verdict rather than re-evaluating against one chosen threshold. The first
  // version picked the highest crossing and described that, on the reasoning that the highest is the
  // only actionable number. A mutation swapping `Math.max` for `Math.min` changed nothing and
  // exposed the reasoning as decoration: `describe()` words the alert from actual spend against the
  // actual limit — "$224.00 of $200.00 daily usage allowance" — and never mentions the threshold at
  // all. So choosing among them was a meaningless decision dressed as a careful one, and it is gone.
  // What the user needs is where they ARE, which is what the verdict already says.
  if (toFire.length > 0) {
    const { title, body } = describeSignal(signal, verdict, { imputed: snapshot.imputed });
    await notifier.notify({ title, body });
  }

  return { verdict, fired: toFire, latchRecovered: recovered };
}
