/**
 * `lum install` — writes the Claude Code settings block. P3-5 + P3-6.
 *
 * This is the shape of the answer to PRE-F, and it is deliberately not a daemon.
 *
 * The problem: a statusline command is a short-lived process that can only READ. If the snapshot
 * only refreshes when the user types `lum`, the meter goes stale silently — and a stale budget
 * guardrail is worse than none, because it reports safety that is not there.
 *
 * The options the design considered were (A) the statusline self-spawns a refresh, (B) the user
 * refreshes manually, (C) the collector's own daemon writes our cache. Option **D** — Claude Code
 * hooks — was not considered and is better than all three: a hook block the user writes into their
 * OWN settings.json IS explicit consent, it needs no resident process, and it fires exactly when
 * spend changes. It does not answer ARCH_QUESTION 4 ("may a background process appear unasked?");
 * it dissolves it, because there is no longer any benefit to buy with that consent cost.
 *
 * `Stop` fires once per assistant turn. `PostToolUse` is deliberately NOT used: it fires many
 * times per turn, and a collector spawn per tool call is ccusage issue #455 — statusline spawns
 * accumulating until OOM — reproduced inside our own tool.
 */

export type SettingsBlock = Record<string, unknown>;

export type InstallPlan = {
  /** The JSON the user's settings.json should end up containing. */
  merged: SettingsBlock;
  /** Human-readable list of what changed. Empty means it was already installed. */
  changes: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function statusLineBlock(scriptPath: string): SettingsBlock {
  return { type: "command", command: scriptPath, padding: 0 };
}

/**
 * `async: true` matters: the refresh runs in the background so the user's turn never waits on a
 * ~90 ms warm (or ~1 s cold) collector read. The timeout is a ceiling, not a budget.
 */
export function hookEntry(command: string): SettingsBlock {
  return { hooks: [{ type: "command", command, async: true, timeout: 10 }] };
}

/**
 * Merge our block into whatever is already there.
 *
 * The rule is: never rewrite a key we do not own. A settings file is the user's, it usually
 * contains hooks they wrote themselves, and an installer that flattens it is an installer nobody
 * runs twice.
 */
export type InstallOptions = {
  /**
   * Add the PreToolUse guard hook. Separate from the rest on purpose: the statusline and the
   * refresh hook only ever ADD information, while the guard can STOP the user's work. Bundling an
   * enforcement mechanism into a convenience install is how a tool loses trust in one release.
   */
  guard?: boolean;
  guardPath?: string;
};

export function planInstall(
  existing: unknown,
  lumCommand: string,
  statuslinePath: string,
  options: InstallOptions = {},
): InstallPlan {
  const base: SettingsBlock = isRecord(existing) ? { ...existing } : {};
  const changes: string[] = [];

  const wantStatusLine = statusLineBlock(statuslinePath);
  const currentStatusLine = base.statusLine;
  if (JSON.stringify(currentStatusLine) !== JSON.stringify(wantStatusLine)) {
    changes.push(
      currentStatusLine === undefined
        ? "add statusLine"
        : "replace statusLine (it pointed somewhere else)",
    );
    base.statusLine = wantStatusLine;
  }

  const hooks: Record<string, unknown> = isRecord(base.hooks) ? { ...base.hooks } : {};
  const refresh = `${lumCommand} refresh`;
  for (const event of ["SessionStart", "Stop"] as const) {
    const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    // Idempotent: match on OUR command, so re-running never stacks duplicates and never touches
    // a hook the user added for something else.
    const already = list.some(
      (entry) =>
        isRecord(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => isRecord(h) && h.command === refresh),
    );
    if (!already) {
      list.push(hookEntry(refresh));
      changes.push(`add ${event} hook`);
    }
    hooks[event] = list;
  }
  if (options.guard === true && options.guardPath !== undefined) {
    const list = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : [];
    const already = list.some(
      (entry) =>
        isRecord(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => isRecord(h) && h.command === options.guardPath),
    );
    if (!already) {
      // NOT async, and NOT the refresh hook's 10s timeout. An async hook cannot block at all, and
      // a timed-out hook fails OPEN — so the guard must be synchronous and fast. It reads one
      // cached file; 5s is a ceiling for a pathological filesystem, not a budget.
      list.push({ hooks: [{ type: "command", command: options.guardPath, timeout: 5 }] });
      changes.push("add PreToolUse guard hook");
    }
    hooks.PreToolUse = list;
  }
  base.hooks = hooks;

  return { merged: base, changes };
}

/** What `lum install` prints when you do not pass `--write`. */
export function renderPlan(plan: InstallPlan, settingsPath: string): string[] {
  if (plan.changes.length === 0) {
    return [`lum is already installed in ${settingsPath} — nothing to do.`];
  }
  return [
    `Add this to ${settingsPath}:`,
    "",
    JSON.stringify({ statusLine: plan.merged.statusLine, hooks: plan.merged.hooks }, null, 2),
    "",
    `Changes: ${plan.changes.join(", ")}`,
    "",
    "Re-run with --write to apply it (a .bak backup is written first).",
    "",
    "The Stop hook is what keeps the statusline from going stale. Without it the meter only",
    "refreshes when you run `lum` by hand, and a budget guardrail that is quietly out of date",
    "is worse than none.",
    "",
    "`lum install --guard` additionally installs a PreToolUse hook that DENIES tool calls once",
    "you are over the allowance. That is enforcement, not a warning — it is off unless you ask,",
    "and it also needs `guard.enabled: true` in your config before it will deny anything.",
  ];
}
