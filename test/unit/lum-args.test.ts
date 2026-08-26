import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/bin/lum.ts";

/**
 * Argument routing is pure and exported so it can be tested without spawning a process. The
 * commands themselves land in P1-8 / P2 / P4-5; this pins the routing and the default.
 */
describe("parseArgs", () => {
  it("defaults to `today` with no arguments", () => {
    expect(parseArgs([])).toEqual({ command: "today" });
  });

  it.each(["today", "doctor", "refresh"])("routes %s", (cmd) => {
    expect(parseArgs([cmd])).toEqual({ command: cmd });
  });

  it.each(["-v", "--version"])("routes %s to version", (flag) => {
    expect(parseArgs([flag])).toEqual({ command: "version" });
  });

  it.each(["-h", "--help"])("routes %s to help", (flag) => {
    expect(parseArgs([flag])).toEqual({ command: "help" });
  });

  it("reports an unknown command rather than guessing", () => {
    expect(parseArgs(["tody"])).toEqual({ command: "help", unknown: "tody" });
  });

  it("ignores trailing arguments for now (P1-8 adds flags)", () => {
    expect(parseArgs(["today", "--json"])).toEqual({ command: "today" });
  });
});
