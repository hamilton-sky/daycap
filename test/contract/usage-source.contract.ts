/**
 * The UsageSourcePort contract. Every adapter runs this identical suite — see README.md.
 *
 * Deviations from IMPLEMENTATION_PLAN.md §2 P1-3, each because the case as written did not test
 * what it claimed:
 *
 *  C6  — the plan required tool ids to "normalise to the canonical kebab set". A canonical set is
 *        a per-tool branch, which P1-1's acceptance criteria forbid anywhere in src/. Split into
 *        syntactic normalisation (asserted here) plus per-adapter alias maps (asserted by that
 *        adapter's own unit tests). The rule survives; the contradiction does not.
 *  C8  — "empty window returns [], wider window returns rows" passes for an adapter that ignores
 *        the window and always answers "today", whenever the corpus is today's. Now three
 *        closed-past windows plus a discriminating inequality.
 *  C9  — "drift < 1e-9" on a SUM cannot distinguish passthrough from a price table that happens
 *        to agree. Split into C9a (bit-exact), C9b (the inconsistency trap) and C9c (unpriceable).
 *  C11 — untestable against an adapter with no timeout parameter. Timeouts now live in
 *        `withTimeout`, so this asserts the decorated source. C11b additionally asserts the child
 *        is killed, because abandoning a hung collector is ccusage #455 reproduced in our tool.
 *  C13 — the socket half is a process-global property; running it once per adapter is slow and
 *        wrong. It moves to test/gates/network.test.ts (P1-9). The canary half stays here.
 *  C14 — you cannot observe the absence of a clock read. Replaced with two positive mechanisms
 *        (two clocks, TZ perturbation) plus a static gate in P1-9.
 */

import { describe, expect, it } from "vitest";
import { withTimeout } from "../../src/adapters/source/timeout.ts";
import { SourceIncompatibleError, SourceTimeoutError } from "../../src/domain/errors.ts";
import type { ToolSpend } from "../../src/domain/types.ts";
import {
  type CaseId,
  fixedClock,
  narrowWindowFor,
  type SourceHarness,
  toCents,
  type WindowName,
} from "./harness.ts";

const T0 = Date.parse("2026-08-25T12:00:00.000Z");

