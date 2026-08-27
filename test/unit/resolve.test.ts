/**
 * `resolveSource` — the probing half of P4-3, plus `UnavailableSource`.
 *
 * The policy is exhausted in source-selection.test.ts. What is asserted here is the wiring: that a
 * real jsonfile path is probed, that an unset one is reported as unconfigured rather than broken,
 * and that "nothing was selected" reaches `app/` through the existing source-is-down channel rather
 * than as a new shape.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSource, UnavailableSource } from "../../src/adapters/source/resolve.ts";
import { DEFAULT_CONFIG } from "../../src/domain/config.ts";
import { SourceUnavailableError } from "../../src/domain/errors.ts";
import type { Config, SourceId } from "../../src/domain/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function usageFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lum-resolve-"));
  dirs.push(dir);
  const path = join(dir, "usage.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      entries: [{ at: "2026-08-21T09:00:00.000Z", tool: "claude-code", usd: 1 }],
    }),
    "utf8",
  );
  return path;
}

const cfg = (source: SourceId, sourceFile: string | null = null): Config => ({
  ...DEFAULT_CONFIG,
  source,
  sourceFile,
});

describe("resolveSource — probing", () => {
  it("reports jsonfile as unconfigured, not unavailable, when no path is set", async () => {
    // The distinction matters on the doctor screen: unconfigured renders as `·`, not `✗`, because
    // a source the user never asked for is not a fault to go hunting.
    const r = await resolveSource(cfg("auto"));
    const jf = r.probes.find((p) => p.id === "jsonfile");
    expect(jf?.configured).toBe(false);
    expect(jf?.where).toContain("sourceFile is not set");
  });

  it("probes a real file and selects it under auto", async () => {
    const r = await resolveSource(cfg("auto", usageFile()));
    expect(r.probes.find((p) => p.id === "jsonfile")?.available).toBe(true);
    expect(r.selection.chosen).toBe("jsonfile");
    expect(r.source).not.toBeNull();
  });

  it("actually reads through the selected source", async () => {
    const r = await resolveSource(cfg("jsonfile", usageFile()));
    const rows = await r.source?.spendFor({
      from: "2026-08-21T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      tz: "UTC",
    });
    expect(rows).toEqual([{ tool: "claude-code", usd: 1, imputed: false }]);
  });

  it("reports a configured-but-missing file as unavailable", async () => {
    const r = await resolveSource(cfg("auto", "/nonexistent/usage.json"));
    const jf = r.probes.find((p) => p.id === "jsonfile");
    expect(jf?.configured).toBe(true);
    expect(jf?.available).toBe(false);
  });

  it("returns no source, and flags it, when a named source cannot be reached", async () => {
    const r = await resolveSource(cfg("jsonfile", "/nonexistent/usage.json"));
    expect(r.source).toBeNull();
    expect(r.selection.namedButMissing).toBe(true);
  });

  it("probes every candidate exactly once, in AUTO_ORDER for the doctor ladder", async () => {
    const r = await resolveSource(cfg("auto", usageFile()));
    expect(r.probes.map((p) => p.id).sort()).toEqual(["ccusage", "jsonfile"]);
  });

  it("killInFlight is safe to call for a source that spawns nothing", async () => {
    const r = await resolveSource(cfg("jsonfile", usageFile()));
    expect(() => r.killInFlight()).not.toThrow();
  });
});

describe("UnavailableSource — a selection failure arrives as a source being down", () => {
  const s = new UnavailableSource("auto", ["ccusage: nowhere", "jsonfile: unset"]);

  it("is never available", async () => {
    await expect(s.available()).resolves.toBe(false);
  });

  it("REJECTS rather than resolving [] — an empty array means a confirmed zero", async () => {
    // The whole reason this class exists rather than a `source === null` branch in buildSnapshot:
    // "no source could be selected" and "the source did not answer" want identical handling, and
    // the second already has nine mutation-verified rows of it.
    await expect(s.spendFor()).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("carries where it looked, so doctor can say what was tried", async () => {
    await expect(s.spendFor()).rejects.toThrow(/ccusage: nowhere/);
  });

  it("reports no freshness watermark instead of throwing", async () => {
    await expect(s.freshness()).resolves.toEqual({ lastUpdatedUtc: null });
  });
});
