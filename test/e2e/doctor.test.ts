import { describe, expect, it } from "vitest";
import {
  type DoctorFacts,
  REMEDY,
  renderDoctor,
  tildify,
  WIDTH,
} from "../../src/adapters/render/doctor.ts";
import { DEFAULT_CONFIG } from "../../src/domain/config.ts";
import type { UsageSnapshot } from "../../src/domain/types.ts";

const HOME = "/Users/alice";

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  schema: 1,
  usageDay: "2026-08-27",
  generatedAtUtc: "2026-08-27T09:00:00.000Z",
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

const facts = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({
  home: HOME,
  sourceId: "ccusage",
  attempts: [{ where: "ccusage on PATH", found: true, detail: "/opt/homebrew/bin/ccusage" }],
  available: true,
  snapshot: snapshot(),
  snapshotAgeSeconds: 30,
  latch: { present: false, recovered: false, firedToday: [] },
  config: { ...DEFAULT_CONFIG, dailyBudgetUsd: 10 },
  configPath: `${HOME}/.localusagemeter/config.json`,
  configWarnings: [],
  echoSeen: null,
  ...over,
});

const out = (f: DoctorFacts) => renderDoctor(f).lines.join("\n");

describe("lum doctor — shape", () => {
  it("never exceeds 80 columns", () => {
    const long = facts({
      attempts: [{ where: "x".repeat(200), found: false }],
      available: false,
      configWarnings: ["y".repeat(200)],
    });
    for (const line of renderDoctor(long).lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });

  it("breaks prose at a word boundary rather than mid-word", () => {
    const line = renderDoctor(
      facts({
        configPath: "/c",
        configWarnings: ["the quick brown fox jumps over the lazy dog and then keeps running"],
      }),
    ).lines.find((l) => l.includes("config")) as string;
    expect(line.endsWith("…")).toBe(true);
    // The character before the ellipsis should end a word, not sit inside one.
    const body = line.slice(0, -1);
    expect(body).toBe(body.trimEnd());
    expect(line).not.toMatch(/quic…|brow…|jump…/);
  });

  it("hard-cuts a long PATH, because a path has no word boundary to break on", () => {
    const line = renderDoctor(
      facts({
        available: false,
        attempts: [{ where: `/very/${"deep/".repeat(30)}ccusage`, found: false }],
      }),
    ).lines.find((l) => l.includes("deep")) as string;
    expect(line.length).toBeLessThanOrEqual(WIDTH);
    expect(line.endsWith("…")).toBe(true);
  });

  it("emits no ANSI escapes — this output gets pasted into issues", () => {
    expect(out(facts())).not.toContain(String.fromCharCode(27));
  });
});

describe("lum doctor — privacy", () => {
  it("abbreviates the home directory to ~, so a username is not pasted into an issue", () => {
    const text = out(facts());
    expect(text).toContain("~/.localusagemeter/config.json");
    expect(text).not.toContain("/Users/alice");
  });

  it("abbreviates it in the resolution ladder too", () => {
    const text = out(
      facts({
        available: false,
        attempts: [{ where: `${HOME}/.local/bin/ccusage`, found: false }],
      }),
    );
    expect(text).not.toContain("/Users/alice");
  });

  it("tildify leaves unrelated paths alone", () => {
    expect(tildify("/opt/homebrew/bin/ccusage", HOME)).toBe("/opt/homebrew/bin/ccusage");
    expect(tildify("/Users/alice/x", HOME)).toBe("~/x");
    expect(tildify("/Users/alice/x", "")).toBe("/Users/alice/x");
  });
});

describe("lum doctor — says WHERE it looked", () => {
  it("lists every rung of the ladder when nothing resolved", () => {
    const text = out(
      facts({
        available: false,
        attempts: [
          { where: "@ccusage/ccusage-darwin-arm64 in node_modules", found: false },
          { where: "ccusage on PATH", found: false },
        ],
      }),
    );
    // "not found" sends someone to a search engine; naming the places tells them what to install.
    expect(text).toContain("@ccusage/ccusage-darwin-arm64 in node_modules");
    expect(text).toContain("ccusage on PATH");
  });

  it("names where it DID resolve when it worked", () => {
    expect(out(facts())).toContain("/opt/homebrew/bin/ccusage");
  });
});

describe("lum doctor — exit code", () => {
  it("exits 0 when healthy", () => {
    expect(renderDoctor(facts()).exitCode).toBe(0);
  });

  it("exits 0 when merely degraded — a stale number is still a number", () => {
    // A doctor that exits non-zero on a warning is a doctor people stop running.
    expect(renderDoctor(facts({ snapshotAgeSeconds: 100_000 })).exitCode).toBe(0);
    expect(renderDoctor(facts({ available: false })).exitCode).toBe(0);
  });

  it("exits 1 only when NOTHING is usable, and prints the remedy", () => {
    const result = renderDoctor(
      facts({ available: false, snapshot: null, snapshotAgeSeconds: null }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain(REMEDY[1]?.trim() ?? "");
  });
});

describe("lum doctor — the things only doctor can tell you", () => {
  it("says the latch was recovered, which is why no alert fired today", () => {
    const text = out(facts({ latch: { present: true, recovered: true, firedToday: [] } }));
    expect(text).toContain("recovered");
    expect(text).toContain("silent");
  });

  it("lists what fired today", () => {
    const text = out(
      facts({ latch: { present: true, recovered: false, firedToday: ["usd|0.8"] } }),
    );
    expect(text).toContain("usd|0.8");
  });

  it("warns that a partial total is a floor, not a sum", () => {
    expect(out(facts({ snapshot: snapshot({ pricingPartial: true }) }))).toContain("floor");
  });

  it("explains dayBoundaryApprox rather than leaving a ~ unexplained", () => {
    const text = out(facts({ snapshot: snapshot({ dayBoundaryApprox: true }) }));
    expect(text).toContain("whole calendar days");
    expect(text).toContain("resetHourLocal");
  });

  it("names configured tools that were never seen", () => {
    const text = out(
      facts({
        config: { ...DEFAULT_CONFIG, dailyBudgetUsd: 10, tools: ["claude-code", "cursor"] },
      }),
    );
    expect(text).toContain("not seen: cursor");
  });

  it("says the budget is unset rather than implying zero", () => {
    const text = out(facts({ config: { ...DEFAULT_CONFIG, dailyBudgetUsd: 0 } }));
    expect(text).toContain("not set");
    expect(text).not.toContain("$0.00/day");
  });

  it("reports which signal is primary and why", () => {
    expect(out(facts())).toContain("no rate_limits seen");
    expect(out(facts({ echoSeen: { ageSeconds: 12 } }))).toContain("rate-limit");
  });

  it("surfaces every config warning, not just the first", () => {
    const text = out(facts({ configWarnings: ["first problem", "second problem"] }));
    expect(text).toContain("first problem");
    expect(text).toContain("second problem");
  });
});

describe("lum doctor — unknown is never a numeral", () => {
  it("says spend is unknown rather than printing a zero", () => {
    const text = out(facts({ snapshot: snapshot({ totalUsd: null }) }));
    expect(text).toContain("unknown");
    expect(text).not.toContain("$0.00");
  });

  it("a real zero is still allowed to be zero", () => {
    expect(out(facts({ snapshot: snapshot({ totalUsd: 0, imputed: false }) }))).toContain("$0.00");
  });
});

/**
 * P5-2. `doctor` is where someone stands when a surface is missing, so it has to say which
 * surfaces can exist at all — otherwise "there is no meter in my Codex footer" reads as a bug in
 * lum rather than as Codex having no statusline a third party can write into.
 */
describe("lum doctor — surfaces, so a missing one reads as a ceiling and not a fault", () => {
  it("names the guard's hosts and the statusline's single host", () => {
    const text = out(facts());
    expect(text).toContain("surfaces");
    expect(text).toContain("Codex");
    // The limitation must be stated, not merely implied by omission.
    expect(text).toMatch(/statusline: Claude Code only/);
  });

  it("says so even when nothing else is usable — it is a fact about lum, not about this machine", () => {
    const text = out(facts({ available: false, snapshot: null, snapshotAgeSeconds: null }));
    expect(text).toMatch(/statusline: Claude Code only/);
  });
});
