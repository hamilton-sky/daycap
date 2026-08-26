/**
 * Contract harness for the ccusage shell-out adapter.
 *
 * The four scenarios are arranged entirely through `resolveBinary`, which is why that seam exists
 * on `CcusageOptions` at all:
 *
 *   present / hanging / garbage — resolve to `node test/stubs/fake-ccusage-bin.mjs`, with the
 *                                 behaviour selected by a `--fake-mode=` flag in `prefixArgs`.
 *   absent                      — resolve to `null`, which is what tier 4 does when no binary is
 *                                 found anywhere.
 *
 * `absent` is injected rather than arranged by emptying PATH: `PATH=''` does not fail uniformly
 * across platforms (Windows resolves `.exe` through `PATHEXT`), so a PATH-stripping test belongs
 * in an integration test, not in a contract every adapter must pass. See test/contract/README.md.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CcusageSource } from "../../src/adapters/source/ccusage.shellout.ts";
import {
  type Corpus,
  loadCorpus,
  type Scenario,
  type SourceHarness,
  type StartedSource,
} from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_BIN = resolve(here, "../stubs/fake-ccusage-bin.mjs");

/** Runs the stub under the current node, exactly as tier 2 would run a JS launcher. */
export function fakeResolver(scenario: Scenario): () => {
  command: string;
  prefixArgs: string[];
} | null {
  if (scenario === "absent") return () => null;
  const prefixArgs = [FAKE_BIN];
  if (scenario === "hanging") prefixArgs.push("--fake-mode=hanging");
  if (scenario === "garbage") prefixArgs.push("--fake-mode=garbage");
  return () => ({ command: process.execPath, prefixArgs });
}

export const ccusageHarness: SourceHarness = {
  id: "ccusage",
  // Measured, not assumed: ccusage reports whole calendar days (M1_RESULT.md §1).
  granularity: "day",

  start(scenario: Scenario): Promise<StartedSource> {
    const source = new CcusageSource({ resolveBinary: fakeResolver(scenario) });
    return Promise.resolve({
      source,
      // A hung stub outlives the case that started it unless someone reaps it. C11a rejects
      // without killing, so stop() must, or the suite leaks a process per run.
      stop: () => {
        source.killInFlight();
        return Promise.resolve();
      },
      inFlightPid: () => source.inFlightPid(),
      killInFlight: () => source.killInFlight(),
    });
  },

  get corpus(): Corpus {
    return loadCorpus();
  },

  skips: {
    C14b:
      "the adapter takes its zone from window.tz and never reads the environment, so mutating " +
      "TZ in-process cannot make this case fail — it would assert nothing. The discriminating " +
      "version asserts the emitted --since/--until are byte-identical across zones, which needs " +
      "the argv log; see test/unit/ccusage-argv.test.ts.",
  },
};
