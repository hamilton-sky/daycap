import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The CONSTANT, not a copy of its text. The rename to `daycap` broke these two assertions precisely
// because they held a literal; asserting against the export means the next rename does not.
import { NO_SOURCE } from "../../src/bin/statusline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const statusline = resolve(root, "src/bin/statusline.js");

/**
 * These run in a child process on purpose. Both invariants are about what the MODULE does at load
 * time and what the PROCESS exits with — neither is observable from inside the importing test.
 */
/**
 * Every case runs against a temp HOME.
 *
 * These originally leaked the developer's real home directory, and passed only because render()
 * was a stub that ignored its input. The moment render() became real they failed — correctly —
 * by picking up an actual snapshot. A test whose result depends on whose machine it runs on is
 * not a test.
 */
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lum-sl-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" });

describe("statusline.js", () => {
  it("writes nothing to stdout when merely imported", () => {
    // Regression: it used to call main() at module top level, so importing it to table-test
    // render() emitted a stray status line into the suite's output. bin/lum.ts already guarded
    // against exactly this; this file did not.
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        // pathToFileURL, not the bare path: Windows absolute paths ("D:\\...") are not valid ESM
        // specifiers and fail with ERR_UNSUPPORTED_ESM_URL_SCHEME.
        `await import(${JSON.stringify(pathToFileURL(statusline).href)});`,
      ],
      { encoding: "utf8", env: env() },
    );
    expect(out).toBe("");
  });

  it("still renders and exits 0 when executed directly", () => {
    const out = execFileSync(process.execPath, [statusline], { encoding: "utf8", env: env() });
    expect(out.trim()).toBe(NO_SOURCE);
  });

  it("exits 0 even when handed malformed stdin — the prompt must never break", () => {
    const out = execFileSync(process.execPath, [statusline], {
      encoding: "utf8",
      env: env(),
      input: '{"not":"valid json',
    });
    expect(out.trim()).toBe(NO_SOURCE);
  });
});
