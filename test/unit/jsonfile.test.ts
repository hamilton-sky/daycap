/**
 * `jsonfile` adapter unit tests — the parts the shared contract deliberately does not cover.
 *
 * The contract asserts what every adapter must do. This file asserts what THIS adapter decided:
 * its schema's rejections, its normalisation, its freshness preference, and the two policy calls it
 * had to make that the corpus does not exercise (a mixed priced/unpriced group, and what a missing
 * file means). It also pays the debt written into the C14b skip reason — TZ invariance is asserted
 * here rather than left as a gap.
 */

import { afterEach, describe, expect, it } from "vitest";
import { JsonFileSource } from "../../src/adapters/source/jsonfile.ts";
import { SourceIncompatibleError, SourceUnavailableError } from "../../src/domain/errors.ts";
import type { UsageWindow } from "../../src/domain/types.ts";

const WINDOW: UsageWindow = {
  from: "2026-08-20T00:00:00.000Z",
  to: "2026-08-23T00:00:00.000Z",
  tz: "UTC",
};

/** A source over literal text — no filesystem, since none of these cases are about reading. */
const over = (text: string) =>
  new JsonFileSource({ path: "/nonexistent/usage.json", readText: () => Promise.resolve(text) });

const doc = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, entries, ...extra });

const entry = (over_: Record<string, unknown> = {}) => ({
  at: "2026-08-21T09:00:00.000Z",
  tool: "claude-code",
  usd: 1,
  ...over_,
});

describe("jsonfile — schema rejections are typed, never a TypeError", () => {
  const cases: Array<[string, string]> = [
    ["not JSON at all", "}{ not json"],
    ["top level is an array", "[]"],
    ["top level is a string", '"hello"'],
    ["schema version absent", JSON.stringify({ entries: [] })],
    ["schema version is 2", JSON.stringify({ schema: 2, entries: [] })],
    ["entries is a string", doc([]).replace("[]", '"nope"')],
    ["an entry is a string", doc(["nope"])],
    ["at is missing", doc([{ tool: "x", usd: 1 }])],
    ["at is not a date", doc([entry({ at: "last tuesday" })])],
    ["tool is missing", doc([{ at: "2026-08-21T09:00:00.000Z", usd: 1 }])],
    ["tool is whitespace", doc([entry({ tool: "   " })])],
    ["usd is a string", doc([entry({ usd: "1.23" })])],
    ["usd is negative", doc([entry({ usd: -1 })])],
    ["usd is a boolean", doc([entry({ usd: true })])],
    // Hand-written, not built with JSON.stringify, and that is the whole point: stringify emits
    // `null` for Infinity, so `usd: Number.POSITIVE_INFINITY` reaches the parser as a legitimate
    // "could not price" and asserts nothing. `1e999` is how a JSON document actually carries a
    // non-finite number — JSON.parse turns it into Infinity — so this is the only spelling that
    // reaches the Number.isFinite guard. The first draft of this case tested nothing.
    [
      "usd overflows to Infinity via 1e999",
      '{"schema":1,"entries":[{"at":"2026-08-21T09:00:00.000Z","tool":"t","usd":1e999}]}',
    ],
  ];

  it.each(cases)("rejects when %s", async (_name, text) => {
    const source = over(text);
    await expect(source.spendFor(WINDOW)).rejects.toBeInstanceOf(SourceIncompatibleError);
    // The distinction that matters: app/meter.ts maps failures by TYPE. A TypeError escaping from
    // a property access on something that turned out to be a string is unmappable.
    await expect(source.spendFor(WINDOW)).rejects.not.toBeInstanceOf(TypeError);
  });

  it("says WHICH entry was bad, because a 4000-line file needs a line number", async () => {
    const text = doc([entry(), entry({ at: "nope" })]);
    await expect(over(text).spendFor(WINDOW)).rejects.toThrow(/entries\[1\]/);
  });

  it("available() answers false for every one of them rather than throwing", async () => {
    for (const [, text] of cases) await expect(over(text).available()).resolves.toBe(false);
  });

  it("a string that merely looks like a number is a schema error, not a coercion", async () => {
    // Guessing is how "1,234" silently becomes 1. The producer is saying something we do not
    // understand, and the honest answer is to say so.
    await expect(over(doc([entry({ usd: "1,234" })])).spendFor(WINDOW)).rejects.toBeInstanceOf(
      SourceIncompatibleError,
    );
  });
});

