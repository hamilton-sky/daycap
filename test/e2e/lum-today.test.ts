import { describe, expect, it } from "vitest";
import { NO_SOURCE, renderToday, STALE_AFTER_SECONDS } from "../../src/adapters/render/table.ts";
import { CLI_NAME, LEGACY_CLI_NAME } from "../../src/domain/brand.ts";
import { DEFAULT_CONFIG, parseConfigText } from "../../src/domain/config.ts";
import type { Config, SourceHealth, ToolSpend, UsageSnapshot } from "../../src/domain/types.ts";

/**
 * The nine-row degradation matrix (IMPLEMENTATION_PLAN.md §2 P1-8).
 *
 * These are NORMAL states. Every one renders something truthful and exits 0. The rule that
 * outranks all of them has its own describe block at the bottom: unknown never renders as $0.00.
 */

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  schema: 1,
  usageDay: "2026-08-26",
  generatedAtUtc: new Date(NOW).toISOString(),
  sourceId: "ccusage",
  sourceFresh: true,
  sourceLastUpdatedUtc: null,
  health: { kind: "ok" },
  tools: [{ tool: "claude-code", usd: 8, imputed: true }] as ToolSpend[],
  totalUsd: 8,
  pricingPartial: false,
  imputed: true,
  dayBoundaryApprox: false,
  ...over,
});

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over });
const render = (s: UsageSnapshot | null, c: Config = cfg(), nowMs = NOW) =>
  renderToday(s, c, { nowMs, width: 80 }).join("\n");

describe("degradation matrix", () => {
  it("row 1 — no collector at all", () => {
    const health: SourceHealth = { kind: "no-source", lookedFor: ["ccusage"] };
    expect(render(snapshot({ health, tools: [], totalUsd: null }))).toBe(NO_SOURCE);
  });

  it.skip("row 2 — daemon down, falls through to budi.cli [budi.http deleted from v1 per BUILD_PLAN_v3]", () => {});

  it("row 3 — collector slow: last cached snapshot, with its age", () => {
    const out = render(snapshot({ health: { kind: "timeout", afterMs: 3000 } }));
    expect(out).toContain("$8.00");
    expect(out).toContain("⋯");
    expect(out).toContain("3000ms");
  });

  it("row 4 — stale cache (> 15 min): the value, marked with ⋯ and its age", () => {
    const old = new Date(NOW - 18 * 60_000).toISOString();
    const out = render(snapshot({ generatedAtUtc: old }));
    expect(out).toContain("$8.00");
    expect(out).toContain("⋯");
    expect(out).toContain("18m");
  });

  it("row 4b — just inside the stale threshold is NOT marked", () => {
    const fresh = new Date(NOW - (STALE_AFTER_SECONDS - 1) * 1000).toISOString();
    expect(render(snapshot({ generatedAtUtc: fresh }))).not.toContain("⋯");
  });

  it("row 5 — no cache, cold start", () => {
    expect(render(null)).toBe(NO_SOURCE);
  });

  it("row 6 — partial tool coverage: rows present, marked (partial)", () => {
    const out = render(
      snapshot({
        tools: [
          { tool: "claude-code", usd: 8, imputed: true },
          { tool: "cursor", usd: null, imputed: false },
        ],
        pricingPartial: true,
      }),
    );
    expect(out).toContain("(partial)");
    expect(out).toContain("cursor");
    // The unpriceable tool shows an em dash, never a zero.
    expect(out).toMatch(/cursor\s+—/);
  });

  it("row 7 — schema drift", () => {
    const health: SourceHealth = { kind: "incompatible", detail: "no daily[]" };
    expect(render(snapshot({ health }))).toBe(NO_SOURCE);
  });

  it("row 8 — config missing or invalid: defaults, and it still renders", () => {
    for (const text of [null, "{not json", '"a string"', "[]"]) {
      const { config, warnings } = parseConfigText(text);
      expect(warnings.length).toBeGreaterThan(0);
      expect(render(snapshot(), config)).toContain("$8.00");
    }
  });

  it("row 9 — dailyBudgetUsd unset or 0: absolute spend, no % and no bar", () => {
    for (const dailyBudgetUsd of [0, undefined]) {
      const out = render(snapshot(), cfg({ dailyBudgetUsd: dailyBudgetUsd ?? 0 }));
      expect(out).toContain("$8.00");
      expect(out).not.toContain("█");
      expect(out).not.toMatch(/\d+%/);
    }
  });

  it("with a budget set, the percentage and bar appear", () => {
    const out = render(snapshot(), cfg({ dailyBudgetUsd: 10 }));
    expect(out).toContain("80%");
    expect(out).toContain("█");
  });
});

describe("UNKNOWN NEVER RENDERS AS $0.00", () => {
  it.each<[string, UsageSnapshot | null]>([
    ["null snapshot", null],
    ["no-source", snapshot({ health: { kind: "no-source", lookedFor: [] }, totalUsd: null })],
    ["incompatible", snapshot({ health: { kind: "incompatible", detail: "x" }, totalUsd: null })],
    ["total unknown", snapshot({ totalUsd: null, tools: [] })],
    [
      "every tool unpriceable",
      snapshot({
        tools: [{ tool: "a", usd: null, imputed: false }],
        totalUsd: null,
        pricingPartial: true,
      }),
    ],
  ])("%s renders no zero figure", (_name, snap) => {
    const out = render(snap, cfg({ dailyBudgetUsd: 10 }));
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("0%");
  });

  it("a genuine zero is still allowed to say zero", () => {
    // "you spent nothing" is a fact the collector CAN report; only "we don't know" must not.
    const out = render(snapshot({ tools: [{ tool: "a", usd: 0, imputed: false }], totalUsd: 0 }));
    expect(out).toContain("$0.00");
  });
});

describe("day-boundary approximation", () => {
  it("marks the total with ~ when a day-granularity source met a non-zero reset hour", () => {
    expect(render(snapshot({ dayBoundaryApprox: true }))).toContain("~");
  });
  it("does not mark it otherwise", () => {
    expect(render(snapshot({ dayBoundaryApprox: false }))).not.toContain("~");
  });
});

/**
 * The header, pinned to the brand constant.
 *
 * NOTHING ASSERTED THIS, which is how the rename to `daycap` shipped a `lum today` whose first line
 * still read "lum — 2026-08-28". Every other user-visible string was caught by a test holding a
 * literal; this one was caught by nobody, and it is the most prominent line the command prints.
 *
 * Asserted against CLI_NAME rather than against "daycap" on purpose: a test holding the literal is
 * exactly what made the other renames noisy, and a test holding nothing is what let this one through.
 */
describe("renderToday — the header carries the product name", () => {
  it("starts with the CLI name, not a hardcoded one", () => {
    const first = render(snapshot(), cfg({ dailyBudgetUsd: 10 })).split("\n")[0] ?? "";
    expect(first).toContain(CLI_NAME);
    expect(first).toContain(snapshot().usageDay);
  });

  it("says so even in the degraded no-source line", () => {
    expect(NO_SOURCE).toContain(CLI_NAME);
  });

  it("carries no stale product name anywhere in a rendered table", () => {
    // The generalisation: whatever the previous name was, it must not survive in output. This is the
    // assertion whose absence let the header rot for a whole rename.
    const text = render(snapshot(), cfg({ dailyBudgetUsd: 10 }));
    expect(text).not.toContain(LEGACY_CLI_NAME);
  });
});
