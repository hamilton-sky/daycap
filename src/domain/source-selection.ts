/**
 * Which collector gets read, and why. PURE — no fs, no spawn, no clock.
 *
 * P4-3. The probing is I/O and lives in the composition root; the DECISION is policy and lives
 * here, so it can be exhausted by unit test rather than inferred from behaviour. `selectSource`
 * takes the facts ("is it configured", "did it answer") and returns a choice plus a sentence
 * explaining it. `lum doctor` prints that sentence verbatim — the AC is that the choice is
 * deterministic AND explained, and those are one requirement, not two: a deterministic choice
 * nobody can see is indistinguishable from a coin flip that happens to be landing the same way.
 *
 * ## The order, and why it is this way round
 *
 * Under `auto`: **jsonfile, then ccusage.**
 *
 * That looks backwards — ccusage is the primary, zero-install path — until you notice that jsonfile
 * is only ever a candidate when `sourceFile` is set. Setting it is a deliberate act. Having
 * `ccusage` on PATH is ambient: it may be there because some other tool installed it. So the rule
 * is "prefer the source the user took an action to choose", and in the common case (no path set)
 * jsonfile is not a candidate at all and `auto` resolves to ccusage anyway.
 *
 * ## Naming a source disables the fallback. On purpose.
 *
 * `errors.ts` fixed this before P4-3 was written: "silently falling back from the source someone
 * chose is how you report the wrong tool's numbers without telling anyone". So an explicit
 * `source: "ccusage"` that cannot be reached is a HARD failure, not a quiet promotion of jsonfile.
 * The cost of failing is one clear error; the cost of falling back is a plausible number from the
 * wrong place, which is worse than no number (invariant 3).
 */

import type { Config, SourceId } from "./types.ts";

/** The concrete sources, in the fixed order `auto` walks them. Never includes `auto` itself. */
export const AUTO_ORDER: readonly Exclude<SourceId, "auto">[] = ["jsonfile", "ccusage"];

export type Probe = {
  id: Exclude<SourceId, "auto">;
  /**
   * Whether this source has what it needs to be tried at all — a path, for jsonfile. `ccusage`
   * needs no configuration, so it is always configured.
   */
  configured: boolean;
  /** Whether it actually answered. Only meaningful when `configured` is true. */
  available: boolean;
  /** Where it was looked for, for the doctor line. */
  where: string;
};

export type Selection = {
  /** The source to construct, or null when nothing can be read. */
  chosen: Exclude<SourceId, "auto"> | null;
  /**
   * Why — one sentence, written for someone whose number looks wrong.
   *
   * Always says which MODE was in force, because "ccusage" alone does not distinguish "you asked
   * for this" from "this is what auto found", and those two failures are fixed differently.
   */
  reason: string;
  /**
   * True when the user named a source that could not be reached.
   *
   * Separate from `chosen === null` because the two want opposite handling: nothing-available under
   * `auto` is a state to report, while a named-and-missing source is an error to raise.
   */
  namedButMissing: boolean;
};

/** The sources that were real candidates, in `auto` order. Exported for the doctor's ladder. */
export function candidates(probes: readonly Probe[]): readonly Probe[] {
  return AUTO_ORDER.map((id) => probes.find((p) => p.id === id)).filter(
    (p): p is Probe => p !== undefined,
  );
}

export function selectSource(config: Config, probes: readonly Probe[]): Selection {
  const ordered = candidates(probes);

  if (config.source !== "auto") {
    const named = ordered.find((p) => p.id === config.source);

    if (named === undefined || !named.configured) {
      // `source: "jsonfile"` with no `sourceFile`. Config parsing already warned; this is the same
      // fact at the point of use, because a warning the user did not read must not become a number.
      return {
        chosen: null,
        reason: `source "${config.source}" was requested but is not configured`,
        namedButMissing: true,
      };
    }
    if (!named.available) {
      return {
        chosen: null,
        // Names the OTHER sources that would have worked. Without this the user cannot tell a
        // broken install from a wrong config key, and those have different fixes.
        reason: `source "${config.source}" was requested but did not answer (${named.where})${describeAlternatives(ordered, config.source)}`,
        namedButMissing: true,
      };
    }
    return {
      chosen: named.id,
      reason: `${named.id} (requested explicitly by config)`,
      namedButMissing: false,
    };
  }

  const usable = ordered.filter((p) => p.configured && p.available);
  const first = usable[0];
  if (first === undefined) {
    return {
      chosen: null,
      reason:
        ordered.length === 0
          ? "no source is configured"
          : `auto found no usable source; tried ${ordered.map((p) => p.id).join(", ")}`,
      namedButMissing: false,
    };
  }

  // Say what it BEAT, not just what it picked. "jsonfile chosen" leaves a ccusage user wondering
  // whether their collector was even seen; "jsonfile (auto; preferred over ccusage)" does not.
  const beaten = usable.slice(1).map((p) => p.id);
  const suffix = beaten.length === 0 ? "" : `; preferred over ${beaten.join(", ")}`;
  return {
    chosen: first.id,
    reason: `${first.id} (auto${suffix})`,
    namedButMissing: false,
  };
}

function describeAlternatives(ordered: readonly Probe[], excluding: SourceId): string {
  const others = ordered.filter((p) => p.id !== excluding && p.configured && p.available);
  if (others.length === 0) return "; no other source was usable either";
  return `; ${others.map((p) => p.id).join(", ")} would have worked — set source to it, or "auto"`;
}
