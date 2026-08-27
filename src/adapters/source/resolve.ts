/**
 * Probe the sources, apply the policy, hand back the one that won. P4-3.
 *
 * The split is deliberate and is the reason this file is thin: `domain/source-selection.ts` decides
 * and this only gathers. Probing is I/O — a spawn for ccusage, a read for jsonfile — and if the
 * order and the fallback rules lived here they would be testable only by arranging a filesystem
 * and a PATH, which is how policy stops being exhaustively tested and starts being spot-checked.
 *
 * Each candidate is probed EXACTLY ONCE and the probed instance is the one returned. Constructing a
 * second instance after choosing would double the spawn on the hot-ish `refresh` path, and — worse
 * — could answer differently from the instance the decision was made about.
 */

import { SourceUnavailableError } from "../../domain/errors.ts";
import type { UsageSourcePort } from "../../domain/ports.ts";
import type { Probe, Selection } from "../../domain/source-selection.ts";
import { selectSource } from "../../domain/source-selection.ts";
import type { Config } from "../../domain/types.ts";
import { CcusageSource } from "./ccusage.shellout.ts";
import { JsonFileSource } from "./jsonfile.ts";

export type ResolvedSource = {
  selection: Selection;
  probes: readonly Probe[];
  /** The chosen source, or null when nothing is usable. */
  source: UsageSourcePort | null;
  /**
   * Kill an in-flight collector. A no-op for sources that spawn nothing.
   *
   * It exists on the result rather than being reached for through a type check at the call site:
   * `wire()` passes it to `withTimeout`'s `onTimeout`, and that wiring must not have to know which
   * adapter it got. Forgetting it for ccusage leaves a collector reading the corpus after we have
   * stopped waiting for it.
   */
  killInFlight(): void;
};

export async function resolveSource(config: Config): Promise<ResolvedSource> {
  const ccusage = new CcusageSource();
  const ccusageHit = ccusage.probe().find((a) => a.found);
  const ccusageProbe: Probe = {
    id: "ccusage",
    // Needs no configuration at all — that is the whole point of the zero-install path.
    configured: true,
    available: await ccusage.available(),
    where: ccusageHit?.detail ?? ccusageHit?.where ?? "not found on any tier",
  };

  const path = config.sourceFile;
  const jsonfile = path === null ? null : new JsonFileSource({ path });
  const jsonfileProbe: Probe = {
    id: "jsonfile",
    configured: path !== null,
    // Short-circuits on an unconfigured source: with no path there is nothing to read, and
    // `available()` on a source we never built would be a lie either way it answered.
    available: jsonfile === null ? false : await jsonfile.available(),
    where: path ?? "sourceFile is not set",
  };

  const probes: Probe[] = [ccusageProbe, jsonfileProbe];
  const selection = selectSource(config, probes);

  const source: UsageSourcePort | null =
    selection.chosen === "ccusage" ? ccusage : selection.chosen === "jsonfile" ? jsonfile : null;

  return {
    selection,
    probes,
    source,
    killInFlight: () => {
      if (selection.chosen === "ccusage") ccusage.killInFlight();
    },
  };
}

/**
 * A port that is always down. Returned in place of `null` so `app/` never learns a new shape.
 *
 * The alternative was a `source === null` branch in `buildSnapshot`, and that would be a TENTH row
 * in a degradation matrix that already has nine and is already mutation-verified. "No source could
 * be selected" and "the selected source did not answer" want identical handling — a degraded
 * snapshot, no latch advance, no notification, `unknown` rather than `$0.00` — so expressing the
 * first as the second is not a trick, it is the same fact arriving through the existing channel.
 *
 * `spendFor` REJECTS rather than resolving `[]`, for the reason `errors.ts` gives: an empty array is
 * indistinguishable from a collector confirming zero spend.
 */
export class UnavailableSource implements UsageSourcePort {
  readonly id: string;
  readonly granularity = "instant" as const;
  readonly #lookedFor: readonly string[];

  constructor(id: string, lookedFor: readonly string[]) {
    this.id = id;
    this.#lookedFor = lookedFor;
  }

  available(): Promise<boolean> {
    return Promise.resolve(false);
  }

  spendFor(): Promise<never> {
    return Promise.reject(new SourceUnavailableError(this.id, this.#lookedFor));
  }

  freshness(): Promise<{ lastUpdatedUtc: string | null }> {
    return Promise.resolve({ lastUpdatedUtc: null });
  }
}
