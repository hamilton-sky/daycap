/**
 * P4-3 selection policy. Exhaustive on purpose — this is a small pure function guarding a decision
 * that, when wrong, produces a plausible number from the wrong collector. That failure is invisible
 * in every other test in the repo, because every one of them arranges exactly one source.
 *
 * The AC is "deterministic AND explained by `lum doctor`". Both halves are asserted here: the
 * choice, and the sentence — because the sentence is what doctor prints verbatim.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/domain/config.ts";
import { AUTO_ORDER, type Probe, selectSource } from "../../src/domain/source-selection.ts";
import type { Config, SourceId } from "../../src/domain/types.ts";

const cfg = (source: SourceId, sourceFile: string | null = null): Config => ({
  ...DEFAULT_CONFIG,
  source,
  sourceFile,
});

const ccusage = (available: boolean): Probe => ({
  id: "ccusage",
  configured: true,
  available,
  where: "/opt/homebrew/bin/ccusage",
});

const jsonfile = (configured: boolean, available = configured): Probe => ({
  id: "jsonfile",
  configured,
  available,
  where: configured ? "/Users/alice/usage.json" : "sourceFile is not set",
});

describe("selectSource — auto", () => {
  it("picks ccusage in the common world: no sourceFile set", () => {
    const s = selectSource(cfg("auto"), [ccusage(true), jsonfile(false)]);
    expect(s.chosen).toBe("ccusage");
    expect(s.reason).toBe("ccusage (auto)");
    expect(s.namedButMissing).toBe(false);
  });

  it("prefers jsonfile when both are usable, and SAYS what it beat", () => {
    // The order is not arbitrary: jsonfile is only ever a candidate because the user set a path,
    // which is a deliberate act, where ccusage on PATH may be there because something else
    // installed it. "Prefer the source the user chose on purpose."
    const s = selectSource(cfg("auto", "/Users/alice/usage.json"), [ccusage(true), jsonfile(true)]);
    expect(s.chosen).toBe("jsonfile");
    expect(s.reason).toContain("preferred over ccusage");
  });

  it("falls through to ccusage when a configured jsonfile does not answer", () => {
    // Under auto this is a fallback, not an error — nobody named jsonfile.
    const s = selectSource(cfg("auto", "/gone.json"), [ccusage(true), jsonfile(true, false)]);
    expect(s.chosen).toBe("ccusage");
    expect(s.namedButMissing).toBe(false);
  });

  it("reports nothing usable without calling it a naming error", () => {
    const s = selectSource(cfg("auto"), [ccusage(false), jsonfile(false)]);
    expect(s.chosen).toBeNull();
    expect(s.namedButMissing).toBe(false);
    expect(s.reason).toContain("no usable source");
    // Names what it tried. "No source" alone gives the user nothing to act on.
    expect(s.reason).toContain("ccusage");
  });

  it("never selects an unconfigured source, even one claiming to be available", () => {
    // Added because a mutation ESCAPED: deleting the `configured` check from the usable filter broke
    // nothing, since no other fixture produces `configured: false, available: true`. That state is
    // unreachable from `resolveSource` today — it short-circuits an unset path to unavailable — but
    // the check is policy, and policy that only holds because of a caller's discipline is untested
    // policy. A jsonfile with no path must stay out of the running however it answers.
    const s = selectSource(cfg("auto"), [
      ccusage(true),
      { id: "jsonfile", configured: false, available: true, where: "sourceFile is not set" },
    ]);
    expect(s.chosen).toBe("ccusage");
  });

  it("handles an empty probe list without inventing a candidate", () => {
    const s = selectSource(cfg("auto"), []);
    expect(s.chosen).toBeNull();
    expect(s.reason).toBe("no source is configured");
  });
});

describe("selectSource — naming a source disables the fallback", () => {
  it("uses the named source when it works, and says it was explicit", () => {
    const s = selectSource(cfg("ccusage"), [ccusage(true), jsonfile(true)]);
    expect(s.chosen).toBe("ccusage");
    // Distinguishes "you asked for this" from "auto found this". They are fixed differently.
    expect(s.reason).toContain("explicitly");
  });

  it("does NOT silently promote the other source when the named one is down", () => {
    // The load-bearing case. errors.ts wrote the rule before this task existed: "silently falling
    // back from the source someone chose is how you report the wrong tool's numbers without telling
    // anyone". A wrong number that looks right is worse than no number (invariant 3).
    const s = selectSource(cfg("ccusage"), [ccusage(false), jsonfile(true)]);
    expect(s.chosen).toBeNull();
    expect(s.namedButMissing).toBe(true);
  });

  it("still tells the user the other source would have worked", () => {
    // Refusing to fall back must not mean refusing to help. A broken install and a wrong config key
    // look identical from the outside and have completely different fixes.
    const s = selectSource(cfg("ccusage"), [ccusage(false), jsonfile(true)]);
    expect(s.reason).toContain("jsonfile would have worked");
    expect(s.reason).toContain("auto");
  });

  it("says so when nothing else would have worked either", () => {
    const s = selectSource(cfg("ccusage"), [ccusage(false), jsonfile(false)]);
    expect(s.reason).toContain("no other source was usable either");
  });

  it("treats jsonfile-without-a-path as not configured, not as a failure to read", () => {
    const s = selectSource(cfg("jsonfile", null), [ccusage(true), jsonfile(false)]);
    expect(s.chosen).toBeNull();
    expect(s.namedButMissing).toBe(true);
    expect(s.reason).toContain("not configured");
  });

  it("uses jsonfile when named and readable, even with ccusage sitting right there", () => {
    const s = selectSource(cfg("jsonfile", "/Users/alice/usage.json"), [
      ccusage(true),
      jsonfile(true),
    ]);
    expect(s.chosen).toBe("jsonfile");
  });
});

describe("selectSource — determinism, which is half the AC", () => {
  it("returns the identical answer across repeated calls", () => {
    const probes = [ccusage(true), jsonfile(true)];
    const a = selectSource(cfg("auto", "/x.json"), probes);
    const b = selectSource(cfg("auto", "/x.json"), probes);
    expect(a).toEqual(b);
  });

  it("does not depend on the order the probes arrive in", () => {
    // The discriminator. If the order came from the input array rather than from AUTO_ORDER, a
    // change to how `resolveSource` happens to build its list would silently change which collector
    // every user reads — and no other test in the repo would notice.
    const forward = selectSource(cfg("auto", "/x.json"), [ccusage(true), jsonfile(true)]);
    const reversed = selectSource(cfg("auto", "/x.json"), [jsonfile(true), ccusage(true)]);
    expect(reversed).toEqual(forward);
    expect(reversed.chosen).toBe("jsonfile");
  });

  it("ignores a probe for a source that is not in AUTO_ORDER", () => {
    // A stale adapter left in the probe list must not become selectable by accident.
    const ghost = { id: "budi", configured: true, available: true, where: "nowhere" };
    const s = selectSource(cfg("auto"), [
      ghost as unknown as Probe,
      ccusage(true),
      jsonfile(false),
    ]);
    expect(s.chosen).toBe("ccusage");
  });

  it("AUTO_ORDER holds every concrete source exactly once, and never `auto`", () => {
    // A source missing from this list is unreachable under auto — a silent capability loss rather
    // than a failure, so it is asserted rather than assumed.
    expect([...AUTO_ORDER]).toEqual(["jsonfile", "ccusage"]);
    expect(new Set(AUTO_ORDER).size).toBe(AUTO_ORDER.length);
    expect(AUTO_ORDER).not.toContain("auto");
  });
});
