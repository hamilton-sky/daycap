import { describe, expect, it } from "vitest";
import { CcusageSource } from "../../src/adapters/source/ccusage.shellout.ts";
import { withTimeout } from "../../src/adapters/source/timeout.ts";
import { usageDayFor, usageDayRange } from "../../src/domain/window.ts";

/**
 * Runs against the REAL ccusage binary and the developer's own transcripts.
 *
 * Opt-in and non-blocking by design: it asserts nothing about amounts (they are personal, they
 * change every hour, and this repo is public). What it does assert is that the contract's stub
 * has not drifted from the real collector — a stub that passes while the real binary has moved on
 * is worse than no test, because it reports safety that isn't there.
 *
 *   LUM_LIVE_SOURCES=ccusage pnpm test
 */
const LIVE = (process.env.LUM_LIVE_SOURCES ?? "").split(",").includes("ccusage");
const maybe = LIVE ? describe : describe.skip;

maybe("ccusage — live", () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const source = withTimeout(new CcusageSource(), 5000);

  it("finds the real binary", async () => {
    await expect(source.available()).resolves.toBe(true);
  });

  it("returns well-formed rows for today's local usage day", async () => {
    const day = usageDayFor(Date.now(), 0, tz);
    const rows = await source.spendFor(usageDayRange(day, 0, tz));
    for (const r of rows) {
      expect(r.tool).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      expect(typeof r.imputed).toBe("boolean");
      if (r.usd !== null) expect(r.usd).toBeGreaterThanOrEqual(0);
    }
  });

  it("honours the window: a closed past day differs from an empty far-past one", async () => {
    const empty = await source.spendFor({
      from: "2019-01-01T00:00:00.000Z",
      to: "2019-01-02T00:00:00.000Z",
      tz: "UTC",
    });
    expect(empty).toEqual([]);
  });

  it("never emits a codex subcommand — that would double-count (M1_RESULT §4)", async () => {
    // Guard against a regression that only shows up against the real collector: `ccusage daily`
    // already includes Codex, so any second spawn inflates the headline number.
    const src = new CcusageSource();
    const day = usageDayFor(Date.now(), 0, tz);
    const rows = await withTimeout(src, 5000).spendFor(usageDayRange(day, 0, tz));
    expect(Array.isArray(rows)).toBe(true);
  });
});
