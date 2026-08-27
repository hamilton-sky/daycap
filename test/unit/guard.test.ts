import { describe, expect, it } from "vitest";
import { decide, denyPayload, MAX_BLOCK_AGE_SECONDS } from "../../src/bin/guard.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

const snapshot = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  usageDay: "2026-08-27",
  generatedAtUtc: new Date(NOW - 10_000).toISOString(),
  health: { kind: "ok" },
  totalUsd: 12,
  imputed: true,
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  dailyBudgetUsd: 10,
  guard: { enabled: true, denyAt: 1, mode: "deny", allowTools: ["Read"] },
  ...over,
});

const d = (o: Record<string, unknown> = {}) =>
  decide({ snapshot: snapshot(), config: config(), toolName: "Bash", nowMs: NOW, ...o }) as
    | { allow: true }
    | { allow: false; reason: string };

/** Narrows to the denial branch and fails loudly if it was allowed. */
const denied = (o: Record<string, unknown> = {}): { allow: false; reason: string } => {
  const v = d(o);
  if (v.allow) throw new Error("expected a denial, got allow");
  return v;
};

describe("guard — invariant 4: off unless asked", () => {
  it("allows when guard.enabled is absent", () => {
    expect(d({ config: { dailyBudgetUsd: 10 } }).allow).toBe(true);
  });
  it("allows when guard.enabled is false", () => {
    expect(d({ config: config({ guard: { enabled: false, denyAt: 1 } }) }).allow).toBe(true);
  });
  it("allows when there is no config at all", () => {
    expect(d({ config: {} }).allow).toBe(true);
    expect(d({ config: null }).allow).toBe(true);
  });
});

describe("guard — the case it exists for", () => {
  it("DENIES a tool call when over the allowance on a fresh, healthy snapshot", () => {
    const v = denied();
    expect(v.reason).toContain("120%");
    expect(v.reason).toContain("$12.00 of $10.00");
  });

  it("says usage allowance for imputed money and budget for real money", () => {
    expect(denied().reason).toContain("daily usage allowance");
    expect(denied({ snapshot: snapshot({ imputed: false }) }).reason).toContain("daily budget");
  });

  it("tells the user how to get unstuck — a denial with no way out is a broken tool", () => {
    const r = denied().reason;
    expect(r).toContain("dailyBudgetUsd");
    expect(r).toContain("guard.enabled");
    expect(r).toContain("reset");
  });

  it("honours a custom denyAt", () => {
    const cfg = config({ guard: { enabled: true, denyAt: 2, mode: "deny", allowTools: [] } });
    // 12/10 = 1.2, below a 2.0 guard.
    expect(d({ config: cfg }).allow).toBe(true);
  });

  it("allows below the threshold", () => {
    expect(d({ snapshot: snapshot({ totalUsd: 9.99 }) }).allow).toBe(true);
  });

  it("denies exactly AT the threshold", () => {
    expect(d({ snapshot: snapshot({ totalUsd: 10 }) }).allow).toBe(false);
  });
});

describe("guard — invariant 2: never block on a number we are unsure of", () => {
  it.each([
    [
      "stale beyond the block window",
      snapshot({
        generatedAtUtc: new Date(NOW - (MAX_BLOCK_AGE_SECONDS + 1) * 1000).toISOString(),
      }),
    ],
    ["timeout", snapshot({ health: { kind: "timeout", afterMs: 3000 } })],
    ["no-source", snapshot({ health: { kind: "no-source", lookedFor: [] } })],
    ["incompatible", snapshot({ health: { kind: "incompatible", detail: "x" } })],
    ["unknown total", snapshot({ totalUsd: null })],
    ["missing snapshot", null],
    ["wrong schema", snapshot({ schema: 2 })],
    ["unparseable timestamp", snapshot({ generatedAtUtc: "not-a-date" })],
  ])("%s => ALLOW", (_name, snap) => {
    // A missed block costs money. A wrong block costs the user their work. Not symmetric.
    expect(d({ snapshot: snap }).allow).toBe(true);
  });

  it("blocks right up to the edge of the window but not past it", () => {
    const inside = snapshot({
      generatedAtUtc: new Date(NOW - (MAX_BLOCK_AGE_SECONDS - 1) * 1000).toISOString(),
    });
    expect(d({ snapshot: inside }).allow).toBe(false);
  });

  it("is far tighter than the statusline's display staleness threshold", () => {
    // Showing a slightly old number is a small sin; refusing a tool call on one is not.
    expect(MAX_BLOCK_AGE_SECONDS).toBeLessThan(15 * 60);
  });
});

