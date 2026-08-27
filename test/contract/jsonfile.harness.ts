/**
 * Contract harness for the `jsonfile` adapter.
 *
 * THREE OF THE FOUR SCENARIOS ARE REAL. `present`, `absent` and `garbage` are arranged with an
 * actual file on an actual temp directory — a real parse, a real ENOENT, real schema drift. That is
 * a deliberate contrast with the ccusage harness, which has to inject `absent` because `PATH=''`
 * behaves differently on Windows: a missing file, unlike a missing binary, is missing identically
 * everywhere, so there is nothing to fake.
 *
 * `hanging` is the exception and the only injected one. A filesystem read cannot be made to hang
 * portably — a FIFO blocks on POSIX and does not exist on Windows — so C11a gets a reader that
 * never settles. The seam exists for that case and no other; see `JsonFileOptions.readText`.
 *
 * The file content is GENERATED from CORPUS.json rather than checked in beside it. The schema is
 * close enough to the corpus row shape that a hand-maintained copy would be two representations of
 * the same rows drifting apart silently, which is the exact failure test/contract/README.md warns
 * about. What is NOT generated is the expectations: `expected` and `totals` are hand-written
 * literals in the corpus, so nothing here can make the adapter agree with itself.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileSource } from "../../src/adapters/source/jsonfile.ts";
import {
  type Corpus,
  loadCorpus,
  type Scenario,
  type SourceHarness,
  type StartedSource,
} from "./harness.ts";

/**
 * The corpus, rendered into the adapter's own schema.
 *
 * `_canary` is copied through ON PURPOSE. It is the whole of C13: a user's file may carry anything
 * at all next to the fields we asked for, and an adapter that spreads the parsed entry onto its
 * result hands every one of those to whatever renders or caches it. Stripping the canaries here
 * would make C13 pass against an adapter that leaks.
 */
export function corpusAsJsonFile(corpus: Corpus): string {
  const latest = corpus.rows.reduce<string | null>(
    (acc, r) => (acc === null || r.at > acc ? r.at : acc),
    null,
  );
  return JSON.stringify(
    {
      schema: 1,
      generatedAtUtc: latest,
      entries: corpus.rows.map((r) => ({
        at: r.at,
        tool: r.tool,
        usd: r.usd,
        imputed: r.imputed,
        // Passed through so the adapter has something to leak if it is careless with `tokens`,
        // which is also the field a re-pricing adapter would reach for (C9b).
        ...(r.tokens === undefined ? {} : { tokens: r.tokens }),
        ...(r._canary === undefined ? {} : { _canary: r._canary }),
      })),
    },
    null,
    2,
  );
}

/** Valid JSON, wrong shape. `entries` is a string — the C12 case, not a crash. */
const GARBAGE = JSON.stringify({ schema: 1, entries: "definitely not an array" });

const dirs: string[] = [];

export const jsonfileHarness: SourceHarness = {
  id: "jsonfile",
  // A property of the format, not an aspiration: every entry carries its own instant.
  granularity: "instant",

  start(scenario: Scenario): Promise<StartedSource> {
    const dir = mkdtempSync(join(tmpdir(), "lum-jsonfile-"));
    dirs.push(dir);
    const path = join(dir, "usage.json");

    if (scenario === "present") writeFileSync(path, corpusAsJsonFile(loadCorpus()), "utf8");
    if (scenario === "garbage") writeFileSync(path, GARBAGE, "utf8");
    // `absent` writes nothing at all — the adapter meets a genuine ENOENT.

    // The key is OMITTED rather than passed as undefined — `exactOptionalPropertyTypes` is on, and
    // it is right to be: "absent" and "explicitly undefined" mean different things for a seam whose
    // whole purpose is that only one scenario supplies it.
    const source = new JsonFileSource(
      scenario === "hanging"
        ? // Never settles. C11a asserts `withTimeout` rejects around it.
          { path, readText: () => new Promise<string>(() => {}) }
        : { path },
    );

    return Promise.resolve({
      source,
      stop: () => {
        rmSync(dir, { recursive: true, force: true });
        return Promise.resolve();
      },
    });
  },

  get corpus(): Corpus {
    return loadCorpus();
  },

  skips: {
    C11b:
      "this adapter spawns no child process — it reads a file in-process — so there is no pid " +
      "for the case to assert was killed. C11a still covers the timeout itself, and the import " +
      "gate in test/gates/imports.test.ts is what keeps a spawn from appearing here later.",
    C14b:
      "TZ perturbation is applied to a spawned child, and this harness never spawns one. The " +
      "property it targets is covered by construction rather than skipped in substance: every " +
      "comparison in the adapter is between epoch milliseconds from Date.parse of UTC instants, " +
      "and the adapter reads no zone at all — not window.tz, not the environment. C14a still " +
      "asserts window-not-clock dependence with two clocks 400 days apart, and " +
      "test/unit/jsonfile.test.ts asserts identical output under three process.env.TZ values.",
  },
};
