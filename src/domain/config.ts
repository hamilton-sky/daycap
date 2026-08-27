/**
 * Config parsing. PURE — no fs. The caller reads the bytes; this turns them into a Config.
 *
 * Never throws on bad input. A malformed config must still render — a guardrail that refuses to
 * start because one key is misspelled has stopped guarding. Every fallback is reported in
 * `warnings`, which `lum doctor` prints, so "defaults" is never silent.
 *
 * §8 finding 5: the brief claimed its five keys "survive unchanged" into v2. They do not — two
 * were renamed. Rather than paper over that, both old spellings are accepted as aliases here.
 */

import type { Config, PrimarySignal, SourceId, Threshold } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  /** 0 means "not set": absolute spend renders, no percentage and no bar. */
  dailyBudgetUsd: 0,
  resetHourLocal: 0,
  thresholds: [0.8, 1],
  source: "auto",
  sourceFile: null,
  tools: ["*"],
  primarySignal: "auto",
  pacing: false,
  notifications: { enabled: false },
  // Every default here is the cautious one: off, only at 100%, fail-open mode, and Read exempt so
  // a blocked session can still be inspected.
  guard: { enabled: false, denyAt: 1, mode: "deny", allowTools: ["Read"] },
  timezone: null,
};

const SOURCE_IDS: readonly SourceId[] = ["auto", "ccusage", "jsonfile"];

/**
 * Source names that used to be real. Rejected BY NAME, not as generic unknowns.
 *
 * A config saying `source: "budi"` is not a typo — it is a config written against a plan that has
 * since changed under it. "unknown source" would be true and useless; naming what happened is the
 * difference between a user editing one key and a user wondering whether their file is being read
 * at all. P4-3.
 */
const REMOVED_SOURCES: Record<string, string> = {
  budi: "removed by P0-4's verdict — both budi paths were session-shaped, so ccusage became primary",
  tokentracker:
    "cut in BUILD_PLAN_v3 §6 — two real adapters is the bar, and ccusage + jsonfile meets it",
};
const SIGNALS: readonly PrimarySignal[] = ["auto", "rate-limit", "usd"];

export type ConfigResult = {
  config: Config;
  /** Human-readable reasons a default was used. Empty means the file was fully understood. */
  warnings: readonly string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length === 0 ? null : out.map((x) => x.trim());
}

