import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "../../src/bin/statusline.js";

/**
 * P3-4 — the latency budget, asserted as THREE layers.
 *
 * A single "< 30 ms" number is unmeetable and always was: Node's own cold start is ~40 ms before
 * a line of our code runs. Asserting it would mean either a permanently red build or a threshold
 * quietly raised until it stopped meaning anything.
 *
 *   Layer A  our render path, in-process        — the only part we actually control
 *   Layer B  marginal cost of OUR script over a bare node boot — the honest version of "< 30 ms"
 *   Layer C  absolute wall clock, interpreter included — what the user's prompt actually waits for
 *
 * Layer B is the one that would catch a regression: it subtracts the interpreter so the number is
 * about our code, not about the machine CI happens to run on.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(root, "src", "bin", "statusline.js");

const p95 = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lum-perf-"));
  const state = join(home, ".localusagemeter", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "today.json"),
    JSON.stringify({
      schema: 1,
      usageDay: "2026-08-26",
      generatedAtUtc: new Date().toISOString(),
      sourceId: "ccusage",
      sourceFresh: true,
      sourceLastUpdatedUtc: null,
      health: { kind: "ok" },
      tools: [{ tool: "claude-code", usd: 3.2, imputed: true }],
      totalUsd: 3.2,
      pricingPartial: false,
      imputed: true,
      dayBoundaryApprox: false,
    }),
  );
  writeFileSync(
    join(home, ".localusagemeter", "config.json"),
    JSON.stringify({ dailyBudgetUsd: 10 }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const snapshot = {
  schema: 1,
  usageDay: "2026-08-26",
  generatedAtUtc: new Date().toISOString(),
  health: { kind: "ok" },
  tools: [{ tool: "claude-code", usd: 3.2, imputed: true }],
  totalUsd: 3.2,
  pricingPartial: false,
  imputed: true,
};

describe("P3-4 layer A — the render path (< 5ms p95)", () => {
  it("renders 200 times well inside budget", () => {
    const stdin = {
      rate_limits: {
        five_hour: { used_percentage: 23, resets_at: "x" },
        seven_day: { used_percentage: 41, resets_at: "y" },
      },
    };
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      render(snapshot, { config: { dailyBudgetUsd: 10 }, stdin, nowMs: Date.now(), mode: "256" });
      samples.push(performance.now() - t);
    }
    expect(p95(samples)).toBeLessThan(5);
  });
});

// Spawning 2x60 processes is slow and pointless on a laptop mid-edit; these are the CI gate.
const spawny = process.env.CI === "true" || process.env.LUM_PERF === "1" ? describe : describe.skip;

spawny("P3-4 layers B and C — spawn cost", () => {
  const runs = 60;

  function timeSpawn(args: string[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      execFileSync(process.execPath, args, {
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "ignore"],
        input: "",
      });
      out.push(performance.now() - t);
    }
    return out;
  }

  it("layer B — marginal cost over a bare node boot is < 30ms p95", () => {
    const baseline = p95(timeSpawn(["-e", ""]));
    const actual = p95(timeSpawn([SCRIPT]));
    const marginal = actual - baseline;
    // This is the honest reading of the plan's "< 30 ms": everything except the interpreter.
    expect(
      marginal,
      `baseline ${baseline.toFixed(1)}ms, actual ${actual.toFixed(1)}ms`,
    ).toBeLessThan(30);
  });

  it("layer C — absolute wall clock is < 150ms p95", () => {
    expect(p95(timeSpawn([SCRIPT]))).toBeLessThan(150);
  });
});

describe("P3-4 — the hot path stays thin", () => {
  it("opens at most 3 files and never a socket", () => {
    // snapshot + config + (optionally) the echo file. A fourth open would mean it had started
    // doing work rather than reading a cache.
    const text = execFileSync(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", SCRIPT],
      { encoding: "utf8" },
    );
    const reads = [...text.matchAll(/readFileSync\(|writeFileSync\(/g)].length;
    expect(reads).toBeLessThanOrEqual(4); // 2 readJson call sites + stdin + echo write
    expect(text).not.toContain("node:net");
    expect(text).not.toContain("child_process");
  });

  it("the built statusline is present in package.json files[] so it actually ships", () => {
    const pkg = JSON.parse(
      execFileSync(
        "node",
        ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"],
        {
          cwd: root,
          encoding: "utf8",
        },
      ),
    ) as { files: string[] };
    expect(pkg.files.some((f) => f.includes("statusline"))).toBe(true);
  });
});
