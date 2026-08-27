/**
 * `lum doctor` rendering. PURE — takes facts, returns 80-column lines.
 *
 * The job is not "print state". It is to answer, in one screen, the only question a user has when
 * the number looks wrong: **why**. That means naming what was looked for and WHERE — "ccusage not
 * found" sends someone to a search engine; "looked for @ccusage/ccusage-darwin-arm64 in
 * node_modules, then ccusage on PATH — neither present" tells them what to install.
 *
 * No colour unless `--color`. This output gets pasted into issues.
 */

import type { Config, UsageSnapshot } from "../../domain/types.ts";
import type { ResolutionAttempt } from "../source/ccusage.shellout.ts";

export const WIDTH = 80;

export type DoctorFacts = {
  /** The user's home directory, so paths can be abbreviated to `~` before printing. */
  home: string;
  sourceId: string;
  attempts: readonly ResolutionAttempt[];
  available: boolean;
  snapshot: UsageSnapshot | null;
  snapshotAgeSeconds: number | null;
  latch: { present: boolean; recovered: boolean; firedToday: readonly string[] };
  config: Config;
  configPath: string;
  configWarnings: readonly string[];
  /** Present only when the statusline has recorded a rate-limit reading. */
  echoSeen: { fiveHourPct?: number; sevenDayPct?: number; ageSeconds: number } | null;
  /**
   * Tools found installed that can never be priced from disk (P5-3, `domain/surfaces.ts`).
   *
   * Detected, not configured — so an empty array means "none present", never "not checked".
   */
  unpriceableFound: readonly string[];
  /**
   * Which source won and why (P4-3, `domain/source-selection.ts`).
   *
   * The `reason` string is printed VERBATIM rather than reconstructed here. The AC asks for a
   * choice that is deterministic and explained; if the renderer paraphrased the policy, the
   * explanation could drift from the decision, and an explanation that no longer matches the
   * decision is worse than none.
   */
  selection: { chosen: string | null; reason: string; namedButMissing: boolean };
  /** Every candidate that was probed, in the order `auto` walks them. */
  probes: readonly { id: string; configured: boolean; available: boolean; where: string }[];
};

const OK = "✓";
const WARN = "⚠";
const BAD = "✗";

/**
 * Abbreviate the home directory to `~`.
 *
 * This output is written to be pasted into issues, which makes the username in an absolute path a
 * privacy leak by default — the same ADR-v2-004 concern as the notification argv, just on a
 * surface nobody thinks of as user data. It also buys back the columns that were truncating the
 * config line mid-word.
 */
