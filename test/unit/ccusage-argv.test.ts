import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CcusageSource, toolForModel } from "../../src/adapters/source/ccusage.shellout.ts";
import { usageDayRange } from "../../src/domain/window.ts";
import { FAKE_BIN } from "../contract/ccusage.harness.ts";

/**
 * The argv the adapter actually emits.
 *
 * This is the discriminating half of C14b, which the contract harness skips: mutating TZ
 * in-process cannot make the contract's result-comparison fail, because the adapter takes its
 * zone from `window.tz`. Asserting the emitted `--since`/`--until` CAN fail — if anyone ever
 * reaches for `process.env.TZ` or drops the -1 ms, these break loudly.
 */

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lum-argv-"));
  log = join(dir, "argv.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sourceLogging(): CcusageSource {
  return new CcusageSource({
    resolveBinary: () => ({
      command: process.execPath,
      prefixArgs: [FAKE_BIN, `--fake-argv-log=${log}`],
    }),
  });
}

function emitted(): string[] {
  return JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop() as string) as string[];
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

describe("ccusage argv", () => {
  it("converts half-open [from,to) to an INCLUSIVE --until via the -1ms rule", async () => {
    // One usage day, UTC: [2026-08-21T00:00Z, 2026-08-22T00:00Z).
    const w = usageDayRange("2026-08-21", 0, "UTC");
    await sourceLogging().spendFor(w);
    const argv = emitted();
    expect(flag(argv, "--since")).toBe("20260821");
    // 20260822 here would bleed an entire extra calendar day into every single query.
    expect(flag(argv, "--until")).toBe("20260821");
  });

  it("spans a multi-day window without over-reaching at the top end", async () => {
    await sourceLogging().spendFor({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-23T00:00:00.000Z",
      tz: "UTC",
    });
    const argv = emitted();
    expect(flag(argv, "--since")).toBe("20260820");
    expect(flag(argv, "--until")).toBe("20260822");
  });

  it("uses the window's zone, not the host's — a UTC+3 day is not a UTC day", async () => {
    // 2026-08-21 in Asia/Jerusalem starts at 2026-08-20T21:00Z. A UTC reading of `from` would
    // emit 20260820; the window's own zone must give 20260821.
    const w = usageDayRange("2026-08-21", 0, "Asia/Jerusalem");
    expect(w.from).toBe("2026-08-20T21:00:00.000Z");
    await sourceLogging().spendFor(w);
    const argv = emitted();
    expect(flag(argv, "--since")).toBe("20260821");
    expect(flag(argv, "--until")).toBe("20260821");
  });

  it("emits identical dates regardless of the ambient TZ (the real C14b)", async () => {
    const w = usageDayRange("2026-08-21", 0, "UTC");
    const original = process.env.TZ;
    const seen: string[][] = [];
    try {
      for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Niue"]) {
        process.env.TZ = tz;
        await sourceLogging().spendFor(w);
        seen.push(emitted());
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    const dates = seen.map((a) => [flag(a, "--since"), flag(a, "--until")]);
    // +14 and -11 straddle two calendar days. Ambient TZ must not move the window.
    expect(dates[1]).toEqual(dates[0]);
    expect(dates[2]).toEqual(dates[0]);
  });

  it("survives a DST spring-forward day without losing or gaining a date", async () => {
    const w = usageDayRange("2026-03-08", 0, "America/New_York"); // 23-hour day
    await sourceLogging().spendFor(w);
    const argv = emitted();
    expect(flag(argv, "--since")).toBe("20260308");
    expect(flag(argv, "--until")).toBe("20260308");
  });

  it("always passes --offline and never invokes npx", async () => {
    await sourceLogging().spendFor(usageDayRange("2026-08-21", 0, "UTC"));
    const argv = emitted();
    expect(argv).toContain("--offline");
    expect(argv).toContain("--json");
    expect(argv[0]).toBe("daily");
    // npx would be a non-loopback network call, which P1-9's gate fails the build for.
    expect(argv.join(" ")).not.toContain("npx");
    // The second command the plan called for would double-count Codex. It must not exist.
    expect(argv).not.toContain("codex");
  });
});

describe("toolForModel", () => {
  it.each([
    ["claude-opus-5", "claude-code"],
    ["claude-haiku-4-5-20251001", "claude-code"],
    ["gpt-5.6-terra", "codex"],
    ["o3-mini", "codex"],
  ])("%s -> %s", (model, tool) => {
    expect(toolForModel(model)).toBe(tool);
  });

  it("passes an unknown model through verbatim rather than dropping it (C6)", () => {
    expect(toolForModel("weird-tool-9000")).toBe("weird-tool-9000");
  });

  it("normalises syntactically so C6's shape assertions hold", () => {
    expect(toolForModel("  Some_Odd Model ")).toBe("some-odd-model");
  });
});
