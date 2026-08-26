/**
 * The four ports. PURE — interfaces only, no implementations, no `node:*` imports.
 *
 * ARCHITECTURE_PROPOSAL.md v2 §3: "One port, several collectors." The budi HTTP API is a local
 * daemon's internal surface, not a published contract — it will change without notice. Behind
 * UsageSourcePort that is a one-adapter fix; called from app/ it is a rewrite. This is the single
 * most important structural rule in v2.
 */

import type { ToolSpend, UsageWindow } from "./types.ts";

/** Raised when a source answers but its payload does not match any known schema (contract C12). */
export class SourceIncompatibleError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, detail: string) {
    super(`source ${sourceId} returned an incompatible payload: ${detail}`);
    this.name = "SourceIncompatibleError";
    this.sourceId = sourceId;
  }
}

/**
 * Everything enters through here. Implemented once per collector.
 *
 * Contract obligations every implementation must satisfy (test/contract/usage-source.contract.ts):
 * - `available()` resolves, never throws, even with no collector present (C2).
 * - `spendFor()` resolves `[]` for an empty window — not null, not a throw (C4).
 * - The window is honoured. An adapter that ignores it and always answers "today" fails C8.
 *   This is not hypothetical: budi returns HTTP 200 with ALL-TIME data for an unrecognised range
 *   param, which on the spike machine was $912.87 reported as "today". See SPIKE_RESULT.md §3.
 * - No re-pricing. The collector's USD passes through with drift < 1e-9 (C9).
 * - Settles within its timeout; never hangs (C11).
 * - Loopback only. No socket outside 127.0.0.1 / ::1 (C13).
 */
export interface UsageSourcePort {
  /** Stable, non-empty, identical across constructions (C1). */
  readonly id: string;
  available(): Promise<boolean>;
  spendFor(window: UsageWindow): Promise<ToolSpend[]>;
  freshness(): Promise<{ lastUpdatedUtc: string | null }>;
}

export type Notification = {
  title: string;
  body: string;
};

/** Fire-and-forget OS notification. Must never throw into the caller. */
export interface NotifierPort {
  notify(n: Notification): Promise<void>;
}

/**
 * Atomic small-file persistence for the latch and the snapshot cache.
 * Implementations write tmp -> fsync -> rename within one directory (P1-6).
 */
export interface StorePort {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
}

/** The only source of "now" in the system. Injected so domain stays pure and C14 can hold. */
export interface ClockPort {
  nowMs(): number;
  /** IANA zone name, or null when the host zone cannot be determined. */
  timezone(): string | null;
}
