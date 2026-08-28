/**
 * `daycap config` — the read-only view.
 *
 * What it exists for is not "show my config" (that is `cat`) but **which values are in force and
 * where they came from**, which `cat` cannot answer: the file shows what you typed, not what
 * survived parsing. A misspelled key is invisible in the file and obvious here.
 */

import { describe, expect, it } from "vitest";
import { type ConfigFacts, renderConfig } from "../../src/adapters/render/config-view.ts";
import { WIDTH } from "../../src/adapters/render/doctor.ts";
import { DEFAULT_CONFIG, parseConfig } from "../../src/domain/config.ts";

const HOME = "/Users/alice";

const facts = (over: Partial<ConfigFacts> = {}): ConfigFacts => ({
  home: HOME,
  path: `${HOME}/.daycap/config.json`,
  fileExists: true,
  config: DEFAULT_CONFIG,
  explicitKeys: [],
  warnings: [],
  ...over,
});

const out = (f: ConfigFacts) => renderConfig(f).join("\n");

/** Render exactly what `parseConfig` would produce for a given raw file. */
function forFile(raw: Record<string, unknown>, fileExists = true): string {
  const { config, warnings } = parseConfig(raw);
  return out(facts({ config, warnings, explicitKeys: Object.keys(raw), fileExists }));
}

describe("config view — shape", () => {
  it("never exceeds 80 columns, even with absurd values", () => {
    const text = renderConfig(
      facts({
        config: { ...DEFAULT_CONFIG, tools: Array.from({ length: 40 }, (_, i) => `tool-${i}`) },
        warnings: ["y".repeat(300)],
        explicitKeys: ["tools"],
      }),
    );
    for (const line of text) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });

  it("emits no ANSI escapes — this output gets pasted into issues", () => {
    expect(out(facts())).not.toContain(String.fromCharCode(27));
  });

  it("abbreviates the home directory, because this gets pasted into issues", () => {
    expect(out(facts())).not.toContain("/Users/alice");
    expect(out(facts())).toContain("~/.daycap/config.json");
  });
});

describe("config view — set versus default is the whole point", () => {
  it("marks a value the file set", () => {
    const text = forFile({ dailyBudgetUsd: 200 });
    expect(text).toMatch(/•\s+dailyBudgetUsd\s+\$200\.00/);
  });

  it("leaves a default unmarked", () => {
    const text = forFile({ dailyBudgetUsd: 200 });
    expect(text).toMatch(/\s{2}\s+resetHourLocal/);
    expect(text).not.toMatch(/•\s+resetHourLocal/);
  });

  it("distinguishes SET-BUT-REJECTED from set, because the value shown is not theirs", () => {
    // `thresholds: "eighty percent"` is set by the user AND ignored. A `•` would claim the 80%/100%
    // on screen is what they asked for. `!` says "you set this and it did not take", which is a
    // third state and the one most likely to waste an afternoon.
    const text = forFile({ thresholds: "eighty percent" });
    expect(text).toMatch(/!\s+thresholds/);
    expect(text).not.toMatch(/•\s+thresholds/);
  });
});

describe("config view — the silent failures it exists to surface", () => {
  it("names a key nothing reads, which is otherwise invisible forever", () => {
    // parseConfig deliberately ignores unknown keys, so a config for a future version does not stop
    // the tool starting. The cost is that a typo and a future key look identical, and the typo is
    // silent: `"dailyBudgetUSD": 999` parses, validates, and does nothing.
    const text = forFile({ dailyBudgetUsd: 200, dailyBudgetUSD: 999, notifcations: {} });
    expect(text).toContain("does not read");
    expect(text).toContain("dailyBudgetUSD");
    expect(text).toContain("notifcations");
  });

  it("does not flag the honoured back-compat aliases as typos", () => {
    // `clis` and `imputeCostForSubscription` still work, so calling them typos would be a lie that
    // sends someone to fix working config.
    const text = forFile({ clis: ["claude-code"], imputeCostForSubscription: true });
    expect(text).not.toContain("does not read");
  });

  it("says nothing about unknown keys when there are none", () => {
    expect(forFile({ dailyBudgetUsd: 10 })).not.toContain("does not read");
  });

  it("warns that nothing can fire without a budget", () => {
    // The most consequential value: with no budget nothing can be crossed, so no alert and no guard
    // can fire however they are configured. Worth saying on the screen where they configure them.
    expect(forFile({ notifications: { enabled: true } })).toContain(
      "nothing can fire without this",
    );
  });

  it("does NOT list an absent file under 'not understood'", () => {
    // An absent file is understood perfectly. Listing it as a problem tells a first-time user their
    // setup is broken when it is merely empty.
    const text = out(facts({ fileExists: false, warnings: ["no config file; using defaults"] }));
    expect(text).toContain("absent");
    expect(text).not.toContain("Not understood");
  });
});

describe("config view — the two-switch guard, said out loud", () => {
  it("reminds you the config switch is not enough", () => {
    // `guard.enabled` alone does nothing without `install --guard`. This is the "I turned it on and
    // nothing happened" hour, prevented by one clause.
    expect(forFile({ guard: { enabled: false } })).toContain("also needs `install --guard`");
  });

  it("shows the deny point when the guard is on", () => {
    const text = forFile({ dailyBudgetUsd: 200, guard: { enabled: true, denyAt: 1 } });
    expect(text).toContain("blocks tool calls");
    expect(text).toContain("100% of budget");
  });
});

describe("config view — step notifications", () => {
  it("shows how many alerts a full budget implies, so $15 is a considered choice", () => {
    // 13 banners is a fact the user should meet while configuring, not at 3pm on a busy day.
    const text = forFile({ dailyBudgetUsd: 200, notifyEveryUsd: 15 });
    expect(text).toContain("every $15.00");
    expect(text).toContain("13 alerts per full budget");
  });

  it("says off when unset", () => {
    expect(forFile({ dailyBudgetUsd: 200 })).toMatch(/notifyEveryUsd\s+off/);
  });
});
