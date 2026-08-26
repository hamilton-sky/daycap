/**
 * `app/meter.ts` — pull the source, build the snapshot, persist it.
 *
 * This is the only place that turns a collector's answer into the thing every surface renders.
 * Two rules it exists to enforce:
 *
 *  1. **Summing the collector's USD is allowed; deriving USD from tokens is not** (ADR-v2-001).
 *     Sums happen in integer cents so per-tool figures reconcile to the total exactly, rather
 *     than to within a float epsilon.
 *  2. **A partial answer is marked partial, never silently completed.** If the collector reported
 *     activity it could not price, that tool's figure is `null` and `pricingPartial` is set. The
 *     total then covers only what was priceable, and says so — because a budget guardrail that
 *     quietly under-reports is worse than one that admits it does not know.
 */

import { SourceIncompatibleError, SourceTimeoutError } from "../domain/errors.ts";
import type { ClockPort, StorePort, UsageSourcePort } from "../domain/ports.ts";
import type { Config, SourceHealth, ToolSpend, UsageSnapshot } from "../domain/types.ts";
import { usageDayFor, usageDayRange } from "../domain/window.ts";

export const SNAPSHOT_KEY = "today";

export type MeterDeps = {
  source: UsageSourcePort;
  clock: ClockPort;
  config: Config;
  /** Optional: `lum today` can render without persisting, e.g. under `--no-cache`. */
  store?: StorePort;
};

/** Cents, so per-tool figures reconcile to the total exactly. */
function cents(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 100);
}

/** `["*"]` means every tool the collector reports. Otherwise an explicit allowlist. */
function selectTools(rows: readonly ToolSpend[], configured: readonly string[]): ToolSpend[] {
  if (configured.length === 0 || configured.includes("*")) return [...rows];
  const wanted = new Set(configured);
  return rows.filter((r) => wanted.has(r.tool));
}

function healthFor(err: unknown, sourceId: string): SourceHealth {
  if (err instanceof SourceTimeoutError) return { kind: "timeout", afterMs: err.afterMs };
  if (err instanceof SourceIncompatibleError) {
    return { kind: "incompatible", detail: err.message };
  }
  // An adapter that throws something else is a bug, but the meter still has to render. Report it
  // as incompatible rather than crashing a surface that promised to always exit 0.
  return {
    kind: "incompatible",
    detail: `${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

export async function buildSnapshot(deps: MeterDeps): Promise<UsageSnapshot> {
  const { source, clock, config } = deps;
  const nowMs = clock.nowMs();
  const tz = config.timezone ?? clock.timezone();
  const usageDay = usageDayFor(nowMs, config.resetHourLocal, tz);
  const window = usageDayRange(usageDay, config.resetHourLocal, tz);

  /**
   * ccusage and friends report whole calendar days. A `resetHourLocal` other than 0 makes the
   * window straddle both ends, so the total necessarily over-reaches. The ADAPTER states the
   * granularity; deciding that this makes the number approximate is policy, and policy lives here.
   */
  const dayBoundaryApprox = source.granularity === "day" && config.resetHourLocal !== 0;

  const base = {
    schema: 1 as const,
    usageDay,
    generatedAtUtc: new Date(nowMs).toISOString(),
    sourceId: source.id,
    dayBoundaryApprox,
  };

  const degraded = (health: SourceHealth): UsageSnapshot => ({
    ...base,
    sourceFresh: false,
    sourceLastUpdatedUtc: null,
    health,
    tools: [],
    // Not 0. "We could not find out" and "you have spent nothing" are different facts, and
    // rendering the first as $0.00 is the failure DoD #3 exists to prevent.
    totalUsd: null,
    pricingPartial: false,
    imputed: false,
  });

  if (!(await source.available())) {
    return persist(deps, degraded({ kind: "no-source", lookedFor: [source.id] }));
  }

  let rows: ToolSpend[];
  try {
    rows = selectTools(await source.spendFor(window), config.tools);
  } catch (err) {
    return persist(deps, degraded(healthFor(err, source.id)));
  }

  const priced = rows.map((r) => cents(r.usd));
  const pricingPartial = priced.some((c) => c === null);
  const anyPriced = priced.some((c) => c !== null);
  const totalCents = priced.reduce<number>((acc, c) => acc + (c ?? 0), 0);

  let lastUpdatedUtc: string | null = null;
  try {
    ({ lastUpdatedUtc } = await source.freshness());
  } catch {
    // freshness() is documented never to throw; a misbehaving adapter must not lose the spend
    // figures we already have.
  }

  return persist(deps, {
    ...base,
    sourceFresh: true,
    sourceLastUpdatedUtc: lastUpdatedUtc,
    health: { kind: "ok" },
    tools: rows,
    // `null` when nothing at all could be priced — never a 0 standing in for "unknown".
    totalUsd: anyPriced ? totalCents / 100 : null,
    pricingPartial,
    imputed: rows.some((r) => r.imputed),
  });
}

async function persist(deps: MeterDeps, snapshot: UsageSnapshot): Promise<UsageSnapshot> {
  if (deps.store === undefined) return snapshot;
  /**
   * ONLY a healthy snapshot is cached.
   *
   * Caching a degraded one would overwrite the last good figure at exactly the moment the
   * degradation matrix says to fall back to it: "daemon slow -> last cached snapshot + age". A
   * timeout would then destroy the very value it is supposed to reveal, and the second run in a
   * row would have nothing to show.
   */
  if (snapshot.health.kind !== "ok") return snapshot;
  try {
    await deps.store.write(SNAPSHOT_KEY, snapshot);
  } catch {
    // A read-only or full state directory must not stop `lum today` from printing. The failure
    // surfaces in `lum doctor`, which is where an unwritable cache belongs.
  }
  return snapshot;
}

/** Age of a snapshot in seconds, for the stale rows of the degradation matrix. */
export function snapshotAgeSeconds(snapshot: UsageSnapshot, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - Date.parse(snapshot.generatedAtUtc)) / 1000));
}
