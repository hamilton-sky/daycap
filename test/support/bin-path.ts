/**
 * Where the built CLI is, DERIVED from `package.json` rather than written down again.
 *
 * WHY THIS EXISTS, because it is a plain constant with a long comment and that always looks like
 * over-engineering until you know what it cost:
 *
 * Three test files each hardcoded `join(root, "dist", "lum.js")` and each self-skipped when that
 * path was absent — a legitimate pattern, since `pnpm test` on an unbuilt tree should not fail for
 * the wrong reason. Then the CLI was renamed to `daycap`. The build produced `dist/daycap.js`, the
 * three files went on looking for `dist/lum.js`, found nothing, and skipped.
 *
 * **Eleven tests disappeared and `pnpm verify` stayed green.** The whole of the CLI e2e suite, the
 * privacy canary gate, and the cross-process latch integration test — the three places that
 * exercise the real binary end to end. Not one of them failed. They reported success by not running.
 *
 * CI would have agreed: it builds before it tests, so the same green with the same hole.
 *
 * A conditional skip is only safe when the condition cannot silently become false for a reason
 * unrelated to what it is guarding. Hardcoding the filename made "is the tree built?" answerable by
 * "was the binary renamed?" — two different questions sharing one answer. Reading the path out of
 * the `bin` block removes the second question: rename the binary and this follows, because it is
 * the same string the package manager installs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type PackageJson = { bin?: Record<string, string>; name?: string };

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;

/**
 * The primary command's entry point, as an absolute path.
 *
 * Keyed by the package's own name, which is also the primary command — the `bin` block may carry
 * compatibility aliases (`lum` still points here), and an alias must not be able to become the
 * thing the tests measure.
 */
export const BIN: string = (() => {
  const name = pkg.name;
  const bin = pkg.bin;
  if (name === undefined || bin === undefined) {
    throw new Error(
      "package.json must declare both `name` and `bin` for the e2e suite to locate the CLI",
    );
  }
  const entry = bin[name];
  if (entry === undefined) {
    // Loud on purpose. If the primary command stops being named after the package, that is a real
    // decision and these tests need to be told which entry to follow — not left guessing.
    throw new Error(
      `package.json bin has no entry for "${name}"; the e2e suite cannot tell which command is primary. ` +
        `Entries present: ${Object.keys(bin).join(", ")}`,
    );
  }
  return isAbsolute(entry) ? entry : resolve(root, entry);
})();

/**
 * Whether the tree has actually been built.
 *
 * `pnpm verify` builds before it tests, so this is true there. A bare `pnpm test` on a fresh
 * checkout leaves it false, and the suites that need a real process skip with that written reason.
 */
export const BUILT: boolean = existsSync(BIN);

/** The reason to hand `describe.skip`, so the skip says which path it looked for. */
export const NOT_BUILT_REASON = `${BIN} does not exist — run \`pnpm build\` (or \`pnpm verify\`) first`;
