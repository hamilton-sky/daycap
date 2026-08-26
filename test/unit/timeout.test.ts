import { describe, expect, it } from "vitest";
import { withTimeout } from "../../src/adapters/source/timeout.ts";
import { SourceTimeoutError } from "../../src/domain/errors.ts";
import type { UsageSourcePort } from "../../src/domain/ports.ts";
import type { ToolSpend } from "../../src/domain/types.ts";

const WINDOW = { from: "2026-08-20T00:00:00.000Z", to: "2026-08-21T00:00:00.000Z", tz: "UTC" };

/** A source that never settles any call — the shape `withTimeout` exists to contain. */
function hangingSource(id = "hang"): UsageSourcePort {
  return {
    id,
    granularity: "instant",
    available: () => new Promise<boolean>(() => {}),
    spendFor: () => new Promise<ToolSpend[]>(() => {}),
    freshness: () => new Promise<{ lastUpdatedUtc: string | null }>(() => {}),
  };
}

function fastSource(id = "fast"): UsageSourcePort {
  return {
    id,
    granularity: "day",
    available: () => Promise.resolve(true),
    spendFor: () => Promise.resolve([{ tool: "claude-code", usd: 1.5, imputed: true }]),
    freshness: () => Promise.resolve({ lastUpdatedUtc: "2026-08-20T00:00:00.000Z" }),
  };
}

describe("withTimeout", () => {
  it("rejects a non-positive or non-finite budget rather than silently never firing", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withTimeout(fastSource(), bad)).toThrow(RangeError);
    }
  });

  it("passes identity and granularity through untouched", () => {
    const guarded = withTimeout(fastSource("ccusage"), 100);
    expect(guarded.id).toBe("ccusage");
    expect(guarded.granularity).toBe("day");
  });

  it("does not delay a source that answers in time", async () => {
    const guarded = withTimeout(fastSource(), 1000);
    await expect(guarded.spendFor(WINDOW)).resolves.toEqual([
      { tool: "claude-code", usd: 1.5, imputed: true },
    ]);
    await expect(guarded.available()).resolves.toBe(true);
    await expect(guarded.freshness()).resolves.toEqual({
      lastUpdatedUtc: "2026-08-20T00:00:00.000Z",
    });
  });

  it("spendFor REJECTS on expiry — it must never resolve [] (DoD #3)", async () => {
    const guarded = withTimeout(hangingSource("budi"), 20);
    const err = await guarded.spendFor(WINDOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceTimeoutError);
    expect((err as SourceTimeoutError).sourceId).toBe("budi");
    expect((err as SourceTimeoutError).afterMs).toBe(20);
  });

  it("available() degrades to false on expiry rather than throwing (C2)", async () => {
    const guarded = withTimeout(hangingSource(), 20);
    await expect(guarded.available()).resolves.toBe(false);
  });

  it("freshness() degrades to null on expiry rather than throwing (C10)", async () => {
    const guarded = withTimeout(hangingSource(), 20);
    await expect(guarded.freshness()).resolves.toEqual({ lastUpdatedUtc: null });
  });

  it("invokes the cleanup hook so a spawning adapter can kill its child (C11b)", async () => {
    let killed = false;
    const guarded = withTimeout(hangingSource(), 20, {
      onTimeout: () => {
        killed = true;
      },
    });
    await expect(guarded.spendFor(WINDOW)).rejects.toBeInstanceOf(SourceTimeoutError);
    expect(killed).toBe(true);
  });

  it("a cleanup hook that itself throws does not mask the timeout", async () => {
    const guarded = withTimeout(hangingSource(), 20, {
      onTimeout: () => {
        throw new Error("kill failed");
      },
    });
    // The caller is waiting to hear "timed out", not "kill failed".
    await expect(guarded.spendFor(WINDOW)).rejects.toBeInstanceOf(SourceTimeoutError);
  });
});
