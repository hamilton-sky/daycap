import { describe, expect, it } from "vitest";
import {
  bar,
  colorMode,
  echoPayload,
  NO_SOURCE,
  rateLimitSegments,
  render,
  SOURCE_DOWN,
  thresholdColor,
  trustState,
} from "../../src/bin/statusline.js";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

const snap = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  usageDay: "2026-08-26",
  generatedAtUtc: new Date(NOW).toISOString(),
  sourceId: "ccusage",
  sourceFresh: true,
  sourceLastUpdatedUtc: null,
  health: { kind: "ok" },
  tools: [{ tool: "claude-code", usd: 3.2, imputed: true }],
  totalUsd: 3.2,
  pricingPartial: false,
  imputed: true,
  dayBoundaryApprox: false,
  ...over,
});

type Snap = Record<string, unknown> | null;
const R = (s: Snap, opts: Record<string, unknown> = {}) =>
  render(s, { config: { dailyBudgetUsd: 10 }, nowMs: NOW, ...opts });
const ESC = String.fromCharCode(27);
const strip = (s: string) =>
  s
    .split(ESC)
    .map((p: string, i: number) => (i === 0 ? p : p.replace(/^\[[0-9;]*m/, "")))
    .join("");

describe("USD-primary form (DESIGN §1)", () => {
  it("renders spend, budget, percentage and bar", () => {
    expect(R(snap())).toBe(
      "today =$3.20 / $10.00 ( 32%) ##...".replace("=", "≈").replace("##...", "▓▓░░░"),
    );
  });

  it("uses the imputed marker only for imputed money", () => {
    expect(R(snap())).toContain("≈$3.20");
    expect(R(snap({ imputed: false }))).toContain("$3.20");
    expect(R(snap({ imputed: false }))).not.toContain("≈");
  });

  it("drops the percentage and bar entirely when no budget is set", () => {
    const out = render(snap(), { config: {}, nowMs: NOW });
    expect(out).toBe("today ≈$3.20");
    expect(out).not.toMatch(/%/);
    expect(out).not.toContain("▓");
  });

  it("honours display.barWidth", () => {
    const out = render(snap(), {
      config: { dailyBudgetUsd: 10, display: { barWidth: 10 } },
      nowMs: NOW,
    });
    expect([...out].filter((c) => c === "▓" || c === "░")).toHaveLength(10);
  });
});

describe("rate-limit-primary form (DESIGN §5)", () => {
  const rl = (five: number | null, seven: number | null) => ({
    rate_limits: {
      ...(five === null ? {} : { five_hour: { used_percentage: five, resets_at: "x" } }),
      ...(seven === null ? {} : { seven_day: { used_percentage: seven, resets_at: "y" } }),
    },
  });

  it("leads with both windows and trails the dollar figure", () => {
    const out = R(snap(), { stdin: rl(23, 41) });
    expect(out).toContain("5h  23%");
    expect(out).toContain("7d  41%");
    expect(out).toContain("·"); // middle-dot separator
    expect(out).toMatch(/≈\$3\.20 today$/);
  });

  it("NEVER renders a placeholder for an absent window", () => {
    const five = R(snap(), { stdin: rl(23, null) });
    expect(five).toContain("5h");
    expect(five).not.toContain("7d");
    // "5h 23% - 7d -%" would invent a number where there is none; the separator goes too.
    expect(five).not.toContain("·");

    const seven = R(snap(), { stdin: rl(null, 41) });
    expect(seven).toContain("7d");
    expect(seven).not.toContain("5h");
  });

  it("falls back to the USD-primary form when neither window is present", () => {
    expect(R(snap(), { stdin: rl(null, null) })).toBe(R(snap()));
  });

  it("the HIGHER window drives the shared bar", () => {
    // 41% of a 5-cell bar rounds to 2 filled; 23% would round to 1. Crossing EITHER cap blocks
    // you, so a fixed choice would hide the other window's state exactly when it matters.
    const out = strip(R(snap(), { stdin: rl(23, 41), mode: "none" }));
    const barPart = out.match(/[▓░]+/)?.[0];
    expect(barPart).toBe(bar(0.41, 5));
    expect(barPart).not.toBe(bar(0.23, 5));
  });

  it("ignores a non-numeric percentage rather than rendering NaN", () => {
    const out = R(snap(), { stdin: { rate_limits: { five_hour: { used_percentage: "nope" } } } });
    expect(out).toBe(R(snap()));
    expect(out).not.toContain("NaN");
  });
});

describe("the five-state trust taxonomy (DESIGN §7)", () => {
  it.each([
    [0, snap()],
    [1, snap({ pricingPartial: true })],
    [2, snap({ generatedAtUtc: new Date(NOW - 200_000).toISOString() })],
    [3, snap({ health: { kind: "timeout", afterMs: 3000 } })],
    [3, snap({ health: { kind: "incompatible", detail: "x" } })],
    [4, snap({ health: { kind: "no-source", lookedFor: [] } })],
    [4, null],
  ])("state %i", (expected, s) => {
    expect(trustState(s, NOW)).toBe(expected);
  });

  it("state 1 appends * and keeps the threshold colour", () => {
    const out = R(snap({ pricingPartial: true }), { mode: "256" });
    expect(strip(out)).toMatch(/ \*$/);
    expect(out).toContain("38;5;77"); // still green — the figures that arrived are trustworthy
  });

  it("state 2 mutes the ENTIRE numeric field, not just the suffix", () => {
    const out = R(snap({ generatedAtUtc: new Date(NOW - 200_000).toISOString() }), { mode: "256" });
    expect(strip(out)).toMatch(/⋯$/);
    expect(out).toContain("38;5;246");
    // Colouring a value we are unsure of with a threshold colour overstates confidence in it.
    expect(out).not.toContain("38;5;77");
  });

  it("state 3 says the words, so the difference survives NO_COLOR", () => {
    const out = R(snap({ health: { kind: "timeout", afterMs: 3000 } }), { mode: "none" });
    expect(out).toContain("(source down)");
  });

  it("state 3 with no cached value at all renders the bare source-down line", () => {
    expect(R(snap({ health: { kind: "timeout", afterMs: 1 }, totalUsd: null }))).toBe(SOURCE_DOWN);
  });

  it("state 4 renders the bare no-source line with no colour at all", () => {
    expect(R(snap({ health: { kind: "no-source", lookedFor: [] } }), { mode: "256" })).toBe(
      NO_SOURCE,
    );
    expect(R(null)).toBe(NO_SOURCE);
  });

  it("state 2 and state 3 are NOT the same render", () => {
    const stale = R(snap({ generatedAtUtc: new Date(NOW - 200_000).toISOString() }));
    const down = R(snap({ health: { kind: "timeout", afterMs: 3000 } }));
    expect(stale).not.toBe(down);
  });
});

describe('"I don\'t know" must never render as "you spent nothing"', () => {
  it.each([
    ["no-source", snap({ health: { kind: "no-source", lookedFor: [] }, totalUsd: null })],
    ["incompatible", snap({ health: { kind: "incompatible", detail: "x" }, totalUsd: null })],
    ["null snapshot", null],
    ["unknown total", snap({ totalUsd: null })],
    ["wrong schema", snap({ schema: 2 })],
  ])("%s prints no dollar numeral", (_n, s) => {
    const out = R(s);
    expect(out).not.toContain("$0.00");
    expect(out).not.toMatch(/\$\d/);
  });

  it("a real collector-confirmed zero IS allowed to say $0.00, in full threshold green", () => {
    const out = R(snap({ totalUsd: 0, imputed: false }), { mode: "256" });
    expect(out).toContain("$0.00");
    expect(out).toContain("38;5;77");
    expect(strip(out)).not.toMatch(/[*⋯]|source down/);
  });
});

describe("colour", () => {
  it.each([
    [0.5, "green", "38;5;77"],
    [0.85, "amber", "38;5;208"],
    [1.2, "red", "38;5;203"],
  ])("fraction %s is %s", (f, name, code) => {
    expect(thresholdColor(f)).toBe(name);
    expect(R(snap({ totalUsd: f * 10 }), { mode: "256" })).toContain(code);
  });

  it("falls back to 16 colours where 256 is unavailable", () => {
    const out = R(snap(), { mode: "16" });
    expect(out).toContain("[32m");
    expect(out).not.toContain("38;5;");
  });

  it("emits no escape at all in none mode", () => {
    expect(R(snap(), { mode: "none" })).not.toContain(ESC);
  });

  it.each([
    [{ NO_COLOR: "1", TERM: "xterm-256color" }, "none"],
    [{ TERM: "dumb" }, "none"],
    [{ TERM: "" }, "none"],
    [{ TERM: "xterm-256color" }, "256"],
    [{ TERM: "xterm", COLORTERM: "truecolor" }, "256"],
    [{ TERM: "xterm" }, "16"],
  ])("colorMode(%j) = %s", (env, expected) => {
    expect(colorMode(env, [])).toBe(expected);
  });

  it("--no-color strips everything", () => {
    expect(colorMode({ TERM: "xterm-256color" }, ["--no-color"])).toBe("none");
  });

  it("the state marker sits OUTSIDE the colour reset, so it never inherits threshold colour", () => {
    const out = R(snap({ pricingPartial: true }), { mode: "256" });
    // The final reset must come before the marker.
    expect(out.lastIndexOf("[0m")).toBeGreaterThan(out.indexOf("38;5;77"));
  });
});

describe("bar", () => {
  it.each([
    [0, "░░░░░"],
    [0.5, "▓▓▓░░"],
    [1, "▓▓▓▓▓"],
    [2, "▓▓▓▓▓"],
    [-1, "░░░░░"],
  ])("fraction %s", (f, expected) => {
    expect(bar(f, 5)).toBe(expected);
  });

  it("renders nothing for an unknown fraction", () => {
    expect(bar(null)).toBe("");
    expect(bar(Number.NaN)).toBe("");
  });
});

describe("stdin echo (the OPEN-F bridge)", () => {
  it("records only the numbers, and stays small", () => {
    const p = echoPayload(
      {
        rate_limits: {
          five_hour: { used_percentage: 23, resets_at: "2026-08-26T18:00:00Z" },
          seven_day: { used_percentage: 41, resets_at: "2026-08-30T00:00:00Z" },
        },
        transcript_path: "/Users/alice/secret/project.jsonl",
        cwd: "/Users/alice/secret",
      },
      "2026-08-26T12:00:00.000Z",
    );
    const text = JSON.stringify(p);
    const rec = p as unknown as Record<string, { used_percentage: number }>;
    expect(rec.five_hour?.used_percentage).toBe(23);
    expect(rec.seven_day?.used_percentage).toBe(41);
    // The payload must never carry a path — it lands in a file the next refresh reads.
    expect(text).not.toContain("alice");
    expect(text).not.toContain("transcript");
    expect(text.length).toBeLessThan(300);
  });

  it("returns null when there is nothing worth recording", () => {
    expect(echoPayload(null, "t")).toBeNull();
    expect(echoPayload({}, "t")).toBeNull();
    expect(echoPayload({ rate_limits: {} }, "t")).toBeNull();
    expect(echoPayload({ rate_limits: { five_hour: {} } }, "t")).toBeNull();
  });

  it("records one window when only one is present", () => {
    const one = echoPayload({ rate_limits: { seven_day: { used_percentage: 41 } } }, "t") as Record<
      string,
      { used_percentage: number } | undefined
    > | null;
    expect(one?.seven_day?.used_percentage).toBe(41);
    expect(one?.five_hour).toBeUndefined();
  });
});

describe("rateLimitSegments", () => {
  it("returns windows in 5h, 7d order", () => {
    const segs = rateLimitSegments({
      seven_day: { used_percentage: 41 },
      five_hour: { used_percentage: 23 },
    });
    expect(segs.map((s) => s.label)).toEqual(["5h", "7d"]);
  });

  it("tolerates a missing or malformed rate_limits object", () => {
    for (const v of [
      undefined,
      null,
      {},
      { five_hour: null },
      { five_hour: { used_percentage: null } },
    ]) {
      expect(rateLimitSegments(v)).toEqual([]);
    }
  });
});
