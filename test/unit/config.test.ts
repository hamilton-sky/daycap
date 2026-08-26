import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, parseConfigText } from "../../src/domain/config.ts";

const warns = (raw: unknown) => parseConfig(raw).warnings.join(" | ");

describe("parseConfig — never throws, always renders", () => {
  it.each([null, undefined, 42, "text", [], true])("degrades to defaults for %j", (raw) => {
    const { config, warnings } = parseConfig(raw);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("reports invalid JSON rather than crashing", () => {
    const { config, warnings } = parseConfigText("{ not json");
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.join()).toContain("not valid JSON");
  });

  it("a fully understood file produces no warnings", () => {
    const { warnings } = parseConfig({
      dailyBudgetUsd: 25,
      resetHourLocal: 4,
      thresholds: [0.5, 0.9],
      source: "ccusage",
      tools: ["claude-code"],
      primarySignal: "usd",
      pacing: true,
      notifications: { enabled: true },
      timezone: "Asia/Jerusalem",
    });
    expect(warnings).toEqual([]);
  });
});

describe("parseConfig — back-compat aliases (§8 finding 5)", () => {
  it("accepts `clis` as the old name for `tools`", () => {
    const { config, warnings } = parseConfig({ clis: ["claude-code", "codex"] });
    expect(config.tools).toEqual(["claude-code", "codex"]);
    expect(warnings.join()).toContain("clis");
  });

  it("prefers `tools` when both are present", () => {
    expect(parseConfig({ tools: ["a"], clis: ["b"] }).config.tools).toEqual(["a"]);
  });

  it("maps imputeCostForSubscription true -> primarySignal usd", () => {
    const { config, warnings } = parseConfig({ imputeCostForSubscription: true });
    expect(config.primarySignal).toBe("usd");
    expect(warnings.join()).toContain("imputeCostForSubscription");
  });

  it("maps imputeCostForSubscription false -> primarySignal auto", () => {
    expect(parseConfig({ imputeCostForSubscription: false }).config.primarySignal).toBe("auto");
  });

  it("an explicit primarySignal wins over the old boolean", () => {
    const { config } = parseConfig({
      primarySignal: "rate-limit",
      imputeCostForSubscription: true,
    });
    expect(config.primarySignal).toBe("rate-limit");
  });
});

describe("parseConfig — field validation", () => {
  it.each([-1, Number.NaN, "10", null])(
    "rejects dailyBudgetUsd %j and leaves budget unset",
    (v) => {
      expect(parseConfig({ dailyBudgetUsd: v }).config.dailyBudgetUsd).toBe(0);
    },
  );

  it("accepts a zero budget as a deliberate 'not set'", () => {
    expect(parseConfig({ dailyBudgetUsd: 0 }).warnings).toEqual([]);
  });

  it.each([-1, 24, 3.5, "4"])("rejects resetHourLocal %j", (v) => {
    expect(parseConfig({ resetHourLocal: v }).config.resetHourLocal).toBe(0);
    expect(warns({ resetHourLocal: v })).toContain("resetHourLocal");
  });

  it("sorts thresholds ascending and drops unusable ones", () => {
    expect(parseConfig({ thresholds: [1, 0.8, "x", -1, 0] }).config.thresholds).toEqual([0.8, 1]);
  });

  it("falls back when thresholds holds nothing usable", () => {
    expect(parseConfig({ thresholds: ["x"] }).config.thresholds).toEqual(DEFAULT_CONFIG.thresholds);
  });

  it("rejects an unknown source id", () => {
    expect(parseConfig({ source: "nope" }).config.source).toBe("auto");
    expect(warns({ source: "nope" })).toContain("nope");
  });

  it("trims and keeps a timezone, and allows explicit null", () => {
    expect(parseConfig({ timezone: "  UTC " }).config.timezone).toBe("UTC");
    expect(parseConfig({ timezone: null }).config.timezone).toBeNull();
  });

  it("ignores unknown future keys rather than failing", () => {
    expect(parseConfig({ someKeyFromV3: 1 }).warnings).toEqual([]);
  });
});