/** Comparable, order-independent shape: tool + integer cents + imputed. */
function normalize(
  rows: readonly ToolSpend[],
): Array<{ tool: string; cents: number | null; imputed: boolean }> {
  return rows
    .map((r) => ({ tool: r.tool, cents: toCents(r.usd), imputed: r.imputed }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

function sum(rows: readonly ToolSpend[]): number {
  return rows.reduce((acc, r) => acc + (toCents(r.usd) ?? 0), 0);
}

export function runUsageSourceContract(h: SourceHarness): void {
  const corpus = h.corpus;
  const narrowName: WindowName = narrowWindowFor(h.granularity);

  /** `it`, unless this harness declared a written reason it cannot run the case. */
  const caseIt = (id: CaseId, title: string, fn: () => Promise<void> | void): void => {
    const reason = h.skips?.[id];
    if (reason !== undefined) {
      it.skip(`${id} — ${title} [skipped: ${reason}]`, () => {});
      return;
    }
    it(`${id} — ${title}`, fn);
  };

  const open = async (
    scenario: Parameters<SourceHarness["start"]>[0] = "present",
    timeoutMs = 5000,
  ) => h.start(scenario, { timeoutMs, clock: fixedClock(T0) });

  describe(`UsageSourcePort contract — ${h.id}`, () => {
    caseIt("C1", "id is stable, non-empty, and identical across constructions", async () => {
      const a = await open();
      const b = await open();
      expect(a.source.id).toBeTruthy();
      expect(a.source.id).toBe(b.source.id);
      expect(a.source.granularity).toBe(b.source.granularity);
      await a.stop();
      await b.stop();
    });

    caseIt(
      "C2",
      "available() resolves false when the collector is absent, never throws",
      async () => {
        const s = await open("absent");
        await expect(s.source.available()).resolves.toBe(false);
        await s.stop();
      },
    );

    caseIt("C3", "available() resolves true when the collector is present", async () => {
      const s = await open();
      await expect(s.source.available()).resolves.toBe(true);
      await s.stop();
    });

    caseIt("C4", "an empty window resolves [] — not null, not a throw", async () => {
      const s = await open();
      await expect(s.source.spendFor(corpus.windows.empty)).resolves.toEqual([]);
      await s.stop();
    });

    caseIt("C5", "every row is structurally valid", async () => {
      const s = await open();
      for (const row of await s.source.spendFor(corpus.windows.full)) {
        expect(typeof row.tool).toBe("string");
        expect(row.tool.length).toBeGreaterThan(0);
        expect(typeof row.imputed).toBe("boolean");
        if (row.usd !== null) {
          expect(Number.isFinite(row.usd)).toBe(true);
          expect(row.usd).toBeGreaterThanOrEqual(0);
        }
      }
      await s.stop();
    });

    caseIt(
      "C6",
      "tool ids are syntactically normal, and an unknown id passes through verbatim",
      async () => {
        const s = await open();
        const rows = await s.source.spendFor(corpus.windows.full);
        for (const row of rows) {
          expect(row.tool, "no surrounding whitespace").toBe(row.tool.trim());
          expect(row.tool, "lower-case").toBe(row.tool.toLowerCase());
          expect(row.tool, "no internal whitespace or underscores").not.toMatch(/[\s_]/);
        }
        // The point of the case: no allowlist anywhere, so an id nobody has heard of survives.
        expect(rows.map((r) => r.tool)).toContain(corpus.probes.unknownToolId);
        await s.stop();
      },
    );

    caseIt("C7", "idempotent across two calls for a closed past window", async () => {
      const s = await open();
      const a = await s.source.spendFor(corpus.windows.full);
      const b = await s.source.spendFor(corpus.windows.full);
      expect(normalize(a)).toEqual(normalize(b));
      await s.stop();
    });

    caseIt("C8", "the window is honoured — three closed-past windows discriminate", async () => {
      const s = await open();
      const empty = await s.source.spendFor(corpus.windows.empty);
      const narrow = await s.source.spendFor(corpus.windows[narrowName]);
      const full = await s.source.spendFor(corpus.windows.full);

      expect(normalize(empty)).toEqual([]);
      expect(normalize(narrow)).toEqual(corpus.expected[narrowName]);
      expect(normalize(full)).toEqual(corpus.expected.full);

      // The discriminator. An adapter that ignores the window and always answers the same thing
      // cannot satisfy a strict inequality between two different non-empty windows.
      expect(sum(narrow)).toBeGreaterThan(0);
      expect(sum(narrow)).toBeLessThan(sum(full));
      await s.stop();
    });

    caseIt("C9a", "a single row's price passes through bit-exact", async () => {
      const s = await open();
      const rows = await s.source.spendFor(corpus.onlyInconsistentRow);
      const row = rows.find((r) => r.tool === corpus.probes.inconsistentTool);
      expect(row, "the probe row must be in this window").toBeDefined();
      // Object.is, not toBeCloseTo: no summation happens here, so there is nothing to round.
      expect(Object.is(row?.usd, corpus.probes.inconsistentExactUsd)).toBe(true);
      await s.stop();
    });

    caseIt("C9b", "no re-pricing — the inconsistency trap", async () => {
      const s = await open();
      const rows = await s.source.spendFor(corpus.onlyInconsistentRow);
      const row = rows.find((r) => r.tool === corpus.probes.inconsistentTool);
      // This row carries $1.23 against 5,000,000 tokens. No price table produces that. If the
      // adapter derived USD from tokens it CANNOT land on 1.23, whatever table it used.
      expect(row?.usd, "adapter appears to be pricing tokens itself — ADR-v2-001 forbids it").toBe(
        corpus.probes.inconsistentExactUsd,
      );
      await s.stop();
    });

    caseIt("C9c", "activity the collector could not price surfaces as null, never 0", async () => {
      const s = await open();
      const rows = await s.source.spendFor(corpus.windows.full);
      const row = rows.find((r) => r.tool === corpus.probes.pricelessTool);
      expect(row, "an unpriceable tool must still be reported, not dropped").toBeDefined();
      expect(row?.usd, "unknown must never become $0.00 (DoD #3)").toBeNull();
      await s.stop();
    });

    caseIt("C10", "freshness() resolves, and reports null rather than throwing", async () => {
      const s = await open();
      const f = await s.source.freshness();
      expect(f).toHaveProperty("lastUpdatedUtc");
      if (f.lastUpdatedUtc !== null) expect(Number.isNaN(Date.parse(f.lastUpdatedUtc))).toBe(false);
      const absent = await open("absent");
      await expect(absent.source.freshness()).resolves.toEqual({ lastUpdatedUtc: null });
      await s.stop();
      await absent.stop();
    });

    caseIt(
      "C11a",
      "a hanging collector rejects with SourceTimeoutError inside the budget",
      async () => {
        const started = await open("hanging", 50);
        const guarded = withTimeout(started.source, 50);
        const began = Date.now();
        await expect(guarded.spendFor(corpus.windows.full)).rejects.toBeInstanceOf(
          SourceTimeoutError,
        );
        const elapsed = Date.now() - began;
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(2000);
        await started.stop();
      },
    );

    caseIt("C11b", "the hung child process is killed, not abandoned", async () => {
      const started = await open("hanging", 50);
      const pid = started.pid;
      expect(pid, "a spawning harness must report its pid").toBeDefined();
      let killed = false;
      const guarded = withTimeout(started.source, 50, {
        onTimeout: () => {
          killed = true;
        },
      });
      await expect(guarded.spendFor(corpus.windows.full)).rejects.toBeInstanceOf(
        SourceTimeoutError,
      );
      expect(killed, "withTimeout must invoke the child-kill hook").toBe(true);
      // The process must actually be gone: signal 0 probes liveness without sending a signal.
      expect(() => process.kill(pid as number, 0)).toThrow();
      await started.stop();
    });

    caseIt(
      "C12",
      "an unknown payload shape is available()=false or a typed error, never a TypeError",
      async () => {
        const s = await open("garbage");
        let thrown: unknown;
        try {
          await s.source.spendFor(corpus.windows.full);
        } catch (e) {
          thrown = e;
        }
        if (thrown === undefined) {
          await expect(s.source.available()).resolves.toBe(false);
        } else {
          expect(thrown).toBeInstanceOf(SourceIncompatibleError);
          expect(thrown).not.toBeInstanceOf(TypeError);
        }
        await s.stop();
      },
    );

    caseIt("C13", "no canary from the fixture corpus appears on any returned object", async () => {
      const s = await open();
      const rows = await s.source.spendFor(corpus.windows.full);
      const serialized = JSON.stringify(rows);
      for (const canary of corpus.canaries) {
        expect(serialized, `leaked ${canary}`).not.toContain(canary);
      }
      await s.stop();
    });

    caseIt("C14a", "results depend on the window, not on the clock", async () => {
      const early = await h.start("present", { timeoutMs: 5000, clock: fixedClock(T0) });
      const late = await h.start("present", {
        timeoutMs: 5000,
        clock: fixedClock(T0 + 400 * 86_400_000),
      });
      const a = await early.source.spendFor(corpus.windows.full);
      const b = await late.source.spendFor(corpus.windows.full);
      // 400 days apart. An adapter that runs `daily` with no date args and filters to "today"
      // returns different rows here; one honouring the window returns identical ones.
      expect(normalize(a)).toEqual(normalize(b));
      await early.stop();
      await late.stop();
    });

    caseIt("C14b", "results do not depend on the ambient timezone", async () => {
      const utc = await h.start("present", {
        timeoutMs: 5000,
        clock: fixedClock(T0),
        childTz: "UTC",
      });
      const plus14 = await h.start("present", {
        timeoutMs: 5000,
        clock: fixedClock(T0),
        childTz: "Pacific/Kiritimati",
      });
      const minus11 = await h.start("present", {
        timeoutMs: 5000,
        clock: fixedClock(T0),
        childTz: "Pacific/Niue",
      });
      const a = normalize(await utc.source.spendFor(corpus.windows.full));
      expect(normalize(await plus14.source.spendFor(corpus.windows.full))).toEqual(a);
      expect(normalize(await minus11.source.spendFor(corpus.windows.full))).toEqual(a);
      await utc.stop();
      await plus14.stop();
      await minus11.stop();
    });
  });
}
