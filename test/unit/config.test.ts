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

/**
 * P4-3. `source` was parsed but unread until now, so these keys had no consequences; from this
 * commit they choose which collector every number comes from.
 */
describe("config — source selection keys (P4-3)", () => {
  it("accepts the three live source names", () => {
    for (const s of ["auto", "ccusage", "jsonfile"]) {
      // jsonfile gets a path: without one it warns, and rightly so — asserted separately below.
      // The first draft of this case omitted it and failed, which is the warning doing its job.
      const r = parseConfig(
        s === "jsonfile" ? { source: s, sourceFile: "/x.json" } : { source: s },
      );
      expect(r.config.source).toBe(s);
      expect(r.warnings).toEqual([]);
    }
  });

  it.each([
    ["budi", "P0-4"],
    ["tokentracker", "BUILD_PLAN_v3"],
  ])("tells a user carrying %s what actually happened to it", (name, marker) => {
    // Not "unknown source". A config naming budi is not a typo — it is a config written against a
    // plan that changed underneath it, and naming the change is the difference between editing one
    // key and wondering whether the file is being read at all.
    const r = parseConfig({ source: name });
    expect(r.config.source).toBe("auto");
    expect(r.warnings.join(" ")).toContain("no longer exists");
    expect(r.warnings.join(" ")).toContain(marker);
  });

  it("still says plain 'unknown' for something that was never a source", () => {
    const r = parseConfig({ source: "postgres" });
    expect(r.warnings.join(" ")).toContain("unknown source");
    expect(r.warnings.join(" ")).not.toContain("no longer exists");
  });

  it("reads sourceFile, trimming it", () => {
    expect(parseConfig({ sourceFile: "  /Users/alice/usage.json " }).config.sourceFile).toBe(
      "/Users/alice/usage.json",
    );
  });

  it("defaults sourceFile to null, which is what makes jsonfile not a candidate", () => {
    expect(parseConfig({}).config.sourceFile).toBeNull();
  });

  it("warns on a non-string sourceFile rather than coercing it", () => {
    const r = parseConfig({ sourceFile: 42 });
    expect(r.config.sourceFile).toBeNull();
    expect(r.warnings.join(" ")).toContain("sourceFile must be");
  });

  it("accepts a sourceFile alongside source: ccusage without complaint", () => {
    // A path that is set but unused is not an error — it is a path that becomes live if they switch
    // one key. Refusing it would make changing `source` a two-key edit.
    const r = parseConfig({ source: "ccusage", sourceFile: "/x.json" });
    expect(r.warnings).toEqual([]);
  });

  it("catches the one combination that cannot work, at parse time", () => {
    const r = parseConfig({ source: "jsonfile" });
    expect(r.warnings.join(" ")).toContain("sourceFile is not set");
  });
});
