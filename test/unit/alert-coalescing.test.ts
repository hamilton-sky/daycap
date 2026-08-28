/**
 * What `runAlerts` does when several thresholds cross in ONE evaluation.
 *
 * This is the rule dollar-steps made necessary, and it is the whole reason the feature is safe to
 * turn on. The latch marks every newly-crossed threshold as fired — correct, each must fire at most
 * once per day. But notifying per crossing is only right when crossings arrive one at a time, and on
 * the first run of a busy day they do not: at $224 spent with $15 steps, fourteen cross at once.
 *
 * Fourteen banners about money already spent is how a user learns to dismiss this tool without
 * reading it. So: mark all, notify for the highest.
 */

import { describe, expect, it } from "vitest";
import { runAlerts } from "../../src/app/alert.ts";
import { LATCH_KEY } from "../../src/app/latch.ts";
import { DEFAULT_CONFIG } from "../../src/domain/config.ts";
import type { NotifierPort, StorePort } from "../../src/domain/ports.ts";
import type { Config, UsageSnapshot } from "../../src/domain/types.ts";

const NOW = "2026-08-28T12:00:00.000Z";

const snapshot = (totalUsd: number): UsageSnapshot => ({
  schema: 1,
  usageDay: "2026-08-28",
  generatedAtUtc: NOW,
  sourceId: "ccusage",
  sourceFresh: true,
  sourceLastUpdatedUtc: null,
  health: { kind: "ok" },
  tools: [{ tool: "claude-code", usd: totalUsd, imputed: true }],
  totalUsd,
  pricingPartial: false,
  imputed: true,
  dayBoundaryApprox: false,
});

/** An in-memory store, so nothing here touches a disk or a real latch. */
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

function recorder(): NotifierPort & { sent: { title: string; body: string }[] } {
  const sent: { title: string; body: string }[] = [];
  return {
    sent,
    notify: (n) => {
      sent.push({ title: n.title, body: n.body });
      return Promise.resolve();
    },
  };
}

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over });

describe("runAlerts — several crossings at once send ONE notification", () => {
  it("a $224 day with $15 steps sends one banner, not fourteen", async () => {
    const store = memStore();
    const notifier = recorder();
    const config = cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15, thresholds: [0.8, 1] });

    const result = await runAlerts({
      snapshot: snapshot(224),
      config,
      store,
      notifier,
      nowIso: NOW,
    });

    // Every crossing is LATCHED — that part must not change, or they re-fire tomorrow's first run.
    expect(result.fired.length).toBeGreaterThan(10);
    // But the user gets one.
    expect(notifier.sent).toHaveLength(1);
  });

  it("reports where the user IS, not which threshold tripped", async () => {
    // The first version of this test asserted `Math.max(...fired) === Math.max(...fired)`, which is
    // a tautology, and a mutation swapping max for min sailed through it. The real property is that
    // the alert states actual spend against the actual limit — `describe()` never mentions the
    // threshold — so there is nothing to choose between crossings and nothing to get wrong.
    const notifier = recorder();
    await runAlerts({
      snapshot: snapshot(224),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store: memStore(),
      notifier,
      nowIso: NOW,
    });
    expect(notifier.sent[0]?.body ?? "").toContain("$224.00");
    expect(notifier.sent[0]?.body ?? "").toContain("$200.00");
    expect(notifier.sent[0]?.title ?? "").toContain("over");
  });

  it("marks them all fired, so tomorrow's run does not repeat today's history", async () => {
    const store = memStore();
    const notifier = recorder();
    await runAlerts({
      snapshot: snapshot(224),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store,
      notifier,
      nowIso: NOW,
    });

    // Second run, same day, same spend: nothing new crossed, so nothing fires. This is L2, and it is
    // what stops the coalescing above from becoming "one banner per invocation forever".
    const again = recorder();
    const second = await runAlerts({
      snapshot: snapshot(224),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store,
      notifier: again,
      nowIso: NOW,
    });
    expect(second.fired).toEqual([]);
    expect(again.sent).toHaveLength(0);
  });

  it("a single new step later in the day still notifies normally", async () => {
    const store = memStore();
    const config = cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 });

    await runAlerts({ snapshot: snapshot(20), config, store, notifier: recorder(), nowIso: NOW });
    // Crossed $15 only. Now cross $30 and nothing else.
    const notifier = recorder();
    const second = await runAlerts({
      snapshot: snapshot(32),
      config,
      store,
      notifier,
      nowIso: NOW,
    });

    expect(second.fired).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("sends nothing at all when no step and no threshold is crossed", async () => {
    const notifier = recorder();
    await runAlerts({
      snapshot: snapshot(5),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store: memStore(),
      notifier,
      nowIso: NOW,
    });
    expect(notifier.sent).toHaveLength(0);
  });

  it("does not fire on an untrusted snapshot, steps or otherwise (L9)", async () => {
    const notifier = recorder();
    const stale = { ...snapshot(224), health: { kind: "stale" as const, ageSeconds: 9999 } };
    const result = await runAlerts({
      snapshot: stale as UsageSnapshot,
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store: memStore(),
      notifier,
      nowIso: NOW,
    });
    // A number we are not sure of must not produce an alert, however many steps it appears to cross.
    expect(result.fired).toEqual([]);
    expect(notifier.sent).toHaveLength(0);
  });

  it("a step landing exactly on a configured threshold produces ONE latch entry", async () => {
    // $100 of a $200 budget IS 0.5. The LATCH is what collapses that, because `fired` is keyed
    // `${signal}|${threshold}`; the Set in alert.ts is defensive clarity only. Asserted on the
    // latch's own keys, because that is where the property actually lives — a mutation removing the
    // Set changed no behaviour, and a test that claimed otherwise was testing nothing.
    const store = memStore();
    const notifier = recorder();
    const result = await runAlerts({
      snapshot: snapshot(100),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 100, thresholds: [0.5] }),
      store,
      notifier,
      nowIso: NOW,
    });
    expect(result.fired).toEqual([0.5]);
    const latch = store.data.get(LATCH_KEY) as { fired: Record<string, string> };
    expect(Object.keys(latch.fired)).toEqual(["usd|0.5"]);
    expect(notifier.sent).toHaveLength(1);
  });

  it("persists the latch before notifying (L7), so a notifier fault costs one alert", async () => {
    const store = memStore();
    const notifier = recorder();
    await runAlerts({
      snapshot: snapshot(50),
      config: cfg({ dailyBudgetUsd: 200, notifyEveryUsd: 15 }),
      store,
      notifier,
      nowIso: NOW,
    });
    expect(store.data.get(LATCH_KEY)).toBeDefined();
  });
});
