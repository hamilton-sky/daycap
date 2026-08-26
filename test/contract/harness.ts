/**
 * The shape every adapter must provide to run the UsageSourcePort contract, plus the shared
 * ground-truth corpus loader.
 *
 * Why a harness and not just a port: five of the fourteen cases (C2, C3, C11, C12, and C14's
 * TZ leg) are assertions about the WORLD AROUND the adapter, not about the adapter's return
 * values. You cannot ask a `UsageSourcePort` to be absent, to hang, or to be handed garbage —
 * only its harness can arrange that. Handing the suite a bare port would silently reduce those
 * five cases to "skipped", which is how a contract suite becomes decoration.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClockPort, SourceGranularity, UsageSourcePort } from "../../src/domain/ports.ts";
import type { UsageWindow } from "../../src/domain/types.ts";

/** The four worlds an adapter has to survive. */
export type Scenario =
  /** Collector installed and holding the corpus. */
  | "present"
  /** Collector not installed at all. */
  | "absent"
  /** Collector installed but never answers — the C11 timeout case. */
  | "hanging"
  /** Collector answers with something that is not its documented schema — the C12 case. */
  | "garbage";

export type CaseId =
  | "C1"
  | "C2"
  | "C3"
  | "C4"
  | "C5"
  | "C6"
  | "C7"
  | "C8"
  | "C9a"
  | "C9b"
  | "C9c"
  | "C10"
  | "C11a"
  | "C11b"
  | "C12"
  | "C13"
  | "C14a"
  | "C14b";

export type StartedSource = {
  source: UsageSourcePort;
  stop(): Promise<void>;
  /**
   * PID of the collector process currently in flight, or undefined.
   *
   * A function rather than a value because a shell-out adapter does not spawn anything until
   * `spendFor` is called — there is no pid to report at `start()` time. C11b polls this.
   * Absent entirely on harnesses that never fork.
   */
  inFlightPid?(): number | undefined;
  /** Kill the in-flight collector. C11b wires this to `withTimeout`'s `onTimeout`. */
  killInFlight?(): void;
};

export type StartOptions = {
  timeoutMs: number;
  clock: ClockPort;
  /** Zone to force on a spawned child, for C14b. Ignored by in-process harnesses. */
  childTz?: string;
};

export interface SourceHarness {
  id: string;
  granularity: SourceGranularity;
  start(scenario: Scenario, options: StartOptions): Promise<StartedSource>;
  /**
   * The shared ground truth this harness's fixtures encode. Every harness reads the SAME
   * CORPUS.json — that identity is what makes this a contract rather than a shared test helper.
   */
  readonly corpus: Corpus;
  /**
   * Cases this harness cannot run, each with a WRITTEN reason. A skip without a reason is how a
   * contract quietly stops covering the thing it was written for, so the type requires the string.
   */
  skips?: Partial<Record<CaseId, string>>;
}

// ---------------------------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------------------------

export type ExpectedRow = { tool: string; cents: number | null; imputed: boolean };
export type WindowName = "full" | "narrowDay" | "narrowInstant" | "empty";

export type Corpus = {
  rows: ReadonlyArray<{
    at: string;
    tool: string;
    usd: number | null;
    imputed: boolean;
    tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
    _canary?: string;
  }>;
  windows: Record<WindowName, UsageWindow>;
  expected: Record<WindowName, ExpectedRow[]>;
  totals: Record<WindowName, number>;
  probes: {
    unknownToolId: string;
    inconsistentTool: string;
    inconsistentExactUsd: number;
    pricelessTool: string;
  };
  onlyInconsistentRow: UsageWindow;
  canaries: readonly string[];
};

const here = dirname(fileURLToPath(import.meta.url));

export function loadCorpus(): Corpus {
  const path = resolve(here, "../fixtures/collector/CORPUS.json");
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

/**
 * The narrow window to use for C8, chosen by granularity.
 *
 * A day-granularity collector cannot resolve a four-hour range, so asserting one against ccusage
 * would fail it for something that is not a defect. It still has to prove it honours a window —
 * it just does so at the finest granularity it actually has.
 */
export function narrowWindowFor(g: SourceGranularity): WindowName {
  return g === "day" ? "narrowDay" : "narrowInstant";
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/**
 * USD -> integer cents. Every monetary assertion in the contract goes through this.
 *
 * The plan's original C9 tolerance of `< 1e-9` on a SUM is not tight enough to catch what C9
 * exists to catch, and is simultaneously loose enough to accumulate float drift across rows.
 * Integer cents removes both problems.
 */
export function toCents(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 100);
}

/** Sums priced rows only. Unpriceable rows are EXCLUDED, never coerced to zero (DoD #3). */
export function sumCents(rows: ReadonlyArray<{ cents: number | null }>): number {
  return rows.reduce((acc, r) => acc + (r.cents ?? 0), 0);
}

/** A clock frozen at `ms`. The only clock any contract case is allowed to see (C14). */
export function fixedClock(ms: number, timezone: string | null = "UTC"): ClockPort {
  return { nowMs: () => ms, timezone: () => timezone };
}
