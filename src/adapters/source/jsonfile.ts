/**
 * `jsonfile` — the escape hatch, and the second real implementation of `UsageSourcePort`.
 *
 * P1-5. Two jobs, and the second is why it was pulled forward from P4:
 *
 * 1. A user whose collector nobody has adapted produces a JSON file however they like — a cron
 *    job, a shell one-liner, an export from a tool we have never heard of — and points `lum` at
 *    it. Without this, "swap the collector" is a promise the architecture makes and cannot keep.
 * 2. A port with ONE implementation is decoration. Every claim about `UsageSourcePort` being a
 *    real seam rests on a second adapter passing the same 18-case suite unmodified, and until this
 *    file existed those claims were untested. The contract suite did not change to admit it.
 *
 * ADR-v2-001 still holds, and holds most sharply here: this reads a file the USER owns and asked us
 * to read, which is the opposite of reaching into a collector's private transcript store. The
 * distinction is consent and ownership, not file format.
 *
 * ## The schema
 *
 * ```json
 * {
 *   "schema": 1,
 *   "generatedAtUtc": "2026-08-22T12:00:00.000Z",
 *   "entries": [
 *     { "at": "2026-08-21T09:00:00.000Z", "tool": "claude-code", "usd": 4.0, "imputed": true },
 *     { "at": "2026-08-22T11:00:00.000Z", "tool": "some-tool",   "usd": null }
 *   ]
 * }
 * ```
 *
 * One entry per priced event, each carrying its own instant — which is why granularity is
 * `instant` rather than `day`. Whoever writes the file already knows when the money was spent; a
 * format that threw that away would make the boundary approximate for no reason.
 *
 * `usd: null` means "activity this producer could not price". It is NOT zero and never becomes
 * zero (invariant 1, contract C9c). That the schema can express it at all is the point.
 */

import { readFile } from "node:fs/promises";
import { SourceIncompatibleError, SourceUnavailableError } from "../../domain/errors.ts";
import type { SourceGranularity, UsageSourcePort } from "../../domain/ports.ts";
import type { ToolSpend, UsageWindow } from "../../domain/types.ts";

export type JsonFileOptions = {
  /** Absolute path to the user's file. */
  path: string;
  /**
   * Read seam, defaulting to `fs.readFile`.
   *
   * It exists for exactly one reason, and the reason is worth stating so it is not mistaken for
   * general-purpose indirection: contract case C11a requires a source that never settles, and a
   * filesystem read cannot be made to hang portably. A FIFO blocks on POSIX and does not exist on
   * Windows. So the contract harness injects a non-settling reader for that ONE scenario, and
   * arranges the other three with real files — present, absent (a genuine ENOENT) and garbage.
   *
   * Nothing in `src/` passes this. If a second caller ever does, ask what it is really for.
   */
  readText?: (path: string) => Promise<string>;
};

