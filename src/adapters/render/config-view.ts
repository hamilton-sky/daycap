/**
 * `daycap config` rendering. PURE — takes facts, returns 80-column lines.
 *
 * The question this answers is not "what is my config" — `cat` does that. It is **"which of these
 * values is actually in force, and where did it come from"**, which `cat` cannot answer at all: the
 * file shows what you typed, not what survived parsing. A misspelled key is invisible in the file
 * and obvious here.
 *
 * Why this and not an interactive UI: the three obvious shapes each break something real. A TUI
 * needs ink or blessed, and zero runtime dependencies is the property that makes the licence surface
 * empty and `npm i -g` instant. An interactive prompt needs `node:readline`, which the import gate
 * forbids in `src/`. A local web UI needs a server and a port, which the non-goals rule out. None of
 * those are red tape, so the answer is a good read-only view plus `--edit` handing off to $EDITOR.
 */

import type { Config } from "../../domain/types.ts";
import { tildify, WIDTH } from "./doctor.ts";

export type ConfigFacts = {
  home: string;
  path: string;
  /** False when no file exists and every value below is a default. */
  fileExists: boolean;
  config: Config;
  /** Which top-level keys the file actually set — everything else is a default. */
  explicitKeys: readonly string[];
  warnings: readonly string[];
};

/**
 * Every key `parseConfig` understands, including the back-compat aliases it still honours.
 *
 * Exists so `daycap config` can name a key the file sets that nothing reads. `parseConfig`
 * deliberately IGNORES unrecognised keys — that is right, since a config written for a future
 * version must not stop the tool starting — but it makes a typo and a future key indistinguishable,
 * and a typo is silent forever. `"dailyBudgetUSD": 999` parses, validates, and does nothing at all.
 *
 * This is the single most useful thing this command does, and it is the reason it is not just `cat`.
 */
const KNOWN_KEYS: readonly string[] = [
  "dailyBudgetUsd",
  "resetHourLocal",
  "thresholds",
  "notifyEveryUsd",
  "source",
  "sourceFile",
  "tools",
  "primarySignal",
  "pacing",
  "notifications",
  "guard",
  "timezone",
  // Honoured aliases (§8 finding 5). Named here so they do not report as unknown.
  "clis",
  "imputeCostForSubscription",
];

const MARK_SET = "•";
const MARK_DEFAULT = " ";
/** Set in the file, but rejected — so the value shown is a default, not theirs. */
const MARK_REJECTED = "!";

function row(key: string, value: string, isSet: boolean, note = "", rejected = false): string {
  const mark = rejected ? MARK_REJECTED : isSet ? MARK_SET : MARK_DEFAULT;
  const prefix = `  ${mark} ${key.padEnd(17)} `;
  const body = note.length > 0 ? `${value}  ${note}` : value;
  return (prefix + body).slice(0, WIDTH);
}

const money = (n: number): string => `$${n.toFixed(2)}`;

