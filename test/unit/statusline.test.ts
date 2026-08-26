import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const statusline = resolve(root, "src/bin/statusline.js");

/**
 * These run in a child process on purpose. Both invariants are about what the MODULE does at load
 * time and what the PROCESS exits with — neither is observable from inside the importing test.
 */
describe("statusline.js", () => {
  it("writes nothing to stdout when merely imported", () => {
    // Regression: it used to call main() at module top level, so importing it to table-test
    // render() emitted a stray status line into the suite's output. bin/lum.ts already guarded
    // against exactly this; this file did not.
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(statusline)});`],
      { encoding: "utf8" },
    );
    expect(out).toBe("");
  });

  it("still renders and exits 0 when executed directly", () => {
    const out = execFileSync(process.execPath, [statusline], { encoding: "utf8" });
    expect(out.trim()).toBe("lum — (no source)");
  });

  it("exits 0 even when handed malformed stdin — the prompt must never break", () => {
    const out = execFileSync(process.execPath, [statusline], {
      encoding: "utf8",
      input: '{"not":"valid json',
    });
    expect(out.trim()).toBe("lum — (no source)");
  });
});
