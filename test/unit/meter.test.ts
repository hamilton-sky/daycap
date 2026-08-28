import { describe, expect, it } from "vitest";
import { buildSnapshot, SNAPSHOT_KEY, snapshotAgeSeconds } from "../../src/app/meter.ts";
import { SourceIncompatibleError, SourceTimeoutError } from "../../src/domain/errors.ts";
import type { ClockPort, StorePort, UsageSourcePort } from "../../src/domain/ports.ts";
import type { Config, ToolSpend } from "../../src/domain/types.ts";

const NOW = Date.parse("2026-08-26T09:00:00.000Z");

const config = (over: Partial<Config> = {}): Config => ({
  dailyBudgetUsd: 10,
  resetHourLocal: 0,
  thresholds: [0.8, 1],
  notifyEveryUsd: null,
  source: "auto",
  sourceFile: null,
  tools: ["*"],
  primarySignal: "auto",
  pacing: false,
  notifications: { enabled: false },
  guard: { enabled: false, denyAt: 1, mode: "deny", allowTools: [] },
  timezone: "UTC",
  ...over,
});

const clock: ClockPort = { nowMs: () => NOW, timezone: () => "UTC" };

function source(over: Partial<UsageSourcePort> = {}): UsageSourcePort {
  return {
    id: "fake",
    granularity: "instant",
    available: () => Promise.resolve(true),
    spendFor: () => Promise.resolve<ToolSpend[]>([]),
    freshness: () => Promise.resolve({ lastUpdatedUtc: null }),
    ...over,
  };
}

function memStore(): StorePort & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    read: <T>(k: string) => Promise.resolve((data.get(k) ?? null) as T | null),
    write: <T>(k: string, v: T) => {
      data.set(k, v);
      return Promise.resolve();
    },
  };
}

describe("buildSnapshot — totals", () => {
  it("per-tool figures sum EXACTLY to the total (P1-7 acceptance)", async () => {
    // Values chosen to drift if summed as floats: 0.1 + 0.2 !== 0.3 in IEEE-754.
    const rows: ToolSpend[] = [
      { tool: "claude-code", usd: 0.1, imputed: true },
      { tool: "codex", usd: 0.2, imputed: false },
    ];
    const snap = await buildSnapshot({
      source: source({ spendFor: () => Promise.resolve(rows) }),
      clock,
      config: config(),
    });
    expect(snap.totalUsd).toBe(0.3);
    const summed = snap.tools.reduce((a, t) => a + Math.round((t.usd ?? 0) * 100), 0) / 100;
    expect(snap.totalUsd).toBe(summed);
  });

  it("marks a partial answer partial rather than silently completing it", async () => {
    const snap = await buildSnapshot({
      source: source({
        spendFor: () =>
          Promise.resolve<ToolSpend[]>([
            { tool: "claude-code", usd: 4, imputed: true },
            { tool: "priceless", usd: null, imputed: false },
          ]),
      }),
      clock,
      config: config(),
    });
    expect(snap.pricingPartial).toBe(true);
    // The total covers what could be priced; the unpriceable row is NOT counted as zero.
    expect(snap.totalUsd).toBe(4);
    expect(snap.tools.find((t) => t.tool === "priceless")?.usd).toBeNull();
  });

  it("reports null, not 0, when nothing at all could be priced", async () => {
    const snap = await buildSnapshot({
      source: source({
        spendFor: () => Promise.resolve<ToolSpend[]>([{ tool: "x", usd: null, imputed: false }]),
      }),
      clock,
      config: config(),
    });
    expect(snap.totalUsd).toBeNull();
  });

  it("an empty but successful answer is 0, which is a real fact", async () => {
    const snap = await buildSnapshot({ source: source(), clock, config: config() });
    expect(snap.health).toEqual({ kind: "ok" });
    expect(snap.totalUsd).toBeNull();
    expect(snap.tools).toEqual([]);
  });
});

describe("buildSnapshot — degradation", () => {
  it("no collector => no-source, and never a 0 total", async () => {
    const snap = await buildSnapshot({
      source: source({ available: () => Promise.resolve(false) }),
      clock,
      config: config(),
    });
    expect(snap.health).toEqual({ kind: "no-source", lookedFor: ["fake"] });
    expect(snap.totalUsd).toBeNull();
  });

  it("a timeout is typed and carries its budget", async () => {
    const snap = await buildSnapshot({
      source: source({ spendFor: () => Promise.reject(new SourceTimeoutError("fake", 3000)) }),
      clock,
      config: config(),
    });
    expect(snap.health).toEqual({ kind: "timeout", afterMs: 3000 });
    expect(snap.totalUsd).toBeNull();
  });

  it("schema drift surfaces as incompatible", async () => {
    const snap = await buildSnapshot({
      source: source({
        spendFor: () => Promise.reject(new SourceIncompatibleError("fake", "no daily[]")),
      }),
      clock,
      config: config(),
    });
    expect(snap.health.kind).toBe("incompatible");
  });

  it("an adapter that throws something unexpected still yields a renderable snapshot", async () => {
    const snap = await buildSnapshot({
      source: source({ spendFor: () => Promise.reject(new RangeError("boom")) }),
      clock,
      config: config(),
    });
    expect(snap.health.kind).toBe("incompatible");
    expect(snap.usageDay).toBe("2026-08-26");
  });

  it("a freshness() that misbehaves does not lose the spend figures", async () => {
    const snap = await buildSnapshot({
      source: source({
        spendFor: () => Promise.resolve<ToolSpend[]>([{ tool: "a", usd: 1, imputed: false }]),
        freshness: () => Promise.reject(new Error("nope")),
      }),
      clock,
      config: config(),
    });
    expect(snap.totalUsd).toBe(1);
  });
});

