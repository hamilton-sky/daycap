#!/usr/bin/env node
/**
 * A stand-in for the real `ccusage` binary.
 *
 * It serves CORPUS.json — the same ground truth the in-memory reference implements — re-shaped
 * into ccusage's ACTUAL schema as measured in M1_RESULT.md: `daily[].period` (not `date`),
 * `totalCost` (not `costUSD`), and a `modelBreakdowns[]` list carrying the per-model split.
 *
 * Crucially it emits ONE set of rows containing every tool, because that is what the real binary
 * does — `ccusage daily` already includes Codex. A stub that split Claude and Codex into separate
 * commands would let the double-counting bug pass its own contract test.
 *
 * Scenario and argv-log come in as `--fake-mode=X` / `--fake-argv-log=PATH` in argv, NOT via the
 * environment: the adapter deliberately hands its child a minimal env (PATH/HOME only) so the
 * collector cannot pick up configuration nobody chose, and that correctly strips any env we might
 * have tried to smuggle through. argv is prepended by the harness via `prefixArgs`.
 *
 * modes: present (default) | hanging | garbage
 */

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raw = process.argv.slice(2);
const valueOf = (prefix, fallback) => {
  const hit = raw.find((a) => a.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
};
const MODE = valueOf("--fake-mode=", "present");
const log = valueOf("--fake-argv-log=", undefined);
// The adapter's own argv is whatever is left once our harness flags are removed.
const argv = raw.filter((a) => !a.startsWith("--fake-"));

if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

if (MODE === "hanging") {
  // Never answer, never exit. C11a asserts the timeout fires; C11b asserts we get killed.
  setInterval(() => {}, 1 << 30);
} else if (argv.includes("--version")) {
  process.stdout.write("20.0.20\n");
} else if (MODE === "garbage") {
  // HTTP-200-with-nonsense, shell-out flavour: valid JSON, wrong shape.
  process.stdout.write(JSON.stringify({ daily: "not-an-array", totals: 7 }));
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(
    readFileSync(resolve(here, "../fixtures/collector/CORPUS.json"), "utf8"),
  );

  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // ccusage takes YYYYMMDD and both bounds are INCLUSIVE.
  const since = flag("--since");
  const until = flag("--until");

  // Real ccusage reports models, not tools. Map the corpus's tool ids onto model names so the
  // adapter's own model->tool attribution is what gets exercised — the thing that replaced the
  // non-functional `--by-agent`.
  const MODEL = { "claude-code": "claude-opus-5", codex: "gpt-5.6-terra" };

  const days = new Map();
  for (const row of corpus.rows) {
    const day = row.at.slice(0, 10); // corpus windows are UTC
    const key = day.replace(/-/g, "");
    if (since && key < since) continue;
    if (until && key > until) continue;
    if (!days.has(day)) days.set(day, new Map());
    const models = days.get(day);
    const model = MODEL[row.tool] ?? row.tool;
    const prev = models.get(model) ?? { cost: null, tokens: row.tokens };
    prev.cost = prev.cost === null && row.usd === null ? null : (prev.cost ?? 0) + (row.usd ?? 0);
    models.set(model, prev);
  }

  const daily = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, models]) => {
      const breakdowns = [...models.entries()].map(([modelName, v]) => ({
        modelName,
        cost: v.cost,
        inputTokens: v.tokens?.in ?? 0,
        outputTokens: v.tokens?.out ?? 0,
        cacheReadTokens: v.tokens?.cacheRead ?? 0,
        cacheCreationTokens: v.tokens?.cacheWrite ?? 0,
      }));
      return {
        // A canary in the FIRST field, not only the last. Mutation testing showed a leak of just
        // the head of the payload (`JSON.stringify(raw).slice(0, 200)`) sailed past C13 when every
        // canary lived in trailing fields. A partial leak is still a leak.
        sessionId: corpus.canaries[1],
        period,
        agent: "all", // measured: --by-agent never splits, every row says "all"
        totalCost: breakdowns.reduce((a, b) => a + (b.cost ?? 0), 0),
        modelsUsed: breakdowns.map((b) => b.modelName),
        modelBreakdowns: breakdowns,
        metadata: { agents: ["claude", "codex"] },
        // Fields the adapter must ignore. Real payloads carry repo names and paths; the canaries
        // stand in for them so C13 fails loudly if any of this is copied onto a result.
        projectPaths: corpus.canaries,
        sessionTitle: corpus.canaries[0],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
    });

  process.stdout.write(
    JSON.stringify({
      daily,
      totals: { totalCost: daily.reduce((a, d) => a + d.totalCost, 0) },
    }),
  );
}