/** One entry after validation. Structurally identical to the file's, minus anything unknown. */
type Entry = {
  at: number;
  tool: string;
  usd: number | null;
  imputed: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class JsonFileSource implements UsageSourcePort {
  readonly id = "jsonfile";

  /**
   * `instant`, and this is a measured property of the format rather than an aspiration: every entry
   * carries its own timestamp, so an arbitrary `[from, to)` is answerable exactly. This is the
   * reason `app/meter.ts` never sets `dayBoundaryApprox` for this source, and the reason the
   * contract runs its `narrowInstant` window — including the boundary probe at 12:00 that a `<=`
   * comparison would wrongly include.
   */
  readonly granularity: SourceGranularity = "instant";

  readonly #path: string;
  readonly #readText: (path: string) => Promise<string>;

  constructor(options: JsonFileOptions) {
    this.#path = options.path;
    this.#readText = options.readText ?? ((p) => readFile(p, "utf8"));
  }

  /**
   * Resolves, never throws (C2) — including when the file is missing, unreadable, or not our
   * schema. `available()` answers "could this source produce a number", and every one of those
   * says no without being an exceptional condition.
   */
  async available(): Promise<boolean> {
    try {
      this.#parse(await this.#readText(this.#path));
      return true;
    } catch {
      return false;
    }
  }

  async spendFor(window: UsageWindow): Promise<ToolSpend[]> {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new SourceIncompatibleError(this.id, "window was not ISO-8601");
    }

    const entries = this.#parse(await this.#read());

    // Half-open [from, to) — `from` inclusive, `to` exclusive. The domain's single convention, and
    // the one line most likely to be "fixed" into `<=` by someone who reads an exclusive bound as
    // an off-by-one. The corpus keeps a probe sitting exactly on `to` so that edit fails C8.
    const inWindow = entries.filter((e) => e.at >= from && e.at < to);

    // Group by tool, summing in integer cents to keep float drift out of the total. A group whose
    // every entry was unpriceable stays `null` rather than collapsing to 0 — a tool with only
    // unpriced activity must not report $0.00 (invariant 1, C9c). A group with a MIX sums the
    // priced entries and reports that: the total is a floor, which `pricingPartial` upstream is
    // what says out loud. Silently returning null for the mixed case would throw away money we do
    // know about; silently returning 0 for the all-null case would invent certainty we do not have.
    const byTool = new Map<string, { cents: number | null; imputed: boolean }>();
    for (const e of inWindow) {
      const cents = e.usd === null ? null : Math.round(e.usd * 100);
      const prev = byTool.get(e.tool);
      if (prev === undefined) {
        byTool.set(e.tool, { cents, imputed: e.imputed });
        continue;
      }
      prev.cents = prev.cents === null && cents === null ? null : (prev.cents ?? 0) + (cents ?? 0);
      prev.imputed = prev.imputed || e.imputed;
    }

    // Built field by field from validated values. NOT a spread of the parsed entry: the user's file
    // may carry anything at all next to the fields we asked for — a repo name, a prompt, a path —
    // and `{...entry}` would carry every one of them onto a returned object and out to whatever
    // renders or caches it. C13 is what fails when this becomes a spread.
    return [...byTool.entries()].map(([tool, v]) => ({
      tool,
      usd: v.cents === null ? null : v.cents / 100,
      imputed: v.imputed,
    }));
  }

  /**
   * The producer's own watermark, or null.
   *
   * `generatedAtUtc` is the file's claim about itself and is preferred over the file's mtime: a
   * `cp`, a `git checkout` or a restore all bump mtime without the data being any newer, which is
   * precisely the wrong direction for a freshness signal to be wrong in. Absent or unparseable,
   * we say null rather than guessing — `lum doctor` prints "exposes no freshness watermark of its
   * own", which is true and useful, where a fabricated timestamp is neither.
   */
  async freshness(): Promise<{ lastUpdatedUtc: string | null }> {
    try {
      const doc = JSON.parse(await this.#readText(this.#path)) as unknown;
      if (!isRecord(doc)) return { lastUpdatedUtc: null };
      const stamp = doc.generatedAtUtc;
      if (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))) {
        return { lastUpdatedUtc: null };
      }
      return { lastUpdatedUtc: new Date(Date.parse(stamp)).toISOString() };
    } catch {
      return { lastUpdatedUtc: null };
    }
  }

  /** Read, converting a missing or unreadable file into the typed unavailable channel. */
  async #read(): Promise<string> {
    try {
      return await this.#readText(this.#path);
    } catch {
      // Deliberately NOT `[]`. An empty array is indistinguishable from "the producer confirms zero
      // spend", which is the `$0.00` bug wearing a different hat — the same reasoning that makes
      // `withTimeout` reject instead of resolving empty. The user named this file; if it is not
      // there, that is a fact they need told, not smoothed over.
      throw new SourceUnavailableError(this.id, [this.#path]);
    }
  }

  /**
   * Parse and validate. Every rejection is a typed `SourceIncompatibleError`, never a TypeError
   * escaping from a property access on something that turned out to be a string (C12).
   */
  #parse(text: string): Entry[] {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new SourceIncompatibleError(this.id, "file is not valid JSON");
    }
    if (!isRecord(doc)) throw new SourceIncompatibleError(this.id, "top level was not an object");
    if (doc.schema !== 1) {
      // Named explicitly so a future schema 2 fails loudly here rather than being half-read by a
      // parser written for schema 1.
      throw new SourceIncompatibleError(this.id, `unsupported schema ${String(doc.schema)}`);
    }
    if (!Array.isArray(doc.entries)) {
      throw new SourceIncompatibleError(this.id, "entries was not an array");
    }

    return doc.entries.map((raw, i) => this.#entry(raw, i));
  }

  #entry(raw: unknown, index: number): Entry {
    const where = `entries[${index}]`;
    if (!isRecord(raw)) throw new SourceIncompatibleError(this.id, `${where} was not an object`);

    const at = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
    if (Number.isNaN(at)) {
      throw new SourceIncompatibleError(this.id, `${where}.at was not an ISO-8601 instant`);
    }

    if (typeof raw.tool !== "string" || raw.tool.trim().length === 0) {
      throw new SourceIncompatibleError(this.id, `${where}.tool was missing or empty`);
    }

    // Syntactic normalisation only — trim and lower-case (C6). There is no canonical alias map and
    // there must not be one: a per-tool branch is forbidden anywhere in src/ (P1-1), and this
    // source's whole purpose is tools nobody has enumerated. An id nobody recognises passes
    // through verbatim, which is what makes the escape hatch an escape hatch.
    const tool = raw.tool
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-");

    // `undefined` and `null` are both "could not price". Only a finite non-negative number is a
    // price. A string that looks like a number is a schema error, not something to coerce: the
    // producer is telling us something we do not understand, and guessing is how `"1,234"` becomes
    // 1. Note what is NOT here: any use of `tokens`. Deriving USD from tokens is re-pricing, which
    // ADR-v2-001 forbids and contract C9b makes observable.
    let usd: number | null = null;
    if (raw.usd !== undefined && raw.usd !== null) {
      if (typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || raw.usd < 0) {
        throw new SourceIncompatibleError(
          this.id,
          `${where}.usd must be a non-negative number or null`,
        );
      }
      usd = raw.usd;
    }

    return { at, tool, usd, imputed: raw.imputed === true };
  }
}
