import { describe, expect, it } from "vitest";
import {
  hookEntry,
  planCodexInstall,
  planInstall,
  renderCodexPlan,
  renderPlan,
  statusLineBlock,
} from "../../src/app/install.ts";

const SL = "/opt/lum/statusline.js";
const plan = (existing: unknown) => planInstall(existing, "lum", SL);

const commandsFor = (merged: Record<string, unknown>, event: string): string[] => {
  const hooks = merged.hooks as Record<string, unknown[]>;
  return (hooks[event] ?? []).flatMap((e) =>
    ((e as { hooks?: { command?: string }[] }).hooks ?? []).map((h) => h.command ?? ""),
  );
};

describe("planInstall — a fresh settings file", () => {
  it("adds the statusLine and both hooks", () => {
    const { merged, changes } = plan(null);
    expect(merged.statusLine).toEqual(statusLineBlock(SL));
    expect(commandsFor(merged, "Stop")).toEqual(["lum refresh"]);
    expect(commandsFor(merged, "SessionStart")).toEqual(["lum refresh"]);
    expect(changes).toHaveLength(3);
  });

  it("uses Stop, and deliberately NOT PostToolUse", () => {
    const { merged } = plan(null);
    // PostToolUse fires many times per turn; a collector spawn per tool call is ccusage #455
    // (spawn accumulation until OOM) reproduced inside our own tool.
    expect(Object.keys(merged.hooks as object).sort()).toEqual(["SessionStart", "Stop"]);
  });

  it("marks the refresh hook async so the user's turn never waits on the collector", () => {
    const entry = hookEntry("lum refresh") as { hooks: { async: boolean; timeout: number }[] };
    expect(entry.hooks[0]?.async).toBe(true);
    expect(entry.hooks[0]?.timeout).toBe(10);
  });
});

describe("planInstall — an existing settings file", () => {
  const existing = {
    theme: "dark",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "python -m my_own.telemetry" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "my-linter" }] }],
    },
  };

  it("never rewrites a key it does not own", () => {
    const { merged } = plan(existing);
    expect(merged.theme).toBe("dark");
    expect(merged.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("keeps the user's own hooks in the SAME event and appends ours", () => {
    const { merged } = plan(existing);
    // Flattening someone's settings file is how you make an installer nobody runs twice.
    expect(commandsFor(merged, "Stop")).toEqual(["python -m my_own.telemetry", "lum refresh"]);
  });

  it("leaves unrelated hook events untouched", () => {
    const { merged } = plan(existing);
    expect(commandsFor(merged, "PreToolUse")).toEqual(["my-linter"]);
  });

  it("is idempotent — re-running changes nothing and stacks no duplicates", () => {
    const first = plan(existing);
    const second = plan(first.merged);
    expect(second.changes).toEqual([]);
    expect(second.merged).toEqual(first.merged);
    expect(commandsFor(second.merged, "Stop")).toEqual([
      "python -m my_own.telemetry",
      "lum refresh",
    ]);
  });

  it("replaces a statusLine that points somewhere else, and says so", () => {
    const { merged, changes } = plan({ statusLine: { type: "command", command: "/old/thing" } });
    expect(merged.statusLine).toEqual(statusLineBlock(SL));
    expect(changes.join()).toContain("replace statusLine");
  });

  it("tolerates a malformed settings file rather than throwing", () => {
    for (const bad of [42, "text", [], { hooks: "nope" }, { hooks: { Stop: "nope" } }]) {
      expect(() => plan(bad)).not.toThrow();
    }
  });
});

describe("renderPlan", () => {
  it("explains why the Stop hook matters, not just what to paste", () => {
    const out = renderPlan(plan(null), "/x/settings.json").join("\n");
    expect(out).toContain("--write");
    expect(out).toContain("stale");
  });

  it("says there is nothing to do when already installed", () => {
    const done = plan(plan(null).merged);
    expect(renderPlan(done, "/x/settings.json").join("\n")).toContain("already installed");
  });
});

/**
 * P5-2 — `lum install --codex`. Writes `~/.codex/hooks.json`.
 *
 * The shape is near-identical to the Claude Code block, which is the finding, not a shortcut: one
 * `guard.js` serves both hosts. What these assert is the handful of things that are NOT the same.
 */
describe("planCodexInstall", () => {
  const GUARD = "/opt/lum/guard.js";
  const codex = (existing: unknown, o = {}) => planCodexInstall(existing, "lum", o);

  it("installs the refresh hooks and no statusLine — Codex has no statusline to write into", () => {
    const { merged, changes } = codex(null);
    expect(merged.statusLine).toBeUndefined();
    expect(commandsFor(merged as Record<string, unknown>, "Stop")).toEqual(["lum refresh"]);
    expect(commandsFor(merged as Record<string, unknown>, "SessionStart")).toEqual(["lum refresh"]);
    expect(changes).toEqual(["add SessionStart hook", "add Stop hook"]);
  });

  it("leaves the guard out unless asked, exactly like the Claude Code path", () => {
    expect(commandsFor(codex(null).merged as Record<string, unknown>, "PreToolUse")).toEqual([]);
    const armed = codex(null, { guard: true, guardPath: GUARD });
    expect(commandsFor(armed.merged as Record<string, unknown>, "PreToolUse")).toEqual([GUARD]);
  });

  /**
   * The one that would actually hurt. Codex defaults an unspecified hook timeout to 600 SECONDS,
   * against Claude Code's 60. A guard without an explicit timeout is not a slow guard there, it is
   * a tool call that hangs for ten minutes.
   */
  it("pins an explicit timeout on every hook it writes", () => {
    const { merged } = codex(null, { guard: true, guardPath: GUARD });
    const hooks = (merged as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> })
      .hooks;
    const all = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(all.length).toBeGreaterThan(2);
    for (const h of all) {
      expect(typeof h.timeout, `${JSON.stringify(h)} has no explicit timeout`).toBe("number");
      expect(h.timeout as number).toBeLessThanOrEqual(10);
    }
  });

  it("keeps the guard synchronous — an async hook cannot block at all", () => {
    const { merged } = codex(null, { guard: true, guardPath: GUARD });
    const pre = (merged as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> }).hooks
      .PreToolUse;
    expect(pre?.[0]?.hooks[0]?.async).toBeUndefined();
  });

  it("never rewrites a hook the user wrote themselves", () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-thing" }] }] } };
    const { merged } = codex(mine);
    expect(commandsFor(merged as Record<string, unknown>, "Stop")).toEqual([
      "my-own-thing",
      "lum refresh",
    ]);
  });

  it("is idempotent — re-running stacks nothing", () => {
    const once = codex(null, { guard: true, guardPath: GUARD });
    const twice = planCodexInstall(once.merged, "lum", { guard: true, guardPath: GUARD });
    expect(twice.changes).toEqual([]);
    expect(twice.merged).toEqual(once.merged);
  });
});

describe("renderCodexPlan", () => {
  it("tells the user to trust the hooks, because writing the file does not arm them", () => {
    const text = renderCodexPlan(planCodexInstall(null, "lum"), "~/.codex/hooks.json").join("\n");
    // Codex runs no non-managed hook until it is reviewed, and pins trust to the hook's hash.
    expect(text).toContain("/hooks");
    expect(text.toLowerCase()).toContain("trust");
  });

  it("states the statusline limitation rather than staying quiet about it", () => {
    const text = renderCodexPlan(planCodexInstall(null, "lum"), "~/.codex/hooks.json").join("\n");
    expect(text.toLowerCase()).toContain("no statusline");
  });
});