describe("buildSnapshot — window and policy", () => {
  it("uses the config timezone over the host clock", async () => {
    let seen = "";
    await buildSnapshot({
      source: source({
        spendFor: (w) => {
          seen = w.tz;
          return Promise.resolve([]);
        },
      }),
      clock,
      config: config({ timezone: "Asia/Jerusalem" }),
    });
    expect(seen).toBe("Asia/Jerusalem");
  });

  it("falls back to the clock's zone when config names none", async () => {
    let seen = "";
    await buildSnapshot({
      source: source({
        spendFor: (w) => {
          seen = w.tz;
          return Promise.resolve([]);
        },
      }),
      clock: { nowMs: () => NOW, timezone: () => "America/New_York" },
      config: config({ timezone: null }),
    });
    expect(seen).toBe("America/New_York");
  });

  it("marks the day approximate only when a day-granularity source meets a non-zero reset hour", async () => {
    const cases: Array<[UsageSourcePort["granularity"], number, boolean]> = [
      ["day", 4, true],
      ["day", 0, false],
      ["instant", 4, false],
      ["instant", 0, false],
    ];
    for (const [granularity, resetHourLocal, expected] of cases) {
      const snap = await buildSnapshot({
        source: source({ granularity }),
        clock,
        config: config({ resetHourLocal }),
      });
      expect(snap.dayBoundaryApprox, `${granularity}/${resetHourLocal}`).toBe(expected);
    }
  });

  it('honours an explicit tools allowlist, and "*" means everything', async () => {
    const rows: ToolSpend[] = [
      { tool: "claude-code", usd: 1, imputed: true },
      { tool: "codex", usd: 2, imputed: false },
    ];
    const all = await buildSnapshot({
      source: source({ spendFor: () => Promise.resolve(rows) }),
      clock,
      config: config({ tools: ["*"] }),
    });
    expect(all.tools).toHaveLength(2);

    const only = await buildSnapshot({
      source: source({ spendFor: () => Promise.resolve(rows) }),
      clock,
      config: config({ tools: ["codex"] }),
    });
    expect(only.tools.map((t) => t.tool)).toEqual(["codex"]);
    expect(only.totalUsd).toBe(2);
  });
});

describe("buildSnapshot — persistence", () => {
  it("writes the snapshot under the shared key", async () => {
    const store = memStore();
    const snap = await buildSnapshot({ source: source(), clock, config: config(), store });
    expect(store.data.get(SNAPSHOT_KEY)).toEqual(snap);
  });

  it("an unwritable store does not stop `lum today` from producing a number", async () => {
    const store: StorePort = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error("EACCES")),
    };
    const snap = await buildSnapshot({
      source: source({
        spendFor: () => Promise.resolve<ToolSpend[]>([{ tool: "a", usd: 5, imputed: false }]),
      }),
      clock,
      config: config(),
      store,
    });
    expect(snap.totalUsd).toBe(5);
  });
});

describe("snapshotAgeSeconds", () => {
  it("measures from generatedAtUtc and never goes negative", async () => {
    const snap = await buildSnapshot({ source: source(), clock, config: config() });
    expect(snapshotAgeSeconds(snap, NOW + 18 * 60_000)).toBe(18 * 60);
    expect(snapshotAgeSeconds(snap, NOW - 5000)).toBe(0);
  });
});

describe("buildSnapshot — the cache must survive a bad run", () => {
  it("does NOT overwrite a good cached snapshot with a degraded one", async () => {
    const store = memStore();
    // A good run caches a real figure.
    const good = await buildSnapshot({
      source: source({
        spendFor: () => Promise.resolve<ToolSpend[]>([{ tool: "a", usd: 7, imputed: false }]),
      }),
      clock,
      config: config(),
      store,
    });
    expect(store.data.get(SNAPSHOT_KEY)).toEqual(good);

    // The collector then times out. The matrix says to fall back to the cached figure — which is
    // impossible if this run has just written over it.
    await buildSnapshot({
      source: source({ spendFor: () => Promise.reject(new SourceTimeoutError("fake", 3000)) }),
      clock,
      config: config(),
      store,
    });
    expect(store.data.get(SNAPSHOT_KEY)).toEqual(good);
  });

  it.each([["no-source", () => Promise.resolve(false)]])(
    "does not cache a %s result",
    async (_name, available) => {
      const store = memStore();
      await buildSnapshot({ source: source({ available }), clock, config: config(), store });
      expect(store.data.has(SNAPSHOT_KEY)).toBe(false);
    },
  );
});
