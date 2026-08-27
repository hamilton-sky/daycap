import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The constant, not its text: a literal here is what made the rename break these two cases.
import { NO_SOURCE } from "../../src/bin/statusline.js";
// BIN is derived from package.json, not written down here — see the module for why.
import { BIN, BUILT } from "../support/bin-path.ts";

/**
 * The real binary, as a real process.
 *
 * Everything else tests `renderToday` against constructed snapshots; this is the only place the
 * composition root itself runs. It asserts the invariant that matters most for a tool other
 * programs shell out to: `daycap today` exits 0 in every state.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daycap-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(env: NodeJS.ProcessEnv = {}): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [BIN, "today"], {
      encoding: "utf8",
      env: { HOME: home, USERPROFILE: home, PATH: "", ...env },
      timeout: 20_000,
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}

// `pnpm verify` builds before it tests. A bare `pnpm test` on an unbuilt tree skips these.
const maybe = BUILT ? describe : describe.skip;

maybe("daycap today — as a process", () => {
  it("renders (no source) and still exits 0 when no collector can be found", () => {
    // PATH is empty, so tier 3 resolution finds nothing and tier 2 is not installed here.
    const { out, code } = run();
    expect(code).toBe(0);
    expect(out.trim()).toBe(NO_SOURCE);
    // The rule that outranks everything.
    expect(out).not.toContain("$0.00");
  });

  it("exits 0 with a malformed config rather than refusing to start", () => {
    mkdirSync(join(home, ".daycap"), { recursive: true });
    writeFileSync(join(home, ".daycap", "config.json"), "{ not json at all");
    const { out, code } = run();
    expect(code).toBe(0);
    expect(out.trim()).toBe(NO_SOURCE);
  });

  it("does not create a cache file when it has nothing worth caching", () => {
    run();
    expect(existsSync(join(home, ".daycap", "state", "today.json"))).toBe(false);
  });

  it("reports an unknown subcommand on stderr with exit 2, leaving stdout clean", () => {
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [BIN, "tody"], {
        encoding: "utf8",
        env: { HOME: home },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      stdout = err.stdout ?? "";
    }
    expect(code).toBe(2);
    expect(stdout).toBe("");
  });

  it("--version and --help exit 0", () => {
    for (const flag of ["--version", "--help"]) {
      const out = execFileSync(process.execPath, [BIN, flag], {
        encoding: "utf8",
        env: { HOME: home },
      });
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
