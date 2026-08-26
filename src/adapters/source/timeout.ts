/**
 * `withTimeout` — the single place a source's time budget is enforced.
 *
 * The plan put `timeoutMs` inside each adapter with a default of 1500. Two problems with that:
 * an adapter author can simply forget it (and the contract would have to re-test it per adapter),
 * and 1500 ms is a guess that predates knowing ccusage ships a native binary. As a decorator the
 * budget is enforced once, tested once (C11), and becomes per-source config that `select.ts`
 * resolves — so a fast collector gets a tight budget and a slow one gets a loose one.
 *
 * On expiry this REJECTS with SourceTimeoutError. It must never resolve `[]`: an empty array is
 * indistinguishable from "the collector confirms zero spend", and rendering that as $0.00 is
 * precisely the failure DoD #3 forbids — a guardrail reporting safety it cannot vouch for.
 */

import { SourceTimeoutError } from "../../domain/errors.ts";
import type { UsageSourcePort } from "../../domain/ports.ts";
import type { ToolSpend, UsageWindow } from "../../domain/types.ts";

export type TimeoutOptions = {
  /**
   * Called when the budget expires, before the rejection propagates. A spawning adapter passes
   * its child-kill here: abandoning a hung collector process is how ccusage issue #455 (statusline
   * spawns accumulating until OOM) reproduces inside our own tool. Contract case C11b asserts it.
   */
  onTimeout?: () => void;
};

function race<T>(
  work: Promise<T>,
  sourceId: string,
  timeoutMs: number,
  onTimeout: (() => void) | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // A failing cleanup hook must not mask the timeout the caller is waiting to hear about.
      }
      reject(new SourceTimeoutError(sourceId, timeoutMs));
    }, timeoutMs);
    // Do not hold the event loop open on the timer alone; `lum` is a short-lived process and a
    // pending timer here would delay exit by the full budget on every run.
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

export function withTimeout(
  source: UsageSourcePort,
  timeoutMs: number,
  options: TimeoutOptions = {},
): UsageSourcePort {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  const { onTimeout } = options;
  return {
    id: source.id,
    granularity: source.granularity,
    available: (): Promise<boolean> =>
      // `available()` must never throw (C2), so a timeout here means "not available", not a reject.
      race(source.available(), source.id, timeoutMs, onTimeout).catch(() => false),
    spendFor: (window: UsageWindow): Promise<ToolSpend[]> =>
      race(source.spendFor(window), source.id, timeoutMs, onTimeout),
    freshness: (): Promise<{ lastUpdatedUtc: string | null }> =>
      // C10: never throws. An unknown freshness is `null`, which is already its degraded value.
      race(source.freshness(), source.id, timeoutMs, onTimeout).catch(() => ({
        lastUpdatedUtc: null,
      })),
  };
}
