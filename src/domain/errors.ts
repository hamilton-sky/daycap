/**
 * Typed failure channels for every source adapter. PURE — no `node:*` imports.
 *
 * These exist so `app/meter.ts` can map a failure onto a `SourceHealth` state by TYPE rather than
 * by matching on message strings. A stack-string match is a bug that survives every refactor.
 *
 * The distinction that matters most is timeout-vs-empty. A timed-out collector must REJECT, never
 * resolve `[]` — an empty array is indistinguishable from "the collector confirms zero spend",
 * which is exactly how a stale meter renders `$0.00` and reports safety that isn't there (DoD #3).
 */

/** Base class so `catch (e) { if (e instanceof SourceError) ... }` works for every adapter fault. */
export abstract class SourceError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.sourceId = sourceId;
  }
}

/** The source answered, but its payload matches no known schema (contract C12). */
export class SourceIncompatibleError extends SourceError {
  constructor(sourceId: string, detail: string) {
    super(sourceId, `source ${sourceId} returned an incompatible payload: ${detail}`);
  }
}

/**
 * The source did not settle inside its timeout (contract C11).
 *
 * Carries `afterMs` so `lum doctor` can report the budget that was exceeded rather than a bare
 * "timed out", and so the caller can distinguish a 300 ms budget from a 5 s one.
 */
export class SourceTimeoutError extends SourceError {
  readonly afterMs: number;
  constructor(sourceId: string, afterMs: number) {
    super(sourceId, `source ${sourceId} did not settle within ${afterMs}ms`);
    this.afterMs = afterMs;
  }
}

/**
 * An explicitly configured source is not present.
 *
 * Only thrown when the user NAMED this source. `source: "auto"` probing an absent collector is not
 * an error — it moves on. Failing loudly here is deliberate: silently falling back from the source
 * someone chose is how you report the wrong tool's numbers without telling anyone (P4-3).
 */
export class SourceUnavailableError extends SourceError {
  readonly lookedFor: readonly string[];
  constructor(sourceId: string, lookedFor: readonly string[]) {
    super(sourceId, `source ${sourceId} is not available; looked for: ${lookedFor.join(", ")}`);
    this.lookedFor = lookedFor;
  }
}
