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

/**
 * The two rules below are FUNCTIONS, not inline expressions, so that the mutation check at the
 * bottom of this file can run the real gate over a synthetic offender.
 *
 * A mutation check that re-implements the predicate it is testing proves only that the copy works.
 * These are the same two functions the live scan uses; break one and both the scan and its own
 * self-test go red together.
 */

/** Names a collector's private directory outright. The original P1-9 rule. */
function namesForbiddenPath(text: string, fragment: string): boolean {
  return code(text).includes(fragment);
}

/**
 * BUILDS a dotted home-directory name out of a variable instead of writing it.
 *
 * P5-3 needed exactly one legitimate instance of this (`markerDirFor`, so that a presence check
 * never has to spell `.cursor`). The technique is also a perfect bypass of `namesForbiddenPath`,
 * which is a literal `includes` and cannot see through a template — so it is confined to that one
 * helper and this is what keeps it there.
 */
function buildsDottedName(text: string): boolean {
  const c = code(text);
  // The dotted name must be the WHOLE string, not a fragment of a longer filename. `atomic.ts`
  // builds `.${key}.${pid}.N.tmp` — a hidden temp file inside our own state dir, which is not what
  // this rule is about, and the first draft of this regex failed the build on it. A template that
  // ENDS right after the interpolation is a directory name; one that continues is a filename.
  return /`\.\$\{[^}]*\}`/.test(c) || /["']\.["']\s*\+/.test(c);
}

const FILES = sourceFiles(SRC);

/**
 * Repo-relative path with POSIX separators.
 *
 * Windows produces `src\bin\lum.ts` where every other platform produces `src/bin/daycap.ts`, so an
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
    const offenders = FILES.filter((f) => namesForbiddenPath(readFileSync(f, "utf8"), frag));
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
      expect(namers.map(rel)).toEqual(["src/bin/daycap.ts"]);
    },
  );

  it("...and only ever joined with a settings file, never with a transcript directory", () => {
    const installer = code(readFileSync(join(SRC, "bin", "daycap.ts"), "utf8"));
    // Every allowed fragment must actually appear — otherwise this list quietly grows past what
    // the installer really needs, and the next person reads it as permission rather than record.
    for (const allowed of ALLOWED_PATHS) expect(installer).toContain(allowed);
    // The two directory names that would mean we had started reading transcripts after all.
    expect(installer).not.toContain("projects");
    expect(installer).not.toContain("sessions");
  });

  /**
   * P5-3, and the price paid for `markerDirFor` existing at all.
   *
   * `.cursor` stays forbidden above, so a presence check cannot spell it and instead derives the
   * marker from the tool's own name. That keeps the fence intact for the case it was built for —
   * reading DATA — while allowing an existence test that reads nothing. But the derivation is also
   * a hole: ``join(home, `.${"claude"}`, "projects")`` would pass the literal scan untouched.
   *
   * So the gate gets NARROWER here, not wider. Exactly one function in the codebase may build a
   * dotted name from a variable, and it is the one whose entire purpose is to express the rule.
   */
  it("only domain/surfaces.ts may build a dotted home-dir name from a variable", () => {
    const offenders = FILES.filter((f) => buildsDottedName(readFileSync(f, "utf8")));
    expect(
      offenders.map(rel),
      "a template-built dotted path is invisible to the forbidden-path scan above — " +
        "if a second module needs this, that is a design conversation, not a quiet edit",
    ).toEqual(["src/domain/surfaces.ts"]);
  });

  /**
   * ...and the list that feeds it may only name tools whose home directory we have no interest in.
   *
   * `markerDirFor("claude")` is a legal call that yields a forbidden directory. Nothing stops a
   * future edit adding `"claude"` to `UNPRICEABLE_TOOLS` and turning a presence check into a
   * doorway, so the contents of the list are fenced separately from the mechanism.
   */
  it.each(["claude", "codex", "copilot"])(
    "the unpriceable-tool list never names %s, whose marker directory holds transcripts",
    (tool) => {
      const surfaces = code(readFileSync(join(SRC, "domain", "surfaces.ts"), "utf8"));
      expect(surfaces).not.toContain(`"${tool}"`);
    },
  );

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

/**
 * The gate checking itself. House rule: mutation-test anything load-bearing.
 *
 * A green fence proves nothing on its own — it is equally consistent with "nobody broke the rule"
 * and "the rule stopped being able to see". P5-3 made that a live worry rather than a theoretical
 * one, because it introduced a legitimate way to name a directory without writing its name, and a
 * predicate that cannot see a template is a predicate that can be walked around on purpose.
 *
 * These offenders are text, never files. Writing a real violation into `src/` to watch the build
 * fail leaves a window where a crash, a `^C` or a killed runner strands the repo with a planted
 * violation — which is a bad trade for a fact that can be established exactly as well in memory.
 */
describe("gate: the fence still bites (mutation check)", () => {
  it("catches a collector's data directory named outright", () => {
    const planted = `readFileSync(join(home, ".cursor", "state.vscdb"), "utf8")`;
    expect(namesForbiddenPath(planted, ".cursor")).toBe(true);
  });

  it("catches a transcript directory reached by template — the P5-3 bypass", () => {
    const planted = 'readdirSync(join(home, `.${"claude"}`, "projects"))';
    // The ORIGINAL rule is blind to this. That is the whole reason the second rule exists, and
    // asserting the blindness is what stops someone deleting the second rule as redundant.
    expect(namesForbiddenPath(planted, ".claude/projects")).toBe(false);
    expect(buildsDottedName(planted)).toBe(true);
  });

  it("catches the string-concatenation spelling too", () => {
    expect(buildsDottedName(`join(home, "." + tool)`)).toBe(true);
  });

  it("does NOT fire on a hidden temp filename, which is what narrowed the rule", () => {
    // The real line from `atomic.ts`, kept here verbatim. The first draft of the rule failed the
    // build on it, and the fix was to require the template to END at the interpolation. Asserting
    // the real string means a future widening of the regex fails here, next to the reason, rather
    // than somewhere in the store's own suite.
    const tmp = "join(this.#dir, `.${key}.${process.pid}.${counter++}.tmp`)";
    expect(buildsDottedName(tmp)).toBe(false);
  });

  it("does not fire on an innocent file, so the rules above are not vacuously true", () => {
    const innocent = `import { join } from "node:path";\nexport const p = join(home, "config.json");`;
    expect(buildsDottedName(innocent)).toBe(false);
    for (const frag of FORBIDDEN_PATHS) expect(namesForbiddenPath(innocent, frag)).toBe(false);
  });

  it("is still blind inside a comment, because comments are stripped first", () => {
    // `ccusage.shellout.ts` explains why it does NOT read `~/.claude/projects`. A gate that fires
    // on its own rationale is a gate people delete, so this behaviour is deliberate — asserted so
    // that `code()` losing its comment stripping shows up here rather than as a mystery failure.
    expect(namesForbiddenPath(`// we never read .cursor at all`, ".cursor")).toBe(false);
  });
});
