#!/usr/bin/env node
/**
 * `PreToolUse` guard — hard enforcement without a proxy.
 *
 * This is the one thing a request-path proxy (LiteLLM and friends) could do that a read-only tool
 * could not: actually say no. Claude Code's hook contract closes that gap for the cost of one
 * settings.json entry instead of a server, a database and re-pointed credentials.
 *
 * FIVE invariants, and the first two are the ones that make it safe to ship:
 *
 *  1. **Never read the collector.** `node:fs` only, exactly like statusline.js. A timed-out hook
 *     does NOT block — the docs are explicit that "you shouldn't count on a stalled hook to act as
 *     a gate" — so a slow guard is an absent guard. Our warm collector read is ~90 ms and the cold
 *     one ~1 s; either would silently stop enforcing. It reads the cached snapshot and nothing else.
 *  2. **Never block on a number we are unsure of.** Only a fresh, healthy, trusted snapshot may
 *     deny. Stale, timed-out, source-down or unpriced => allow. This is L9 applied to enforcement,
 *     and the asymmetry behind it is that a missed block costs money while a wrong block costs the
 *     user their work.
 *  3. **Fail open, always.** Every fault path allows. A guard that blocks because it crashed is
 *     worse than no guard.
 *  4. **Off unless asked.** `guard.enabled` defaults to false.
 *  5. **Say why.** A denial with no reason is indistinguishable from a broken tool.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE = (home) => join(home, ".localusagemeter", "state");
const CONFIG = (home) => join(home, ".localusagemeter", "config.json");

/** Anything unreadable or unparseable is `null`. Never throws. */
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How stale a snapshot may be and still authorise a BLOCK.
 *
 * Deliberately much tighter than the statusline's 15-minute display threshold. Showing a slightly
 * old number is a small sin; refusing someone's tool call based on one is not. Two minutes is
 * roughly one `Stop`-hook refresh cycle plus slack.
 */
export const MAX_BLOCK_AGE_SECONDS = 120;

/**
 * Decide. Pure, so every branch is table-testable.
 *
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decide({ snapshot, config, toolName, nowMs }) {
  const guard = config?.guard;
  if (guard?.enabled !== true) return { allow: true };

  // An exempt tool stays usable while blocked, so a stopped session can still be inspected.
  const allowTools = Array.isArray(guard.allowTools) ? guard.allowTools : [];
  if (typeof toolName === "string" && allowTools.includes(toolName)) return { allow: true };

  if (snapshot === null || snapshot.schema !== 1) return { allow: true };
  // Invariant 2: only a trusted read may deny.
  if (snapshot.health?.kind !== "ok") return { allow: true };

  const ageSeconds = (nowMs - Date.parse(snapshot.generatedAtUtc)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_BLOCK_AGE_SECONDS) return { allow: true };

  const limit = typeof config.dailyBudgetUsd === "number" ? config.dailyBudgetUsd : 0;
  const spent = snapshot.totalUsd;
  // No budget, or an unknown total, means there is nothing to be over.
  if (!(limit > 0) || typeof spent !== "number") return { allow: true };

  const denyAt = typeof guard.denyAt === "number" && guard.denyAt > 0 ? guard.denyAt : 1;
  const fraction = spent / limit;
  if (fraction < denyAt) return { allow: true };

  const pct = Math.round(fraction * 100);
  const noun = snapshot.imputed === true ? "daily usage allowance" : "daily budget";
  return {
    allow: false,
    reason:
      `lum: ${pct}% of your ${noun} ($${spent.toFixed(2)} of $${limit.toFixed(2)}) — ` +
      `over the ${Math.round(denyAt * 100)}% guard. Raise dailyBudgetUsd, set guard.enabled ` +
      `false, or wait for the daily reset.`,
  };
}

/** The documented PreToolUse response. Exit 0 — the JSON, not the exit code, carries the verdict. */
export function denyPayload(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const home = homedir();
  // stdin carries the PreToolUse payload. It is read but never persisted: it contains tool inputs,
  // which are prompt content (ADR-v2-004).
  let toolName;
  try {
    const parsed = JSON.parse(readStdin());
    if (parsed !== null && typeof parsed === "object") toolName = parsed.tool_name;
  } catch {
    // No stdin, or not JSON. Guard still runs; it simply cannot honour allowTools.
  }

  const verdict = decide({
    snapshot: readJson(join(STATE(home), "today.json")),
    config: readJson(CONFIG(home)) ?? {},
    toolName,
    nowMs: Date.now(),
  });

  if (verdict.allow) return 0;

  process.stdout.write(`${JSON.stringify(denyPayload(verdict.reason))}\n`);

  // `hard` mode also exits 2, which blocks unconditionally. `deny` mode exits 0 and relies on the
  // documented JSON contract — so if that contract ever changes, it fails OPEN rather than
  // blocking every tool call forever. That is the safe direction, and it is the default.
  const config = readJson(CONFIG(home));
  return config?.guard?.mode === "hard" ? 2 : 0;
}

/** Only when executed directly — same guard, same reason, as lum.ts and statusline.js. */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  let code = 0;
  try {
    code = main();
  } catch {
    // Invariant 3: fail open. A guard that blocks because it crashed is worse than no guard.
    code = 0;
  }
  process.exitCode = code;
}
