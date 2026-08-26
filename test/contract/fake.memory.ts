/**
 * The reference implementation of UsageSourcePort.
 *
 * This is not "a test double that roughly behaves like a collector" — it is the DEFINITION of
 * correct behaviour. When a real adapter and this fake disagree about the same corpus, the fake
 * is right and the adapter has a bug. That only holds because it loads the same CORPUS.json the
 * real fixtures encode; give the fake a private corpus and the suite stops being a shared
 * contract and becomes two unrelated test files that happen to import the same helper.
 */

import { SourceIncompatibleError } from "../../src/domain/errors.ts";
import type { SourceGranularity, UsageSourcePort } from "../../src/domain/ports.ts";
import type { ToolSpend, UsageWindow } from "../../src/domain/types.ts";
import {
  type Corpus,
  loadCorpus,
  type Scenario,
  type SourceHarness,
  type StartedSource,
  type StartOptions,
  toCents,
} from "./harness.ts";

export class InMemoryUsageSource implements UsageSourcePort {
  readonly id = "memory";
  readonly granularity: SourceGranularity = "instant";

  #corpus: Corpus;
  #scenario: Scenario;

  constructor(corpus: Corpus, scenario: Scenario = "present") {
    this.#corpus = corpus;
    this.#scenario = scenario;
  }

  available(): Promise<boolean> {
    if (this.#scenario === "hanging") return new Promise<boolean>(() => {});
    return Promise.resolve(this.#scenario === "present" || this.#scenario === "garbage");
  }

  spendFor(window: UsageWindow): Promise<ToolSpend[]> {
    if (this.#scenario === "hanging") return new Promise<ToolSpend[]>(() => {});
    if (this.#scenario === "absent") return Promise.resolve([]);
    if (this.#scenario === "garbage") {
      return Promise.reject(
        new SourceIncompatibleError(this.id, "rows[] was a string (simulated schema drift)"),
      );
    }

    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return Promise.reject(new SourceIncompatibleError(this.id, "window was not ISO-8601"));
    }

    // Half-open [from, to). `from` inclusive, `to` exclusive — the domain's one convention.
    // An adapter that uses <= here double-counts every boundary instant.
    const inWindow = this.#corpus.rows.filter((r) => {
      const at = Date.parse(r.at);
      return at >= from && at < to;
    });

    // Group by tool, summing in integer cents. Unpriceable rows keep the group `null` rather than
    // contributing zero — a tool with only unpriced activity must not report $0.00.
    const byTool = new Map<string, { cents: number | null; imputed: boolean }>();
    for (const row of inWindow) {
      const prev = byTool.get(row.tool);
      const cents = toCents(row.usd);
      if (prev === undefined) {
        byTool.set(row.tool, { cents, imputed: row.imputed });
        continue;
      }
      prev.cents = prev.cents === null && cents === null ? null : (prev.cents ?? 0) + (cents ?? 0);
      prev.imputed = prev.imputed || row.imputed;
    }

    // `_canary` is deliberately NOT copied onto the result. C13 asserts that; this is the line
    // that makes it pass, and the line a careless adapter forgets.
    return Promise.resolve(
      [...byTool.entries()].map(([tool, v]) => ({
        tool,
        usd: v.cents === null ? null : v.cents / 100,
        imputed: v.imputed,
      })),
    );
  }

  freshness(): Promise<{ lastUpdatedUtc: string | null }> {
    if (this.#scenario === "hanging")
      return new Promise<{ lastUpdatedUtc: string | null }>(() => {});
    if (this.#scenario !== "present") return Promise.resolve({ lastUpdatedUtc: null });
    const latest = this.#corpus.rows.reduce<string | null>(
      (acc, r) => (acc === null || r.at > acc ? r.at : acc),
      null,
    );
    return Promise.resolve({ lastUpdatedUtc: latest });
  }
}

export const memoryHarness: SourceHarness = {
  id: "memory",
  granularity: "instant",
  start(scenario: Scenario, _options: StartOptions): Promise<StartedSource> {
    const source = new InMemoryUsageSource(loadCorpus(), scenario);
    return Promise.resolve({ source, stop: () => Promise.resolve() });
  },
  get corpus(): Corpus {
    return loadCorpus();
  },
  skips: {
    C11b: "in-process fake spawns no child, so there is no pid to assert was killed",
    C14b: "TZ perturbation needs a child process; this harness never spawns one",
  },
};
