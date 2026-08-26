import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

/** Modules that only make sense if you are watching or parsing transcripts yourself. */
const FORBIDDEN_MODULES = [
  "node:readline",
  "readline",
  "chokidar",
  "node-watch",
  "tail",
  "fs-extra",
];

/** Private data directories belonging to the CLIs we measure. Reading them IS parsing. */
const FORBIDDEN_PATHS = [".claude", ".codex", ".cursor", ".copilot", ".jsonl"];

describe("gate: import boundary (ADR-v2-001 — never parse a log file)", () => {
  it("finds source files to check", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN_MODULES)("no file under src/ imports %s", (mod) => {
    const offenders = FILES.filter((f) => {
      const c = code(readFileSync(f, "utf8"));
      return new RegExp(`(from|require\\()\\s*["'\`]${mod.replace(".", "\\.")}["'\`]`).test(c);
    });
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it.each(FORBIDDEN_PATHS)("no file under src/ references the path fragment %s", (frag) => {
    const offenders = FILES.filter((f) => code(readFileSync(f, "utf8")).includes(frag));
    expect(
      offenders.map((f) => relative(root, f)),
      `${frag} belongs to a collector's private data. Consuming a collector means asking it, not reading its files.`,
    ).toEqual([]);
  });

  it("nothing under src/ imports from test/", () => {
    const offenders = FILES.filter((f) =>
      /(from|require\()\s*["'`][^"'`]*\btest\//.test(code(readFileSync(f, "utf8"))),
    );
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it("src/domain stays pure — no node: imports at all", () => {
    const domain = FILES.filter((f) => f.includes(join("src", "domain")));
    expect(domain.length).toBeGreaterThan(3);
    const offenders = domain.filter((f) => /["'`]node:/.test(code(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it("statusline.js imports node:fs, node:os, node:path and node:url — and nothing else", () => {
    // It runs on every prompt. Every extra import is latency the user pays per keystroke-ish, and
    // anything beyond these four would mean it had stopped being a thin cache reader.
    const text = code(readFileSync(join(SRC, "bin", "statusline.js"), "utf8"));
    const imports = [...text.matchAll(/from\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(["node:fs", "node:os", "node:path", "node:url"]));
  });
});
