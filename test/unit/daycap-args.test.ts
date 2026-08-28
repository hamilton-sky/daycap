import { describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../../src/bin/daycap.ts";
import { CLI_NAME, LEGACY_CLI_NAME } from "../../src/domain/brand.ts";

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

/**
 * The help text, pinned to the same constants as the router.
 *
 * NOTHING ASSERTED IT, so after the rename `daycap --help` printed a `lum` usage block that also
 * omitted the `config` command entirely — a help screen advertising a command name that no longer
 * exists and hiding one that does. It is the first thing a new user reads.
 *
 * This is the fourth thing this session that only using the tool revealed, after the `lum` table
 * header, the eleven silently skipped tests, and the CLI that did nothing when installed. The
 * pattern: this suite is strong on logic it was pointed at and blind to the seams — output text,
 * the shell, the filesystem.
 */
describe("USAGE — the help screen", () => {
  it("names the current CLI and never the retired one", () => {
    expect(USAGE).toContain(CLI_NAME);
    expect(USAGE).not.toContain(LEGACY_CLI_NAME);
  });

  it("advertises every command the router actually accepts", () => {
    // A command missing here is a feature nobody discovers; a command listed here that the router
    // rejects is worse. Both directions asserted against one list.
    for (const cmd of ["today", "doctor", "config", "refresh", "install"]) {
      expect(USAGE, `help must mention \`${cmd}\``).toContain(`${CLI_NAME} ${cmd}`);
      expect(parseArgs([cmd]).command, `router must accept \`${cmd}\``).toBe(cmd);
    }
  });

  it("stays inside 80 columns, since it is read in a terminal", () => {
    for (const line of USAGE.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
});
