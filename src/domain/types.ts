/**
 * Domain types. PURE — no fs, no net, no clock, no `node:*` imports.
 * Enforced by biome (`noNodejsModules` on src/domain/**) and by test/gates/imports.test.ts.
 *
 * ARCHITECTURE_PROPOSAL.md v2 §3 is authoritative for UsageWindow / ToolSpend.
 */

/** A closed instant range. ISO-8601 UTC strings. */
export type UsageWindow = {
  from: string;
  to: string;
};

/**
 * One tool's spend inside a window, as reported by a collector.
 *
 * `tool` is deliberately `string`, not a union: an unknown tool id from any collector must stay
 * renderable. No enum, no per-tool branch anywhere in src/ (P1-1 acceptance).
 */
export type ToolSpend = {
  tool: string;
  usd: number;
  /** Subscription account => this is imputed money that does not exist. */
  imputed: boolean;
  tokens?: {
    in: number;
    out: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

/** A fraction of the allowance at which the user is warned. 0 < t <= some sane ceiling. */
export type Threshold = number;

/**
 * Why a number might not be trustworthy. Degradation is a first-class state, not an exception
 * (ARCHITECTURE_PROPOSAL §3). `unknown` must never render as `$0.00` (DoD #3).
 */
export type SourceHealth =
  | { kind: "ok" }
  | { kind: "no-source"; lookedFor: readonly string[] }
  | { kind: "stale"; ageSeconds: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "incompatible"; detail: string }
  /**
   * The collector is reachable and answered, but has ingested nothing yet — e.g. a freshly
   * installed budi before `budi db import`. Measured in the P0 spike: 126 transcripts watched,
   * zero rows queryable. Indistinguishable from a genuinely idle day unless modelled explicitly.
   * See SPIKE_RESULT.md §1a.2.
   */
  | { kind: "not-backfilled"; detail: string };

/** What `app/meter.ts` persists and every surface renders from. */
export type UsageSnapshot = {
  schema: 1;
  /** Local usage-day label, `YYYY-MM-DD`, per domain/window.ts. */
  usageDay: string;
  generatedAtUtc: string;
  sourceId: string;
  sourceFresh: boolean;
  health: SourceHealth;
  tools: readonly ToolSpend[];
  /** Sum of per-tool USD. Summing USD is allowed; deriving USD from tokens is not (§8 finding 1). */
  totalUsd: number;
  imputed: boolean;
  /**
   * True when the source could not give calendar-day rows and the adapter bucketed sessions by
   * last activity. Surfaces as a `~` prefix and a `lum doctor` line — never silent.
   */
  dayBoundaryApprox: boolean;
};

/** Which number the headline shows. `auto` resolves at render time (ARCHITECTURE_PROPOSAL §4). */
export type PrimarySignal = "auto" | "rate-limit" | "usd";

export type SourceId = "auto" | "budi" | "ccusage" | "tokentracker";

export type Config = {
  dailyBudgetUsd: number;
  resetHourLocal: number;
  thresholds: readonly Threshold[];
  source: SourceId;
  /** `["*"]` for every tool the collector reports, or an explicit kebab-case list. */
  tools: readonly string[];
  primarySignal: PrimarySignal;
  pacing: boolean;
  notifications: { enabled: boolean };
  /**
   * IANA zone defining the usage day. `null` = the host's local zone.
   *
   * PRE-G (OPEN): budi's HTTP API buckets by UTC while its CLI and the user's wall clock use
   * local — measured at 1.90x on the spike machine. This key exists so the axis is explicit and
   * testable rather than implied; it does NOT decide PRE-G. See SPIKE_RESULT.md §4, §7.
   */
  timezone: string | null;
};

export type BudgetState = "under" | "amber" | "over";

export type BudgetVerdict = {
  fraction: number;
  state: BudgetState;
  /** Thresholds crossed by this evaluation, ascending. */
  crossed: readonly Threshold[];
};
