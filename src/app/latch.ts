/**
 * The threshold latch. The pure core is here; the file on disk is only persistence.
 *
 * This is the correctness centrepiece of the product. Everything else can be wrong in a way the
 * user notices and corrects. The latch is wrong in a way they do not: it either nags them until
 * they mute the tool, or it silently never warns them at all.
 *
 * The nine rules, all of them load-bearing:
 *
 *  L1  fire when `fraction >= t`.
 *  L2  ...only if `t` is absent from `prev.fired` FOR THE SAME DAY.
 *  L3  a different `usageDay` discards `prev.fired` ENTIRELY and re-arms. Replace, never merge —
 *      merging leaks yesterday's fires into today and silences today's first warning.
 *  L4  a dip below `t` NEVER clears `fired`. Re-arming happens only via L3. Spend that oscillates
 *      around a threshold would otherwise fire on every crossing.
 *  L5  several thresholds crossed in one step all fire, ascending.
 *  L6  corrupt or unreadable `prev` => treat as ALL thresholds already fired today: stay silent.
 *      A spurious duplicate alert trains the user to ignore alerts; a missed one is still visible
 *      on the statusline. Fail quiet, not loud.
 *  L7  persist the latch, THEN notify. A notifier crash costs one alert; the reverse order costs
 *      an alert on every single invocation.
 *  L8  two `daycap` processes racing: rename is atomic, last writer wins, a duplicate alert is
 *      possible and accepted. Documented, not engineered around — a lock is how you get a stale
 *      lockfile that silences the tool forever.
 *  L9  fire ONLY from trusted data (fresh-full or fresh-partial). A stale, source-down or
 *      no-source read must never fire and must never advance the latch. An alert derived from a
 *      number we are unsure of is worse than no alert.
 */

import type { SignalId } from "../domain/budget.ts";
import type { Threshold } from "../domain/types.ts";

export const LATCH_KEY = "latch";

export type LatchState = {
  schema: 1;
  usageDay: string;
  /** `${signalId}|${threshold}` -> ISO instant it fired. Per-signal so tracks never collide. */
  fired: Record<string, string>;
};

export type LatchInput = {
  prev: LatchState | null;
  day: string;
  signal: SignalId;
  fraction: number | null;
  thresholds: readonly Threshold[];
  nowIso: string;
  /** L9. False for stale / timeout / no-source / incompatible reads. */
  trusted: boolean;
  /** L6. True when the stored latch could not be read or parsed. */
  recovered?: boolean;
};

export type LatchResult = { next: LatchState; toFire: Threshold[] };

const empty = (usageDay: string): LatchState => ({ schema: 1, usageDay, fired: {} });

export function firedKey(signal: SignalId, threshold: Threshold): string {
  return `${signal}|${threshold}`;
}

export function isLatchState(v: unknown): v is LatchState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<LatchState>;
  return (
    s.schema === 1 &&
    typeof s.usageDay === "string" &&
    typeof s.fired === "object" &&
    s.fired !== null &&
    !Array.isArray(s.fired)
  );
}

export function evaluateLatch(input: LatchInput): LatchResult {
  const { prev, day, signal, fraction, thresholds, nowIso, trusted, recovered } = input;

  // L6 — a latch we cannot read means we do not know what already fired. Assume everything did.
  if (recovered === true) {
    const fired: Record<string, string> = { ...(prev?.usageDay === day ? prev.fired : {}) };
    for (const t of thresholds) fired[firedKey(signal, t)] = nowIso;
    return { next: { schema: 1, usageDay: day, fired }, toFire: [] };
  }

  // L9 — untrusted data neither fires nor advances anything. Returning `prev` verbatim is the
  // point: a degraded read must leave no trace, so the next trusted read behaves as if it never
  // happened.
  if (!trusted) return { next: prev ?? empty(day), toFire: [] };

  // L3 — replace, never merge.
  const base: LatchState = prev !== null && prev.usageDay === day ? prev : empty(day);

  if (fraction === null) return { next: base, toFire: [] };

  const fired = { ...base.fired };
  const toFire: Threshold[] = [];

  // L5 — ascending, so a jump from 0 to 1.2 fires 0.8 then 1.0 in that order.
  for (const t of [...thresholds]
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b)) {
    const key = firedKey(signal, t);
    // L1 + L2. L4 is the absence of any branch that deletes from `fired` on a dip.
    if (fraction >= t && fired[key] === undefined) {
      fired[key] = nowIso;
      toFire.push(t);
    }
  }

  return { next: { schema: 1, usageDay: day, fired }, toFire };
}
