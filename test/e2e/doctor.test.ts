import { describe, expect, it } from "vitest";
import {
  type DoctorFacts,
  REMEDY,
  renderDoctor,
  tildify,
  WIDTH,
} from "../../src/adapters/render/doctor.ts";
import { DEFAULT_CONFIG } from "../../src/domain/config.ts";
import { UNPRICEABLE_TOOLS } from "../../src/domain/surfaces.ts";
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
  unpriceableFound: [],
  // The common single-candidate world: ccusage present, no sourceFile set. Cases that care about
  // selection override this explicitly, so the default stays the shape most users actually have.
  selection: { chosen: "ccusage", reason: "ccusage (auto)", namedButMissing: false },
  probes: [
    { id: "ccusage", configured: true, available: true, where: "/opt/homebrew/bin/ccusage" },
    { id: "jsonfile", configured: false, available: false, where: "sourceFile is not set" },
  ],
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

/**
 * P5-3. The acceptance criteria, and the one invariant they are an instance of.
 *
 * Invariant 1 says unknown must never render as `$0.00`. A tool left out of the report entirely is
 * the same falsehood told by omission: the Cursor user's total is missing their heaviest tool and
 * the screen gives them no way to tell that from a quiet day.
 */
describe("lum doctor — tools that cannot be priced (P5-3)", () => {
  it("names Cursor when it is installed, and says why it is not counted", () => {
    const text = out(facts({ unpriceableFound: ["cursor"] }));
    expect(text).toContain("cursor");
    expect(text).toMatch(/no local spend data/);
  });

  it("says nothing at all when it is absent", () => {
    // Not "prints an empty row" — the row must not exist. A permanent line about a tool the user
    // does not run is noise, and noise is what stops the rest of this screen being read.
    const text = out(facts({ unpriceableFound: [] }));
    expect(text).not.toContain("cursor");
    expect(text).not.toContain("unpriced");
  });

  it("fits the row without being clipped, for the case that actually ships", () => {
    // The 80-column test below CANNOT catch an over-long sentence: `clip` truncates it to fit, so
    // the assertion passes while the user reads "...so it cannot be…". That is exactly what the
    // first draft of this line did. A single tool is the shipping case, and it must fit whole.
    const line = renderDoctor(facts({ unpriceableFound: ["cursor"] })).lines.find((l) =>
      l.includes("unpriced"),
    ) as string;
    expect(line.endsWith("…")).toBe(false);
    expect(line).toContain("no local spend data");
  });

  it("stays inside 80 columns with every unpriceable tool present at once", () => {
    // Guards the future shape of the list, not today's single entry: this line is assembled by
    // joining names, so it is the one row here that grows without anyone editing the renderer.
    const long = facts({ unpriceableFound: [...UNPRICEABLE_TOOLS, "some-other-editor"] });
    for (const line of renderDoctor(long).lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });

  it("is a warning, not a failure — there is nothing for the user to fix", () => {
    // Exit 1 is reserved for "nothing is usable". An unpriceable tool is a permanent property of
    // that tool, so exiting non-zero would make `lum doctor` fail forever on a working install.
    expect(renderDoctor(facts({ unpriceableFound: ["cursor"] })).exitCode).toBe(0);
  });
});

/**
 * P4-3. The other half of the AC: the choice must be EXPLAINED, not merely deterministic. A
 * deterministic choice nobody can see is indistinguishable from a coin flip landing the same way.
 */
describe("lum doctor — which source, and why (P4-3)", () => {
  const twoCandidates = (over: Partial<DoctorFacts> = {}) =>
    facts({
      probes: [
        { id: "ccusage", configured: true, available: true, where: "/opt/homebrew/bin/ccusage" },
        { id: "jsonfile", configured: true, available: true, where: `${HOME}/usage.json` },
      ],
      selection: {
        chosen: "jsonfile",
        reason: "jsonfile (auto; preferred over ccusage)",
        namedButMissing: false,
      },
      ...over,
    });

  it("stays quiet when there is nothing to explain", () => {
    // One candidate, no sourceFile: a permanent "auto chose the only option" row is noise, and
    // noise is what stops the rest of this screen being read.
    expect(out(facts())).not.toContain("selected");
  });

  it("explains the choice as soon as a second candidate is configured", () => {
    const text = out(twoCandidates());
    expect(text).toContain("selected");
    expect(text).toContain("preferred over ccusage");
  });

  it("lists every candidate with whether it answered", () => {
    const text = out(twoCandidates());
    expect(text).toContain("ccusage");
    expect(text).toContain("jsonfile");
    // Both were reachable, so both are ticked — the user can see nothing was skipped.
    expect(text).toContain("~/usage.json");
  });

  it("prints the policy's own sentence rather than paraphrasing it", () => {
    // If the renderer restated the rule, the explanation could drift from the decision, and an
    // explanation that no longer matches the decision is worse than none.
    const reason = "jsonfile (requested explicitly by config)";
    const text = out(
      twoCandidates({ selection: { chosen: "jsonfile", reason, namedButMissing: false } }),
    );
    expect(text).toContain(reason);
  });

  it("marks an unconfigured candidate as neither present nor broken", () => {
    // `·` not `✗`: jsonfile with no sourceFile is not a failure, it is a source the user never
    // asked for. Showing it as broken would send someone hunting a fault that does not exist.
    const text = out(
      twoCandidates({
        probes: [
          { id: "ccusage", configured: true, available: true, where: "/opt/homebrew/bin/ccusage" },
          { id: "jsonfile", configured: false, available: false, where: "sourceFile is not set" },
        ],
        selection: { chosen: "ccusage", reason: "ccusage (auto)", namedButMissing: false },
      }),
    );
    // Two configured candidates is what triggers the block, so with one the block is absent again.
    expect(text).not.toContain("selected");
  });

  it("explains a named-but-missing source, and does NOT report it as a fallback", () => {
    const text = out(
      facts({
        available: false,
        selection: {
          chosen: null,
          reason:
            'source "ccusage" was requested but did not answer (/opt/homebrew/bin/ccusage); ' +
            'jsonfile would have worked — set source to it, or "auto"',
          namedButMissing: true,
        },
        probes: [
          { id: "ccusage", configured: true, available: false, where: "/opt/homebrew/bin/ccusage" },
          { id: "jsonfile", configured: true, available: true, where: `${HOME}/usage.json` },
        ],
      }),
    );
    expect(text).toContain("was requested but did not answer");
    expect(text).toContain("jsonfile would have worked");
  });

  it("shows the selection block whenever nothing was chosen, even with one candidate", () => {
    const text = out(
      facts({
        available: false,
        selection: {
          chosen: null,
          reason: "auto found no usable source; tried ccusage",
          namedButMissing: false,
        },
      }),
    );
    expect(text).toContain("no usable source");
  });

  it("keeps every selection line inside 80 columns", () => {
    const text = twoCandidates({
      selection: { chosen: "jsonfile", reason: "x".repeat(300), namedButMissing: false },
      probes: [
        { id: "ccusage", configured: true, available: true, where: "y".repeat(300) },
        { id: "jsonfile", configured: true, available: true, where: "z".repeat(300) },
      ],
    });
    for (const line of renderDoctor(text).lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });
});

/**
 * P4-3 regression: the source row and the selection block must not contradict each other.
 *
 * Found live, not by test. When nothing was selected, the source row printed its own candidate
 * ladder marking an AVAILABLE ccusage as `✗ not found`, two lines above the selection block marking
 * the same probe `✓`. One screen, two answers.
 */
describe("lum doctor — the screen never disagrees with itself (P4-3)", () => {
  const nothingSelected = facts({
    available: false,
    attempts: [],
    selection: {
      chosen: null,
      reason:
        'source "jsonfile" was requested but did not answer (/gone.json); ccusage would have worked',
      namedButMissing: true,
    },
    probes: [
      { id: "ccusage", configured: true, available: true, where: "/opt/homebrew/bin/ccusage" },
      { id: "jsonfile", configured: true, available: false, where: "/gone.json" },
    ],
  });

  it("defers to the selection block instead of printing a second ladder", () => {
    const text = out(nothingSelected);
    expect(text).toContain("none selected");
    expect(text).not.toContain("not found. Looked for:");
  });

  it("never marks an available source as not found", () => {
    // The exact contradiction: ccusage available, so no line may pair it with a ✗.
    for (const line of renderDoctor(nothingSelected).lines) {
      if (line.includes("ccusage") && line.includes("✗")) {
        throw new Error(`contradictory line: ${line}`);
      }
    }
  });

  it("still keeps the per-tier ladder when a source WAS chosen but is now unreachable", () => {
    // The ccusage four-tier ladder is the most useful thing on this screen for an install problem,
    // so the fix above must not have deleted it for the case it exists to serve.
    const text = out(
      facts({
        available: false,
        attempts: [
          { where: "@ccusage/ccusage-darwin-arm64 in node_modules", found: false },
          { where: "ccusage on PATH", found: false },
        ],
      }),
    );
    expect(text).toContain("not found. Looked for:");
    expect(text).toContain("@ccusage/ccusage-darwin-arm64 in node_modules");
  });
});