describe("guard — no budget means nothing to be over", () => {
  it.each([0, undefined, null, -5, "10"])("dailyBudgetUsd %j => ALLOW", (v) => {
    expect(d({ config: config({ dailyBudgetUsd: v }) }).allow).toBe(true);
  });
});

describe("guard — allowTools keeps a blocked session inspectable", () => {
  it("exempts a listed tool even when well over", () => {
    expect(d({ toolName: "Read" }).allow).toBe(true);
  });
  it("still denies an unlisted one", () => {
    expect(d({ toolName: "Bash" }).allow).toBe(false);
  });
  it("denies when the tool name is unknown — no name is not an exemption", () => {
    expect(d({ toolName: undefined }).allow).toBe(false);
  });
});

describe("guard — the deny payload", () => {
  it("matches the documented PreToolUse contract", () => {
    expect(denyPayload("because")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "because",
      },
    });
  });
});

/**
 * P5-2 — the Codex host. `decide()` is shared, so these are the only input differences.
 *
 * Codex reports the CANONICAL tool name (`apply_patch`) on stdin and offers the familiar
 * spellings separately as `matcher_aliases`. If the exemption check ignored the aliases, one
 * `allowTools: ["Edit"]` would mean "edits are exempt" on Claude Code and nothing at all on Codex
 * — a block the user explicitly asked not to have, on one host only.
 */
describe("guard — allowTools is portable across hosts (Codex matcher aliases)", () => {
  const editable = { guard: { enabled: true, denyAt: 1, mode: "deny", allowTools: ["Edit"] } };

  it("exempts apply_patch when Edit is allowed and Codex offers it as an alias", () => {
    expect(
      d({
        config: config(editable),
        toolName: "apply_patch",
        matcherAliases: ["Edit", "Write"],
      }).allow,
    ).toBe(true);
  });

  it("still denies apply_patch when no alias matches", () => {
    expect(
      d({ config: config(editable), toolName: "apply_patch", matcherAliases: ["Patch"] }).allow,
    ).toBe(false);
  });

  it("denies the canonical name alone — aliases exempt, they do not blanket-allow", () => {
    expect(d({ config: config(editable), toolName: "apply_patch" }).allow).toBe(false);
  });

  it.each([undefined, null, "Edit", 42, [42]])(
    "a matcher_aliases of %j never throws and never wrongly exempts",
    (aliases) => {
      expect(d({ config: config(editable), toolName: "Bash", matcherAliases: aliases }).allow).toBe(
        false,
      );
    },
  );

  it("Claude Code sends no aliases at all, and behaves exactly as before", () => {
    expect(d({ toolName: "Read", matcherAliases: undefined }).allow).toBe(true);
    expect(d({ toolName: "Bash", matcherAliases: undefined }).allow).toBe(false);
  });
});

/**
 * Codex's parser REJECTS `permissionDecision:deny` carrying an empty reason, and a rejected hook
 * run lets the tool call proceed. So on that host invariant 5 is not politeness — a denial with no
 * reason is not a block at all. Every denial `decide()` can produce must carry one.
 */
describe("guard — every denial carries a non-empty reason (Codex rejects one without)", () => {
  it.each([
    ["at the threshold exactly", { snapshot: snapshot({ totalUsd: 10 }) }],
    ["far over", { snapshot: snapshot({ totalUsd: 1000 }) }],
    ["a measured, non-imputed total", { snapshot: snapshot({ imputed: false }) }],
    ["a fractional denyAt", { config: config({ guard: { enabled: true, denyAt: 0.5 } }) }],
  ])("%s", (_name, over) => {
    expect(denied(over).reason.trim().length).toBeGreaterThan(0);
  });
});
