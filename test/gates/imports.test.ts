import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gate 1 of 3 — the import boundary. Lands in P1 and stays green forever.
 *
 * ADR-v2-001 is the single decision the whole v2 design rests on: **we consume a collector, we do
 * not parse logs.** That decision is one careless import away from being undone, and the undoing
 * would look reasonable in review — "just read the transcript to fill in the gap".
 *
 * So the fence is a test rather than a convention. If `src/` ever reaches for a transcript
 * watcher, a JSONL file, or a CLI's private data directory, the build fails and someone has to
 * argue for it deliberately.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(root, "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Comments are stripped before scanning.
 *
 * Without this the gate fires on its own rationale: `ccusage.shellout.ts` explains why it does NOT
 * read `~/.claude`, and a gate that forbids explaining itself is a gate people delete.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles(SRC);

/**
 * Repo-relative path with POSIX separators.
 *
 * Windows produces `src\bin\lum.ts` where every other platform produces `src/bin/lum.ts`, so an
 * assertion naming a path fails there for a reason that has nothing to do with the rule. Every
 * comparison in this file goes through here.
 */
const rel = (f: string): string => relative(root, f).split(sep).join("/");

/** Modules that only make sense if you are watching or parsing transcripts yourself. */
const FORBIDDEN_MODULES = [
  "node:readline",
  "readline",
  "chokidar",
  "node-watch",
  "tail",
  "fs-extra",
];

/**
 * Transcript and usage DATA belonging to the CLIs we measure. Reading it IS parsing.
 *
 * Note what is forbidden and what is not. `~/.claude/projects` holds transcripts — off limits,
 * that is the whole of ADR-v2-001. `~/.claude/settings.json` is the user's CONFIGURATION, and
 * `lum install` writes to it on an explicit `--write`; forbidding that would forbid the installer.
 *
 * This distinction was NOT in the original list, and this gate is what forced it into the open:
 * it failed on `lum.ts` the moment the installer landed. The narrow allowance below is the point
 * — "never touch .claude" was the wrong rule, stated too broadly, and would have been loosened
 * carelessly under deadline if the gate had not made someone write down why.
 */
const FORBIDDEN_PATHS = [".claude/projects", ".codex/sessions", ".cursor", ".copilot", ".jsonl"];

/**
 * The paths under a CLI's directory we may touch, and only to write the user's own settings.
 *
 * WHY THIS GREW IN P5-2, written down here because the house rule is that a gate is never loosened
 * quietly: `lum install --codex` writes `~/.codex/hooks.json`. That is the SAME data-vs-config
 * distinction this gate already forced into the open for `.claude` — `hooks.json` is configuration
 * the user owns and we edit on an explicit `--write`, whereas `.codex/sessions` is transcript data
 * and stays forbidden above, for every file, with no exception.
 *
 * What is deliberately NOT loosened: the one-file rule below. Exactly one module may name either
 * directory. If a second ever needs to, that is a design conversation, not a quiet edit.
 */
const ALLOWED_PATHS = [".claude", ".codex", "settings.json", "hooks.json"];

describe("gate: import boundary (ADR-v2-001 — never parse a log file)", () => {
  it("finds source files to check", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN_MODULES)("no file under src/ imports %s", (mod) => {
    const offenders = FILES.filter((f) => {
      const c = code(readFileSync(f, "utf8"));
      return new RegExp(`(from|require\\()\\s*["'\`]${mod.replace(".", "\\.")}["'\`]`).test(c);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it.each(FORBIDDEN_PATHS)("no file under src/ references the path fragment %s", (frag) => {
    const offenders = FILES.filter((f) => code(readFileSync(f, "utf8")).includes(frag));
    expect(
      offenders.map(rel),
      `${frag} belongs to a collector's private data. Consuming a collector means asking it, not reading its files.`,
    ).toEqual([]);
  });

  it.each([".claude", ".codex"])(
    "the settings allowance is narrow — only the installer may name %s at all",
    (dir) => {
      const namers = FILES.filter((f) => code(readFileSync(f, "utf8")).includes(dir));
      // If a second file ever needs this, that is a design conversation, not a quiet edit.
      expect(namers.map(rel)).toEqual(["src/bin/lum.ts"]);
    },
  );

  it("...and only ever joined with a settings file, never with a transcript directory", () => {
    const installer = code(readFileSync(join(SRC, "bin", "lum.ts"), "utf8"));
    // Every allowed fragment must actually appear — otherwise this list quietly grows past what
    // the installer really needs, and the next person reads it as permission rather than record.
    for (const allowed of ALLOWED_PATHS) expect(installer).toContain(allowed);
    // The two directory names that would mean we had started reading transcripts after all.
    expect(installer).not.toContain("projects");
    expect(installer).not.toContain("sessions");
  });

  it("nothing under src/ imports from test/", () => {
    const offenders = FILES.filter((f) =>
      /(from|require\()\s*["'`][^"'`]*\btest\//.test(code(readFileSync(f, "utf8"))),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("src/domain stays pure — no node: imports at all", () => {
    const domain = FILES.filter((f) => f.includes(join("src", "domain")));
    expect(domain.length).toBeGreaterThan(3);
    const offenders = domain.filter((f) => /["'`]node:/.test(code(readFileSync(f, "utf8"))));
    expect(offenders.map(rel)).toEqual([]);
  });

  /**
   * The hot path: files Claude Code executes as part of a turn, not files the user runs.
   *
   * `statusline.js` runs on every prompt — every extra import is latency paid per render.
   * `guard.js` is stricter still: a timed-out hook does NOT block ("you shouldn't count on a
   * stalled hook to act as a gate"), so a slow guard is an ABSENT guard. Anything beyond these
   * four modules would mean either had stopped being a thin cache reader.
   */
  const HOT_PATH = ["statusline.js", "guard.js"];
  const ALLOWED = new Set(["node:fs", "node:os", "node:path", "node:url"]);

  it.each(HOT_PATH)("%s imports node:fs/os/path/url — and nothing else", (file) => {
    const text = code(readFileSync(join(SRC, "bin", file), "utf8"));
    const imports = [...text.matchAll(/from\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(ALLOWED);
  });

  it.each(HOT_PATH)("%s spawns nothing — it reads a cache, it does not ask a collector", (file) => {
    const text = code(readFileSync(join(SRC, "bin", file), "utf8"));
    for (const banned of ["child_process", "node:net", "node:http", "execFile", "spawn("]) {
      expect(text, `${file} must not reference ${banned}`).not.toContain(banned);
    }
  });
});