export function tildify(path: string, home: string): string {
  return home.length > 0 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Truncate at a word boundary with an ellipsis rather than mid-word.
 *
 * Named `clip`, not `fit`: `fit` is Jasmine's focused-test function, and biome's noFocusedTests
 * rule reads a bare `clip(...)` call as a test someone left focused by accident. A lint rule that
 * fires on a legitimate name is annoying; a lint rule silenced with an ignore comment is one that
 * stops catching the real thing.
 */
function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  const cut = text.slice(0, width - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > width * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Wrap prose across continuation lines instead of clipping it.
 *
 * `clip` is right for a PATH — there is no useful word boundary and the head identifies it. It is
 * wrong for a sentence whose remedy is at the END: the P4-3 selection reason finishes with "jsonfile
 * would have worked — set source to it, or \"auto\"", and clipping deletes exactly the half the
 * reader needs. Found by a test asserting the remedy was present, which failed on the clip.
 */
function wrapped(label: string, mark: string, text: string): string[] {
  const prefix = `  ${label.padEnd(10)} ${mark} `;
  const width = WIDTH - prefix.length;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  // A single word longer than the row still has to give — clip that one rather than overflow.
  return lines.map((l, i) =>
    i === 0 ? prefix + clip(l, width) : `               ${clip(l, WIDTH - 15)}`,
  );
}

function row(label: string, mark: string, text: string): string {
  const prefix = `  ${label.padEnd(10)} ${mark} `;
  return prefix + clip(text, WIDTH - prefix.length);
}

function humanAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * R1's remedy. It belongs here rather than in a README because this is where someone is standing
 * when they need it.
 */
export const REMEDY = [
  "  To fix: install a collector, then run `lum doctor` again.",
  "    npm i -g ccusage@20      # Claude Code + Codex, zero config",
  "  Then `lum install` to wire up the statusline and the refresh hook.",
];

export function renderDoctor(facts: DoctorFacts): { lines: string[]; exitCode: number } {
  const lines: string[] = ["lum doctor"];

  // --- source: one line per rung of the ladder, named and located -----------------------------
  if (facts.available) {
    const hit = facts.attempts.find((a) => a.found);
    const at = tildify(hit?.detail ?? hit?.where ?? "resolved", facts.home);
    lines.push(row("source", OK, `${facts.sourceId} (${at})`));
  } else if (facts.selection.chosen === null) {
    // P4-3. Nothing was selected, so there is no per-tier ladder to print — and printing the
    // candidates here would DUPLICATE the `selected` block below, which owns that list and marks it
    // accurately. The first version did print them, and marked an available ccusage as `✗ not
    // found` two lines above the same probe showing `✓`. A diagnostic contradicting itself on one
    // screen is worse than one that says less.
    lines.push(row("source", BAD, "none selected — see `selected` below"));
  } else {
    lines.push(row("source", BAD, `${facts.sourceId} not found. Looked for:`));
    for (const a of facts.attempts) {
      lines.push(
        clip(`               ${a.found ? OK : BAD} ${tildify(a.where, facts.home)}`, WIDTH),
      );
    }
  }

  // --- selection: which source, and why it and not the other one -------------------------------
  // P4-3. Printed whenever the answer is not obvious: more than one candidate was configured, or
  // nothing was chosen at all. With a lone ccusage and no sourceFile there is nothing to explain,
  // and a permanent "auto chose the only option" line is the kind of noise that stops the rest of
  // this screen being read.
  const candidates = facts.probes.filter((p) => p.configured);
  if (candidates.length > 1 || facts.selection.chosen === null) {
    lines.push(
      ...wrapped("selected", facts.selection.chosen === null ? BAD : OK, facts.selection.reason),
    );
    for (const p of facts.probes) {
      const mark = !p.configured ? "·" : p.available ? OK : BAD;
      lines.push(clip(`               ${mark} ${p.id} — ${tildify(p.where, facts.home)}`, WIDTH));
    }
  }

  // --- freshness --------------------------------------------------------------------------------
  if (facts.snapshot === null || facts.snapshotAgeSeconds === null) {
    lines.push(row("snapshot", BAD, "none — nothing has been cached yet"));
  } else {
    const age = facts.snapshotAgeSeconds;
    // 15 min matches the statusline's own stale threshold family; the collector watermark below
    // is a different axis and is reported separately rather than folded in.
    lines.push(
      row("snapshot", age > 900 ? WARN : OK, `${humanAge(age)} (${facts.snapshot.usageDay})`),
    );
    const watermark = facts.snapshot.sourceLastUpdatedUtc;
    lines.push(
      row(
        "collector",
        OK,
        watermark === null
          ? "exposes no freshness watermark of its own"
          : `data as of ${watermark}`,
      ),
    );
  }

  // --- tools: covered vs configured ------------------------------------------------------------
  const configured = facts.config.tools;
  const seen = facts.snapshot?.tools.map((t) => t.tool) ?? [];
  if (configured.includes("*")) {
    lines.push(
      row(
        "tools",
        seen.length > 0 ? OK : WARN,
        seen.length > 0 ? seen.join(", ") : "none reported",
      ),
    );
  } else {
    const missing = configured.filter((t) => !seen.includes(t));
    lines.push(
      row(
        "tools",
        missing.length === 0 ? OK : WARN,
        missing.length === 0
          ? configured.join(", ")
          : `${seen.join(", ") || "none"}  ${WARN} not seen: ${missing.join(", ")}`,
      ),
    );
  }
  if (facts.snapshot?.pricingPartial === true) {
    lines.push(
      row("", WARN, "some activity could not be priced — the total is a floor, not a sum"),
    );
  }
  if (facts.snapshot?.dayBoundaryApprox === true) {
    lines.push(
      row(
        "",
        WARN,
        `${facts.sourceId} reports whole calendar days; resetHourLocal is approximated`,
      ),
    );
  }

  // --- surfaces ---------------------------------------------------------------------------------
  // P5-2. This is a static statement of what CAN exist, not of what is installed, and it is here
  // because "why is there no meter in my Codex footer?" is a question the number itself can never
  // answer. Codex has no statusline a third party can write into — `tui.status_line` takes a closed
  // list of its own built-in items (P5-1, verified against the docs and the source) — so this is a
  // ceiling, not a gap. Saying so costs one line; leaving it out costs someone an afternoon.
  lines.push(row("surfaces", OK, "guard: Claude Code, Codex · statusline: Claude Code only"));

  // P5-3. Only printed when the tool is actually here. A permanent line listing tools the user does
  // not run is noise, and noise is what makes the rest of this screen stop being read — whereas a
  // Cursor user is looking at a total that silently omits their heaviest tool. WARN, not BAD:
  // nothing is broken and there is nothing to fix, which is exactly the point being made.
  if (facts.unpriceableFound.length > 0) {
    lines.push(
      row(
        "unpriced",
        WARN,
        // "anywhere on disk" is doing real work: it says this is a ceiling, not a missing feature,
        // so nobody goes looking for the config flag that would switch it on. The wording is also
        // length-tuned to the 65 columns this row has — a longer sentence gets silently clipped
        // mid-word by `clip`, which the 80-column test cannot see. See doctor.test.ts.
        `${facts.unpriceableFound.join(", ")} installed — exposes no local spend data anywhere on disk`,
      ),
    );
  }

  // --- signal -----------------------------------------------------------------------------------
  const echo = facts.echoSeen;
  lines.push(
    row(
      "primary",
      OK,
      echo === null
        ? `usd (no rate_limits seen — statusline has not reported any)`
        : `rate-limit (5h/7d seen ${humanAge(echo.ageSeconds)} via the statusline)`,
    ),
  );

  // --- budget and latch --------------------------------------------------------------------------
  lines.push(
    facts.config.dailyBudgetUsd > 0
      ? row("budget", OK, `$${facts.config.dailyBudgetUsd.toFixed(2)}/day`)
      : row("budget", WARN, "not set — spend renders, but nothing can be crossed"),
  );

  if (facts.latch.recovered) {
    // L6. Saying so matters: the user would otherwise wonder why no alert fired today.
    lines.push(row("latch", WARN, "recovered — silent for the rest of this usage-day"));
  } else if (!facts.latch.present) {
    lines.push(row("latch", OK, "armed (nothing fired yet today)"));
  } else {
    lines.push(
      row(
        "latch",
        OK,
        facts.latch.firedToday.length === 0
          ? "armed (nothing fired yet today)"
          : `fired today: ${facts.latch.firedToday.join(", ")}`,
      ),
    );
  }

  // --- config ------------------------------------------------------------------------------------
  lines.push(
    row(
      "config",
      facts.configWarnings.length === 0 ? OK : WARN,
      facts.configWarnings.length === 0
        ? tildify(facts.configPath, facts.home)
        : `${tildify(facts.configPath, facts.home)} — ${facts.configWarnings[0]}`,
    ),
  );
  for (const w of facts.configWarnings.slice(1)) {
    lines.push(`               ${WARN} ${w}`.slice(0, WIDTH));
  }

  // --- spend ---------------------------------------------------------------------------------------
  const total = facts.snapshot?.totalUsd ?? null;
  if (total === null) {
    // The rule that outranks legibility: never print a numeral that could be read as a claim.
    lines.push(row("spend", BAD, "unknown"));
  } else {
    const symbol = facts.snapshot?.imputed === true ? "≈" : "";
    const pct =
      facts.config.dailyBudgetUsd > 0
        ? ` (${Math.round((total / facts.config.dailyBudgetUsd) * 100)}%)`
        : "";
    lines.push(row("spend", OK, `${symbol}$${total.toFixed(2)} today${pct}`));
  }

  // Exit 1 only when NOTHING is usable — not merely degraded. A stale number is still a number,
  // and a doctor that exits non-zero for a warning is a doctor people stop running.
  const usable = facts.available || facts.snapshot !== null;
  if (!usable) lines.push("", ...REMEDY);
  return { lines, exitCode: usable ? 0 : 1 };
}
