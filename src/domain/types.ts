/**
 * Domain types. PURE — no fs, no net, no clock, no `node:*` imports.
 * Enforced today by biome (`noNodejsModules` on src/domain/**). A stronger import gate
 * (test/gates/imports.test.ts) is PLANNED in P1-9 and does not exist yet.
 *
 * ARCHITECTURE_PROPOSAL.md v2 §3 is authoritative for UsageWindow / ToolSpend.
 */

/**
 * A HALF-OPEN instant range `[from, to)` — `from` inclusive, `to` exclusive.
 * ISO-8601 UTC strings. This is the domain's single convention; adapters convert to whatever
 * their collector wants (budi HTTP `until` is exclusive; budi CLI and ccusage `--until` are
 * INCLUSIVE). Getting this wrong double-counts the boundary. See domain/window.ts.
 */
export type UsageWindow = {
  from: string;
  to: string;
  /**
   * IANA zone the window was computed in. Carried on the window ITSELF, not read from the
   * environment, for two reasons:
   *
   * 1. A day-granularity collector (ccusage reports whole calendar days) has to map this instant
   *    range back onto calendar dates, and that mapping needs a zone. An adapter that reaches for
   *    `process.env.TZ` to get it makes contract case C14 unpassable by construction — results
   *    would depend on ambient state rather than only on the window.
   * 2. PRE-G measured the cost of getting the axis wrong at 1.90x on the spike machine
   *    ($16.37 UTC vs $31.13 local for one date). An implicit axis is how that happens.
   */
  tz: string;
};

/**
 * One tool's spend inside a window, as reported by a collector.
 *
 * `tool` is deliberately `string`, not a union: an unknown tool id from any collector must stay
 * renderable. No enum, no per-tool branch anywhere in src/ (P1-1 acceptance).
 */
export type ToolSpend = {
  tool: string;
  /**
   * The collector's own price for this tool in this window, or `null` when the collector reported
   * activity it could not price.
   *
   * `null` is NOT zero and must never render as `$0.00` (DoD #3) — it renders as an em dash. The
   * nullable type is what makes that rule enforceable: with `usd: number` the only way to express
   * "priced nothing" is `0`, and the render layer can no longer tell the two apart. Contract case
   * C9c pins this.
   */
  usd: number | null;
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
  /**
   * The collector's own watermark — how current ITS data is — or `null` when it does not expose
   * one (ccusage does not). Distinct from `generatedAtUtc`, which is when WE last asked.
   *
   * Both matter and they fail differently: a fresh snapshot built from a collector that stopped
   * ingesting an hour ago looks current and is not. `lum doctor` prints both.
   */
  sourceLastUpdatedUtc: string | null;
  health: SourceHealth;
  tools: readonly ToolSpend[];
  /**
   * Sum of the per-tool USD that could be priced, or `null` when nothing could be.
   *
   * Summing the collector's USD is allowed; deriving USD from tokens is not (§8 finding 1).
   * Unpriceable rows are excluded from the sum rather than counted as zero — `pricingPartial`
   * says whether that happened, so a partial total is never presented as a complete one.
   */
  totalUsd: number | null;
  /** True when at least one tool reported activity that the collector could not price. */
  pricingPartial: boolean;
  imputed: boolean;
  /**
   * True when the source could not give calendar-day rows and the adapter bucketed sessions by
   * last activity. Surfaces as a `~` prefix and a `lum doctor` line — never silent.
   */
  dayBoundaryApprox: boolean;
};

/** Which number the headline shows. `auto` resolves at render time (ARCHITECTURE_PROPOSAL §4). */
export type PrimarySignal = "auto" | "rate-limit" | "usd";

/**
 * Which collector to read. `auto` probes in a deterministic order (P4-3, `source-selection.ts`).
 *
 * WHAT WENT AWAY, recorded because two of the four original names are still written down in older
 * planning docs and reading this type is how someone finds out they are gone: `budi` was dropped by
 * P0-4's verdict (both of its paths were session-shaped; `ccusage daily --json` satisfied D1-D4
 * instead), and `tokentracker` was cut in BUILD_PLAN_v3 §6 — "two real adapters is the bar;
 * ccusage + jsonfile meets it". `config.ts` rejects both spellings by NAME rather than as a generic
 * unknown, so a user carrying an old config is told what happened instead of silently getting
 * `auto`.
 */
export type SourceId = "auto" | "ccusage" | "jsonfile";

export type Config = {
  dailyBudgetUsd: number;
  resetHourLocal: number;
  thresholds: readonly Threshold[];
  source: SourceId;
  /**
   * Path to the user's own JSON usage file, or null when they have not set one.
   *
   * Null is what makes `jsonfile` not a candidate under `auto`: a source that needs a path it does
   * not have cannot be probed, so an unconfigured jsonfile is absent rather than broken.
   */
  sourceFile: string | null;
  /** `["*"]` for every tool the collector reports, or an explicit kebab-case list. */
  tools: readonly string[];
  primarySignal: PrimarySignal;
  pacing: boolean;
  notifications: {
    enabled: boolean;
    /**
     * A user-supplied argv array, e.g. `["terminal-notifier","-title","{title}"]`. `{title}` and
     * `{body}` are substituted. An argv ARRAY, never a shell string — the text is derived from
     * collector output, and a shell would make a tool id an injection vector.
     */
    command?: readonly string[];
  };
  /**
   * Hard enforcement. OFF by default, and deliberately so.
   *
   * A warning that is ignored costs you money; a block that fires wrongly costs you your work.
   * Those are not symmetric, so this is opt-in and every default here is the cautious one.
   */
  guard: {
    enabled: boolean;
    /** Fraction of the allowance at which tool calls start being denied. */
    denyAt: number;
    /**
     * `deny` uses the documented PreToolUse contract and exits 0 — if the contract ever changes,
     * it fails OPEN, which is the safe direction. `hard` additionally exits 2, which blocks
     * unconditionally. `hard` is stronger and more brittle; the user picks.
     */
    mode: "deny" | "hard";
    /** Tool names that are never denied, e.g. ["Read"] to keep inspection possible while blocked. */
    allowTools: readonly string[];
  };
  /**
   * IANA zone defining the usage day. `null` = the host's local zone.
   *
   * PRE-G (OPEN): budi's HTTP API buckets by UTC while its CLI and the user's wall clock use
   * local — measured at 1.90x on the spike machine. This key exists so the axis is explicit and
   * testable rather than implied; it does NOT decide PRE-G. See SPIKE_RESULT.md §4, §7.
   */
  timezone: string | null;
};

/**
 * `unknown` is deliberate, and is a change from the task's literal wording of `ok`.
 *
 * With no budget configured there is nothing to be under. Reporting `ok` asserts a safety we
 * cannot vouch for — the same error as rendering an unknown total as `$0.00`, which DoD #3
 * forbids. `unknown` renders as an absence; `ok` would render as reassurance.
 */
export type BudgetState = "unknown" | "under" | "amber" | "over";

export type BudgetVerdict = {
  /** `null` when the signal cannot be evaluated — no budget set, or spend unknown. */
  fraction: number | null;
  state: BudgetState;
  /** Thresholds crossed by this evaluation, ascending. */
  crossed: readonly Threshold[];
};
