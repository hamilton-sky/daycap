#!/usr/bin/env node
/**
 * Claude Code statusline renderer.
 *
 * Three invariants, all of them correctness rather than style. P3 fills in the rendering; these
 * hold from the first commit:
 *
 *  1. **Always exit 0.** A non-zero exit here breaks the user's prompt. Every fault path renders a
 *     degraded string instead.
 *  2. **`node:fs` only.** No network, no child process, no dependency on the collector. It reads a
 *     cached snapshot that `lum` wrote; it never queries a daemon. A test/gates enforcement
 *     test is PLANNED in P1-9 and does not exist yet.
 *  3. **Never invent a number.** No snapshot, or a stale one, renders `lum — (no source)` — never
 *     `$0.00`. (DoD #3.)
 *
 * Plain JS, not TypeScript, and unbundled: this runs on every prompt, so it must not pay a bundler
 * or a transpile step. Note the measured floor — Node's own cold start is ~40 ms, already above
 * P3's <30 ms p95 target, which is why that criterion needs restating as "excluding interpreter
 * start". See SPIKE_RESULT.md §6.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NO_SOURCE = "lum — (no source)";
const SNAPSHOT = join(homedir(), ".localusagemeter", "state", "today.json");

/** Reads the snapshot. Returns null on any fault — missing, unreadable, truncated, or wrong shape. */
function readSnapshot(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    if (parsed.schema !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Renders the status row. Pure, so P3 can table-test every degradation state.
 * @param snapshot parsed snapshot or null
 */
export function render(snapshot) {
  if (snapshot === null) return NO_SOURCE;
  // P3 replaces this with the DESIGN.md §5 formats (rate-limit primary, pacing glyph, colour).
  // Until then it renders nothing rather than a number it cannot justify.
  return NO_SOURCE;
}

function main() {
  let line = NO_SOURCE;
  try {
    line = render(readSnapshot(SNAPSHOT));
  } catch {
    line = NO_SOURCE;
  }
  process.stdout.write(`${line}\n`);
}

try {
  main();
} catch {
  // Invariant 1: the prompt must never break.
  process.stdout.write(`${NO_SOURCE}\n`);
}
process.exitCode = 0;
