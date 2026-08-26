/**
 * Turn a snapshot into (at most) a notification. The orchestration L7 describes.
 *
 * Order is not a detail here: **persist the latch, THEN notify.** A notifier crash costs one
 * alert; the reverse order costs an alert on every single invocation, forever, which is how a
 * budget tool teaches its user to mute it.
 */

import { describe as describeSignal, evaluate, type Signal, signalId } from "../domain/budget.ts";
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

  const { next, toFire } = evaluateLatch({
    prev,
    day: snapshot.usageDay,
    signal: signalId(signal),
    fraction: verdict.fraction,
    thresholds: config.thresholds,
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

  for (const threshold of toFire) {
    const { title, body } = describeSignal(signal, evaluate(signal, { thresholds: [threshold] }), {
      imputed: snapshot.imputed,
    });
    await notifier.notify({ title, body });
  }

  return { verdict, fired: toFire, latchRecovered: recovered };
}
