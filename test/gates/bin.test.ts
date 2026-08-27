import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gate: every path declared in package.json `bin` must actually exist after a build, and must
 * start with a shebang.
 *
 * This existed as a real defect: `bin.lum` pointed at `./dist/bin/lum.js` while tsdown flattens
 * its entry to `dist/lum.js`, AND `src/bin/daycap.ts` carried no shebang — so `npm i -g` installed a
 * binary that was both missing and non-executable. Nothing caught it, because `pnpm verify` never
 * exercised the bin and the package is `private: true`.
 *
 * The same class of bug bit `src/bin/statusline.js`, which shipped with a shebang but mode 644 —
 * so invoking it directly (exactly how Claude Code's `statusLine.command` calls it) died with
 * EACCES. npm chmods bin targets on install, which is precisely why this stayed invisible to
 * anyone testing via a package install rather than from a checkout.
 *
 * `pnpm verify` builds before it tests, so in CI the dist assertions always run. A bare
 * `pnpm test` on an unbuilt tree skips them rather than failing spuriously.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
};
const entries = Object.entries(pkg.bin);

describe("package.json bin", () => {
  it("declares at least one binary", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s -> %s exists and is executable by the shell", (_name, relPath) => {
    const abs = resolve(root, relPath);
    const isBuilt = relPath.startsWith("./dist/") || relPath.startsWith("dist/");

    if (isBuilt && !existsSync(resolve(root, "dist"))) {
      // Unbuilt tree (bare `pnpm test`). `pnpm verify` builds first, so CI still enforces this.
      return;
    }

    expect(existsSync(abs), `${relPath} does not exist — run \`pnpm build\``).toBe(true);
    expect(
      readFileSync(abs, "utf8").startsWith("#!"),
      `${relPath} has no shebang, so npm would install a non-executable binary`,
    ).toBe(true);

    // Windows has no POSIX mode bits; git stores 100644/100755 and npm chmods on install, but a
    // direct invocation from a checkout (a statusLine command) needs the bit set in the tree.
    if (process.platform !== "win32") {
      const mode = statSync(abs).mode;
      expect(
        (mode & 0o111) !== 0,
        `${relPath} is not executable (mode ${(mode & 0o777).toString(8)}); ` +
          "run `git update-index --chmod=+x` on it",
      ).toBe(true);
    }
  });

  it.each(entries)("%s -> %s is covered by the `files` allowlist", (_name, relPath) => {
    const normalized = relPath.replace(/^\.\//, "");
    const covered = pkg.files.some((f) => normalized === f || normalized.startsWith(`${f}/`));
    expect(covered, `${relPath} is not in package.json files[]; it would not be published`).toBe(
      true,
    );
  });
});