describe("jsonfile — a missing file is unavailable, never empty", () => {
  it("throws SourceUnavailableError rather than resolving []", async () => {
    const source = new JsonFileSource({
      path: "/nonexistent/usage.json",
      readText: () => Promise.reject(new Error("ENOENT")),
    });
    // `[]` is indistinguishable from "the producer confirms zero spend" — the $0.00 bug wearing a
    // different hat, and the same reasoning that makes withTimeout reject instead of resolve empty.
    await expect(source.spendFor(WINDOW)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("names the path it looked for, so the error is actionable", async () => {
    const source = new JsonFileSource({
      path: "/tmp/some/where/usage.json",
      readText: () => Promise.reject(new Error("ENOENT")),
    });
    await expect(source.spendFor(WINDOW)).rejects.toThrow(/\/tmp\/some\/where\/usage\.json/);
  });

  it("but available() is still false, not an exception", async () => {
    const source = new JsonFileSource({
      path: "/nonexistent/usage.json",
      readText: () => Promise.reject(new Error("ENOENT")),
    });
    await expect(source.available()).resolves.toBe(false);
  });
});

describe("jsonfile — tool ids normalise syntactically and never by allowlist", () => {
  it("trims, lower-cases, and collapses whitespace and underscores to hyphens", async () => {
    const text = doc([
      entry({ tool: "  Claude_Code  ", usd: 1 }),
      entry({ tool: "SOME TOOL", usd: 2 }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows.map((r) => r.tool).sort()).toEqual(["claude-code", "some-tool"]);
  });

  it("merges ids that normalise to the same thing, rather than reporting both", async () => {
    const text = doc([
      entry({ tool: "Claude Code", usd: 1 }),
      entry({ tool: "claude_code", usd: 2 }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usd).toBe(3);
  });

  it("passes an id nobody has ever heard of through verbatim", async () => {
    // No allowlist, no canonical map — a per-tool branch is forbidden in src/ (P1-1), and this
    // source exists precisely for tools nobody enumerated.
    const rows = await over(doc([entry({ tool: "weird-tool-9000" })])).spendFor(WINDOW);
    expect(rows[0]?.tool).toBe("weird-tool-9000");
  });
});

describe("jsonfile — unpriceable activity, and the mixed case the corpus does not cover", () => {
  it("a tool with only unpriced entries reports null, never 0", async () => {
    const rows = await over(doc([entry({ tool: "t", usd: null })])).spendFor(WINDOW);
    expect(rows[0]?.usd).toBeNull();
  });

  it("treats a missing usd the same as an explicit null", async () => {
    const rows = await over(doc([{ at: "2026-08-21T09:00:00.000Z", tool: "t" }])).spendFor(WINDOW);
    expect(rows[0]?.usd).toBeNull();
  });

  it("a MIXED tool sums what was priced instead of discarding it", async () => {
    // The policy call, stated here because the corpus has no mixed group to pin it. Returning null
    // would throw away money we do know about; returning the sum makes the number a floor, which
    // `pricingPartial` upstream is what says out loud. Neither option is silently wrong — but
    // discarding a known $2 to express doubt about an unknown is the worse of the two.
    const text = doc([entry({ tool: "t", usd: 2 }), entry({ tool: "t", usd: null })]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows[0]?.usd).toBe(2);
  });

  it("a confirmed zero is still allowed to be zero", async () => {
    const rows = await over(doc([entry({ tool: "t", usd: 0 })])).spendFor(WINDOW);
    expect(rows[0]?.usd).toBe(0);
  });
});

describe("jsonfile — no re-pricing, ever", () => {
  it("ignores tokens entirely, even when usd is absurd against them", async () => {
    // The inconsistency trap, unit-level: $1.23 against 5,000,000 tokens matches no price table.
    // An adapter deriving USD from tokens cannot land on 1.23 whatever table it used.
    const text = doc([
      entry({
        tool: "t",
        usd: 1.23,
        tokens: { in: 5_000_000, out: 12_000, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows[0]?.usd).toBe(1.23);
  });

  it("does not invent a price from tokens when usd is null", async () => {
    const text = doc([
      entry({ tool: "t", usd: null, tokens: { in: 9000, out: 1000, cacheRead: 0, cacheWrite: 0 } }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows[0]?.usd).toBeNull();
  });
});

describe("jsonfile — the returned object carries nothing we did not ask for", () => {
  it("drops unknown fields rather than spreading the parsed entry", async () => {
    const text = doc([
      entry({
        tool: "t",
        _canary: "CANARY-must-not-leak",
        prompt: "CANARY-prompt",
        cwd: "/Users/someone/secret-project",
      }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("CANARY");
    expect(serialized).not.toContain("secret-project");
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["imputed", "tool", "usd"]);
  });
});

describe("jsonfile — freshness prefers the producer's claim over the filesystem's", () => {
  it("reports generatedAtUtc, normalised to ISO", async () => {
    const text = doc([entry()], { generatedAtUtc: "2026-08-22T12:00:00Z" });
    await expect(over(text).freshness()).resolves.toEqual({
      lastUpdatedUtc: "2026-08-22T12:00:00.000Z",
    });
  });

  it("reports null when absent, rather than substituting mtime", async () => {
    // A cp, a git checkout or a restore all bump mtime without the data being newer — the wrong
    // direction for a freshness signal to be wrong in. `doctor` says "exposes no freshness
    // watermark of its own", which is true; a fabricated timestamp is not.
    await expect(over(doc([entry()])).freshness()).resolves.toEqual({ lastUpdatedUtc: null });
  });

  it("reports null for an unparseable watermark rather than throwing", async () => {
    const text = doc([entry()], { generatedAtUtc: "whenever" });
    await expect(over(text).freshness()).resolves.toEqual({ lastUpdatedUtc: null });
  });

  it("reports null for an unreadable file rather than throwing", async () => {
    const source = new JsonFileSource({
      path: "/nonexistent",
      readText: () => Promise.reject(new Error("ENOENT")),
    });
    await expect(source.freshness()).resolves.toEqual({ lastUpdatedUtc: null });
  });
});

describe("jsonfile — the half-open window", () => {
  it("includes `from` and excludes `to`", async () => {
    const text = doc([
      entry({ tool: "at-from", at: "2026-08-20T00:00:00.000Z" }),
      entry({ tool: "at-to", at: "2026-08-23T00:00:00.000Z" }),
    ]);
    const rows = await over(text).spendFor(WINDOW);
    expect(rows.map((r) => r.tool)).toEqual(["at-from"]);
  });

  it("resolves [] for a window with nothing in it", async () => {
    const rows = await over(doc([entry()])).spendFor({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      tz: "UTC",
    });
    expect(rows).toEqual([]);
  });

  it("rejects a window that is not ISO-8601 rather than silently matching nothing", async () => {
    await expect(
      over(doc([entry()])).spendFor({ from: "yesterday", to: "today", tz: "UTC" }),
    ).rejects.toBeInstanceOf(SourceIncompatibleError);
  });
});

/**
 * The debt from the C14b skip. The contract's version perturbs a CHILD's zone and this adapter
 * spawns no child, so the property is asserted here instead of being quietly dropped.
 */
describe("jsonfile — output does not depend on the ambient timezone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("is byte-identical across a +14 / UTC / -11 span", async () => {
    const text = doc([
      entry({ tool: "a", at: "2026-08-21T09:00:00.000Z", usd: 1 }),
      entry({ tool: "b", at: "2026-08-22T23:30:00.000Z", usd: 2 }),
      entry({ tool: "c", at: "2026-08-20T00:30:00.000Z", usd: 3 }),
    ]);
    const results: string[] = [];
    for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Niue"]) {
      process.env.TZ = tz;
      results.push(JSON.stringify(await over(text).spendFor(WINDOW)));
    }
    // Not a coincidence of the fixture: the adapter compares epoch milliseconds from Date.parse of
    // UTC instants and reads no zone at all — not window.tz, not the environment.
    expect(new Set(results).size).toBe(1);
  });

  it("ignores window.tz too, since every instant in the file is already absolute", async () => {
    const text = doc([entry({ tool: "a", usd: 1 })]);
    const utc = await over(text).spendFor({ ...WINDOW, tz: "UTC" });
    const kiri = await over(text).spendFor({ ...WINDOW, tz: "Pacific/Kiritimati" });
    expect(utc).toEqual(kiri);
  });
});

describe("jsonfile — identity", () => {
  it("has a stable id and instant granularity", () => {
    const a = new JsonFileSource({ path: "/a" });
    const b = new JsonFileSource({ path: "/b" });
    expect(a.id).toBe("jsonfile");
    expect(a.id).toBe(b.id);
    // `instant` is a property of the format: every entry carries its own timestamp, so an arbitrary
    // range is answerable exactly and app/meter.ts never marks the boundary approximate.
    expect(a.granularity).toBe("instant");
  });
});