export function parseConfig(raw: unknown): ConfigResult {
  const warnings: string[] = [];
  if (raw === null || raw === undefined) {
    return { config: DEFAULT_CONFIG, warnings: ["no config file; using defaults"] };
  }
  if (!isRecord(raw)) {
    return { config: DEFAULT_CONFIG, warnings: ["config is not an object; using defaults"] };
  }

  const cfg: Config = { ...DEFAULT_CONFIG };

  const budget = raw.dailyBudgetUsd;
  if (typeof budget === "number" && Number.isFinite(budget) && budget >= 0) {
    cfg.dailyBudgetUsd = budget;
  } else if (budget !== undefined) {
    warnings.push("dailyBudgetUsd must be a number >= 0; budget not set");
  }

  const reset = raw.resetHourLocal;
  if (typeof reset === "number" && Number.isInteger(reset) && reset >= 0 && reset <= 23) {
    cfg.resetHourLocal = reset;
  } else if (reset !== undefined) {
    warnings.push("resetHourLocal must be an integer 0-23; using 0");
  }

  const thresholds = raw.thresholds;
  if (Array.isArray(thresholds)) {
    const ok = thresholds.filter(
      (t): t is Threshold => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 10,
    );
    if (ok.length > 0) cfg.thresholds = [...ok].sort((a, b) => a - b);
    else warnings.push("thresholds held no usable fractions; using defaults");
  } else if (thresholds !== undefined) {
    warnings.push("thresholds must be an array; using defaults");
  }

  const source = raw.source;
  if (typeof source === "string" && (SOURCE_IDS as readonly string[]).includes(source)) {
    cfg.source = source as SourceId;
  } else if (typeof source === "string" && REMOVED_SOURCES[source] !== undefined) {
    warnings.push(`source "${source}" no longer exists: ${REMOVED_SOURCES[source]}; using "auto"`);
  } else if (source !== undefined) {
    warnings.push(`unknown source ${JSON.stringify(source)}; using "auto"`);
  }

  // Accepted whatever `source` says, including "auto" — a path set alongside `source: "ccusage"` is
  // not an error, it is a path that is simply not used today and will be if they switch. Refusing
  // it would make changing one key a two-key edit.
  const sourceFile = raw.sourceFile;
  if (typeof sourceFile === "string" && sourceFile.trim().length > 0) {
    cfg.sourceFile = sourceFile.trim();
  } else if (sourceFile !== null && sourceFile !== undefined) {
    warnings.push(
      "sourceFile must be a non-empty string or null; jsonfile will not be a candidate",
    );
  }

  // The one combination that cannot work, said plainly at parse time rather than as a probe failure
  // later. `source: "jsonfile"` names a source that needs a path; without one there is nothing to
  // read, and the honest place to say so is here.
  if (cfg.source === "jsonfile" && cfg.sourceFile === null) {
    warnings.push('source is "jsonfile" but sourceFile is not set; nothing can be read');
  }

  // ALIAS: `clis` was v1's name for `tools`.
  const tools = stringArray(raw.tools) ?? stringArray(raw.clis);
  if (tools !== null) {
    cfg.tools = tools;
    if (raw.tools === undefined && raw.clis !== undefined) {
      warnings.push("`clis` is the old name for `tools`; it still works");
    }
  } else if (raw.tools !== undefined || raw.clis !== undefined) {
    warnings.push('tools must be a non-empty array of strings; using ["*"]');
  }

  // ALIAS: `imputeCostForSubscription: true` meant "show dollars even on a subscription", which
  // in v2 is `primarySignal: "usd"`. false meant "prefer the native signal" => "auto".
  const signal = raw.primarySignal;
  if (typeof signal === "string" && (SIGNALS as readonly string[]).includes(signal)) {
    cfg.primarySignal = signal as PrimarySignal;
  } else if (signal !== undefined) {
    warnings.push(`unknown primarySignal ${JSON.stringify(signal)}; using "auto"`);
  } else if (typeof raw.imputeCostForSubscription === "boolean") {
    cfg.primarySignal = raw.imputeCostForSubscription ? "usd" : "auto";
    warnings.push(
      "`imputeCostForSubscription` is the old name for `primarySignal`; it still works",
    );
  }

  if (typeof raw.pacing === "boolean") cfg.pacing = raw.pacing;

  const notifications = raw.notifications;
  if (isRecord(notifications) && typeof notifications.enabled === "boolean") {
    const command = stringArray(notifications.command);
    cfg.notifications =
      command === null
        ? { enabled: notifications.enabled }
        : { enabled: notifications.enabled, command };
    if (command === null && notifications.command !== undefined) {
      warnings.push(
        "notifications.command must be a non-empty array of strings; using the OS default",
      );
    }
  } else if (notifications !== undefined) {
    warnings.push("notifications must be { enabled: boolean }; notifications off");
  }

  const guard = raw.guard;
  if (isRecord(guard)) {
    const next = { ...DEFAULT_CONFIG.guard };
    if (typeof guard.enabled === "boolean") next.enabled = guard.enabled;
    if (typeof guard.denyAt === "number" && Number.isFinite(guard.denyAt) && guard.denyAt > 0) {
      next.denyAt = guard.denyAt;
    } else if (guard.denyAt !== undefined) {
      warnings.push("guard.denyAt must be a number > 0; using 1.0");
    }
    if (guard.mode === "deny" || guard.mode === "hard") next.mode = guard.mode;
    else if (guard.mode !== undefined) warnings.push('guard.mode must be "deny" or "hard"');
    const allow = stringArray(guard.allowTools);
    if (allow !== null) next.allowTools = allow;
    else if (Array.isArray(guard.allowTools)) next.allowTools = [];
    cfg.guard = next;
  } else if (guard !== undefined) {
    warnings.push("guard must be an object; enforcement stays off");
  }

  const tz = raw.timezone;
  if (typeof tz === "string" && tz.trim().length > 0) cfg.timezone = tz.trim();
  else if (tz !== null && tz !== undefined) warnings.push("timezone must be a string or null");

  return { config: cfg, warnings };
}

/** Parse config text. Unparseable JSON degrades to defaults with a reason — never a crash. */
export function parseConfigText(text: string | null): ConfigResult {
  if (text === null) return parseConfig(null);
  try {
    return parseConfig(JSON.parse(text));
  } catch {
    return { config: DEFAULT_CONFIG, warnings: ["config is not valid JSON; using defaults"] };
  }
}