export function renderConfig(facts: ConfigFacts): string[] {
  const c = facts.config;
  const set = (k: string): boolean => facts.explicitKeys.includes(k);
  // A key the file SET whose value was rejected: the `•` would claim the shown value is theirs when
  // it is the default. Distinguished, because "you set this and it did not take" is a different
  // situation from both "you set this" and "you did not".
  const rejected = (k: string): boolean =>
    set(k) && facts.warnings.some((w) => w.startsWith(k) || w.includes(`${k} must`));
  const lines: string[] = ["daycap config", ""];

  lines.push(
    facts.fileExists
      ? `  file: ${tildify(facts.path, facts.home)}`
      : `  file: ${tildify(facts.path, facts.home)} (absent — every value below is a default)`,
  );
  lines.push(
    `  ${MARK_SET} = set by you   ${MARK_REJECTED} = set but rejected   (blank) = default`,
    "",
  );

  // --- money ------------------------------------------------------------------------------------
  lines.push(
    row(
      "dailyBudgetUsd",
      c.dailyBudgetUsd > 0 ? money(c.dailyBudgetUsd) : "not set",
      set("dailyBudgetUsd"),
      // The single most consequential value: with no budget nothing can be crossed, so no alert and
      // no guard can ever fire, however they are configured.
      c.dailyBudgetUsd > 0 ? "" : "← nothing can fire without this",
    ),
  );
  lines.push(
    row(
      "thresholds",
      c.thresholds.map((t) => `${Math.round(t * 100)}%`).join(", "),
      set("thresholds"),
      "",
      rejected("thresholds"),
    ),
  );
  lines.push(
    row(
      "notifyEveryUsd",
      c.notifyEveryUsd === null ? "off" : `every ${money(c.notifyEveryUsd)}`,
      set("notifyEveryUsd"),
      c.notifyEveryUsd !== null && c.dailyBudgetUsd > 0
        ? `≈ ${Math.floor(c.dailyBudgetUsd / c.notifyEveryUsd)} alerts per full budget`
        : "",
    ),
  );

  // --- when a day starts ------------------------------------------------------------------------
  lines.push(
    row(
      "resetHourLocal",
      `${String(c.resetHourLocal).padStart(2, "0")}:00 local`,
      set("resetHourLocal"),
      "",
      rejected("resetHourLocal"),
    ),
  );
  lines.push(row("timezone", c.timezone ?? "system", set("timezone")));

  // --- surfaces ---------------------------------------------------------------------------------
  lines.push("");
  lines.push(
    row(
      "notifications",
      c.notifications.enabled ? "on" : "off",
      set("notifications"),
      c.notifications.command === undefined ? "" : `custom: ${c.notifications.command[0]}`,
    ),
  );
  lines.push(
    row(
      "guard.enabled",
      c.guard.enabled ? "ON — blocks tool calls" : "off",
      set("guard"),
      // Both switches must be on. Saying so here saves the "I enabled it and nothing happened" hour.
      c.guard.enabled
        ? `at ${Math.round(c.guard.denyAt * 100)}% of budget`
        : "also needs `install --guard`",
    ),
  );
  if (c.guard.enabled) {
    lines.push(row("guard.allowTools", c.guard.allowTools.join(", ") || "none", set("guard")));
  }

  // --- source -----------------------------------------------------------------------------------
  lines.push("");
  lines.push(row("source", c.source, set("source")));
  lines.push(
    row(
      "sourceFile",
      c.sourceFile === null ? "not set" : tildify(c.sourceFile, facts.home),
      set("sourceFile"),
      c.source === "jsonfile" && c.sourceFile === null ? "← required by source=jsonfile" : "",
    ),
  );
  lines.push(row("tools", c.tools.join(", "), set("tools")));

  // --- anything the file said that we could not use ---------------------------------------------
  // "no config file" is filtered out: an absent file is understood perfectly, the header line two
  // screens up already says so, and listing it under "not understood" tells a first-time user their
  // setup is broken when it is merely empty. Only warnings about content they DID write belong here.
  const contentWarnings = facts.fileExists
    ? facts.warnings
    : facts.warnings.filter((w) => !w.includes("no config file"));
  // Keys nothing reads. `parseConfig` ignores them by design; this is where they stop being silent.
  const unknown = facts.explicitKeys.filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0) {
    lines.push("", "  Keys in your file that daycap does not read — likely typos:");
    for (const k of unknown) lines.push(`    ✗ ${k}`.slice(0, WIDTH));
  }

  if (contentWarnings.length > 0) {
    lines.push("", "  Not understood, so a default is in force instead:");
    for (const w of contentWarnings) lines.push(`    ⚠ ${w}`.slice(0, WIDTH));
  }

  lines.push("", "  Edit with `daycap config --edit`, then `daycap doctor` to confirm.");
  return lines;
}
