import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(root, "src", "bin", "guard.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lum-guard-"));
  mkdirSync(join(home, ".daycap", "state"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeSnapshot(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(home, ".daycap", "state", "today.json"),
    JSON.stringify({
      schema: 1,
      usageDay: "2026-08-27",
      generatedAtUtc: new Date().toISOString(),
      sourceId: "ccusage",
      sourceFresh: true,
      sourceLastUpdatedUtc: null,
      health: { kind: "ok" },
      tools: [{ tool: "claude-code", usd: 12, imputed: true }],
      totalUsd: 12,
      pricingPartial: false,
      imputed: true,
      dayBoundaryApprox: false,
      ...over,
    }),
  );
}

function writeConfig(guard: Record<string, unknown> | undefined): void {
  writeFileSync(
    join(home, ".daycap", "config.json"),
    JSON.stringify({ dailyBudgetUsd: 10, ...(guard === undefined ? {} : { guard }) }),
  );
}

function run(input = '{"tool_name":"Bash"}'): { out: string; err: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [GUARD], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      input,
      timeout: 20_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { out, err: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: err.stdout ?? "", err: err.stderr ?? "", code: err.status ?? -1 };
  }
}

describe("guard — as a real hook process", () => {
  it("stays silent and exits 0 when disabled", () => {
    writeSnapshot();
    writeConfig({ enabled: false });
    const { out, code } = run();
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  it("emits the deny payload and exits 0 in deny mode", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: [] });
    const { out, code } = run();
    const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("120%");
    // Exit 0: the JSON carries the verdict, so a contract change fails OPEN rather than blocking
    // every tool call forever.
    expect(code).toBe(0);
  });

  it("exits 2 in hard mode, which blocks unconditionally", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "hard", allowTools: [] });
    const { out, code } = run();
    expect(out).toContain("deny");
    expect(code).toBe(2);
  });
});

describe("guard — invariant 3: fail open on every fault", () => {
  it.each([
    [
      "a truncated snapshot",
      () => writeFileSync(join(home, ".daycap", "state", "today.json"), '{"schema":1,'),
    ],
    [
      "a truncated config",
      () => {
        writeSnapshot();
        writeFileSync(join(home, ".daycap", "config.json"), "{not json");
      },
    ],
    [
      "no state directory at all",
      () => rmSync(join(home, ".daycap"), { recursive: true, force: true }),
    ],
    [
      "a snapshot that is an array",
      () => writeFileSync(join(home, ".daycap", "state", "today.json"), "[]"),
    ],
  ])("%s allows and exits 0", (_name, setup) => {
    writeConfig({ enabled: true, denyAt: 1, mode: "hard", allowTools: [] });
    setup();
    const { out, code } = run();
    // A guard that blocks because it crashed is worse than no guard.
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  it("allows when stdin is absent or not JSON", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: ["Bash"] });
    // No tool_name means allowTools cannot match, so this DENIES — the point is it does not crash.
    const { code } = run("not json at all");
    expect(code).toBe(0);
  });
});

describe("guard — it must never become the slow path", () => {
  it("completes far inside the fail-open timeout", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: [] });
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      run();
      samples.push(performance.now() - t);
    }
    const p95 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? 0;
    // A timed-out hook does NOT block — the docs are explicit. So a slow guard is an absent guard,
    // and this assertion is the difference between enforcement and the illusion of it.
    expect(p95).toBeLessThan(1000);
  });
});

describe("guard — it reads a cache, never a collector", () => {
  it("works with an empty PATH, proving it spawns nothing", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: [] });
    const out = execFileSync(process.execPath, [GUARD], {
      env: { HOME: home, USERPROFILE: home, PATH: "" },
      encoding: "utf8",
      input: '{"tool_name":"Bash"}',
    });
    expect(out).toContain("deny");
  });
});

/**
 * P5-2 — the same process, invoked as a Codex hook.
 *
 * There is no Codex-specific binary and no second `decide()`. Codex CLI reads the same `tool_name`
 * off stdin and honours the same `hookSpecificOutput` payload, so these drive the real process with
 * a real Codex `PreToolUse` payload and assert the contract Codex actually enforces.
 */
describe("guard — as a real Codex hook process", () => {
  /** A Codex PreToolUse payload: canonical tool name, aliases, and its bypass permission_mode. */
  const codexInput = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      session_id: "s1",
      turn_id: "t1",
      cwd: "/tmp/project",
      permission_mode: "bypassPermissions",
      tool_name: "Bash",
      matcher_aliases: [],
      tool_use_id: "call_1",
      tool_input: { command: "echo hi" },
      ...over,
    });

  it("emits the identical deny payload Codex documents", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: [] });
    const { out, code } = run(codexInput());
    const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("120%"),
    });
    expect(code).toBe(0);
  });

  /**
   * Codex rejects `permissionDecision:deny` without a non-empty reason and then lets the call
   * through. An empty reason there is not an ugly block — it is no block.
   */
  it("never emits a deny with an empty reason", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: [] });
    const { out } = run(codexInput());
    const parsed = JSON.parse(out) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(parsed.hookSpecificOutput.permissionDecisionReason.trim()).not.toBe("");
  });

  it("honours allowTools through Codex's matcher aliases", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "deny", allowTools: ["Edit"] });
    // Codex reports apply_patch as the canonical name; Edit arrives only as an alias.
    const exempt = run(
      codexInput({ tool_name: "apply_patch", matcher_aliases: ["Edit", "Write"] }),
    );
    expect(exempt.out).toBe("");
    expect(exempt.code).toBe(0);

    const blocked = run(codexInput({ tool_name: "apply_patch", matcher_aliases: [] }));
    expect(blocked.out).toContain("deny");
  });

  /**
   * Both hosts take an exit-2 block's reason from STDERR. Claude Code reads the stdout JSON too,
   * so this was invisible there; Codex does not, so hard mode would have blocked saying nothing.
   */
  it("puts the reason on stderr in hard mode, where an exit-2 host looks for it", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "hard", allowTools: [] });
    const { out, err, code } = run(codexInput());
    expect(code).toBe(2);
    expect(err).toContain("120%");
    // ...and still on stdout, which is where Claude Code reads it.
    expect(out).toContain("deny");
  });

  it("fails open on a Codex payload it cannot parse, exactly as on Claude Code", () => {
    writeSnapshot();
    writeConfig({ enabled: true, denyAt: 1, mode: "hard", allowTools: [] });
    writeFileSync(join(home, ".daycap", "state", "today.json"), "{oops");
    const { out, code } = run(codexInput());
    expect(out).toBe("");
    expect(code).toBe(0);
  });
});
