import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILT } from "../support/bin-path.ts";

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

/**
 * Two things that only break when the tool is INSTALLED, both of which shipped broken.
 *
 * The rest of the e2e suite runs `node dist/daycap.js` by path. That is the one invocation a global
 * install never uses, and both bugs below hid in the gap.
 */
/**
 * Needs a built `dist/`, so it skips on an unbuilt tree with that written reason — the same guard
 * the three real-process suites use, via the same derived path.
 *
 * The skip is narrow on purpose. `BUILT` comes from `test/support/bin-path.ts`, which reads the path
 * out of package.json's `bin` block, so "the tree is not built" cannot quietly become "the binary
 * was renamed" — that conflation is what silently disappeared eleven tests during the rename. And
 * CI no longer relies on the skip at all: every leg, including node20-compat, now builds first.
 */
const installed = BUILT ? describe : describe.skip;

installed("gate: the tool works the way users actually install it", () => {
  it("runs when invoked through a SYMLINK, as `npm i -g` puts it on PATH", () => {
    // The bug: `npm i -g` symlinks /opt/homebrew/bin/daycap -> .../dist/daycap.js, so argv[1] is the
    // link and import.meta.url is the target. The old main-module guard compared them directly, so
    // they never matched, main() never ran, and the CLI printed NOTHING and exited 0. A total
    // failure that reported success, invisible to every test that invoked the file by its real path.
    const dir = mkdtempSync(join(tmpdir(), "daycap-symlink-"));
    try {
      const link = join(dir, "daycap");
      symlinkSync(resolve(root, "dist", "daycap.js"), link);
      const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
      expect(out.trim(), "invoked via symlink, the CLI must actually run").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the same version package.json declares", () => {
    // It said 0.0.0 while package.json said 0.1.0, so `--version` would have lied about which build
    // the user had — the single most load-bearing string in a bug report.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const out = execFileSync(process.execPath, [resolve(root, "dist", "daycap.js"), "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe(pkg.version);
  });
});

/**
 * No shipped file may put the retired product name in a string a user can see.
 *
 * Seven separate places in this codebase still said `lum` after the rename, and every one was found
 * by USING the tool: the `today` header, the help screen, the error prefix, and — worst — the
 * guard's denial reason, which is the single most important sentence this product ever writes. It
 * appears in the user's session at the moment their work is blocked, and it was telling them to run
 * a command that no longer exists.
 *
 * Comments are stripped, because explaining the history is not the same as shipping it. `guard.js`
 * and `statusline.js` cannot import CLI_NAME — the import gate limits them to four node: modules —
 * so their copies are hand-written and this is what keeps them honest.
 */
describe("gate: no shipped file speaks the retired name", () => {
  const HOT = ["statusline.js", "guard.js"];
  const strip = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it.each(HOT)("%s uses no string literal containing the old name", (file) => {
    const text = strip(readFileSync(join(root, "src", "bin", file), "utf8"));
    // Only string literals matter. A variable or identifier named `lumFoo` is invisible to users;
    // a quoted or backticked `lum` reaches their screen.
    const literals = [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
    const offenders = literals.filter((l) => /\blum\b/.test(l ?? ""));
    expect(offenders, `${file} ships a user-visible "lum"`).toEqual([]);
  });

  it("the built bundle does not either", () => {
    const text = strip(readFileSync(join(root, "dist", "daycap.js"), "utf8"));
    const literals = [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
    expect(literals.filter((l) => /\blum\b/.test(l ?? ""))).toEqual([]);
  });
});
