#!/usr/bin/env node
/**
 * `PreToolUse` guard — hard enforcement without a proxy.
 *
 * This is the one thing a request-path proxy (LiteLLM and friends) could do that a read-only tool
 * could not: actually say no. The hook contract closes that gap for the cost of one settings entry
 * instead of a server, a database and re-pointed credentials.
 *
 * **One file, two hosts.** This is also the Codex entrypoint, and that is not a coincidence we got
 * lucky with — P5-1 verified it. Codex CLI reads the same `tool_name` off stdin and honours the
 * same `hookSpecificOutput.permissionDecision: "deny"` payload, byte for byte. So there is no
 * second binary and no forked decision logic: `decide()` below is the only judge either host gets.
 *
 * Two places the hosts genuinely differ are handled in this file, each marked HOST DIFFERENCE where
 * it lives. The third is not a runtime concern and lives in the installer: Codex defaults a hook
 * timeout to 600 seconds and will not run a non-managed hook until the user has trusted it.
 *
 * NOTE for anyone auditing enforcement: on Claude Code no verdict changed. It never sends
 * `matcher_aliases`, so the exemption check reads exactly as it did before.
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
 *  5. **Say why.** A denial with no reason is indistinguishable from a broken tool. On Codex this
 *     one is load-bearing rather than merely polite: its parser rejects
 *     `permissionDecision:deny` without a non-empty `permissionDecisionReason`, and a rejected hook
 *     run lets the tool call proceed. An empty reason there is not an ugly block — it is no block.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Literals duplicated from `src/domain/brand.ts` because the import gate limits this file to
 * node:fs/os/path/url — see the same note in `statusline.js`. Kept in step by a gate assertion.
 *
 * `.daycap` preferred, the pre-rename name read as a fallback. Getting this wrong would not be a
 * cosmetic bug: a guard that cannot find the snapshot fails OPEN, so a rename would silently stop
 * enforcing for every existing user.
 */
const dir = (home) => {
  const current = join(home, ".daycap");
  if (existsSync(current)) return current;
  const legacy = join(home, ".localusagemeter");
  return existsSync(legacy) ? legacy : current;
};
const STATE = (home) => join(dir(home), "state");
const CONFIG = (home) => join(dir(home), "config.json");

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
 * `matcherAliases` is Codex's `matcher_aliases` and is absent on Claude Code, where it is simply an
 * empty list and changes nothing — hence optional, so a Claude Code caller reads unchanged.
 *
 * @param {{
 *   snapshot: unknown,
 *   config: unknown,
 *   toolName?: unknown,
 *   matcherAliases?: unknown,
 *   nowMs: number,
 * }} input
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decide({ snapshot, config, toolName, matcherAliases, nowMs }) {
  const guard = config?.guard;
  if (guard?.enabled !== true) return { allow: true };

  // An exempt tool stays usable while blocked, so a stopped session can still be inspected.
  const allowTools = Array.isArray(guard.allowTools) ? guard.allowTools : [];
  // HOST DIFFERENCE 1 of 3. A file edit is `Edit`/`Write` on Claude Code but `apply_patch` on
  // Codex, which reports the canonical name on stdin and offers the familiar spellings separately
  // as `matcher_aliases`. Checking the aliases too is what keeps ONE `allowTools: ["Edit"]` in the
  // user's config meaning the same thing on both hosts. Without it the exemption silently does
  // nothing on Codex — the failure mode being a block the user explicitly asked not to have.
  const names = [toolName, ...(Array.isArray(matcherAliases) ? matcherAliases : [])];
  if (names.some((n) => typeof n === "string" && allowTools.includes(n))) return { allow: true };

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
      `daycap: ${pct}% of your ${noun} ($${spent.toFixed(2)} of $${limit.toFixed(2)}) — ` +
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
  // which are prompt content (ADR-v2-004). Both hosts send `tool_name` here; only Codex sends
  // `matcher_aliases`.
  let toolName;
  let matcherAliases;
  try {
    const parsed = JSON.parse(readStdin());
    if (parsed !== null && typeof parsed === "object") {
      toolName = parsed.tool_name;
      matcherAliases = parsed.matcher_aliases;
    }
  } catch {
    // No stdin, or not JSON. Guard still runs; it simply cannot honour allowTools.
  }

  const verdict = decide({
    snapshot: readJson(join(STATE(home), "today.json")),
    config: readJson(CONFIG(home)) ?? {},
    toolName,
    matcherAliases,
    nowMs: Date.now(),
  });

  if (verdict.allow) return 0;

  // Invariant 5, enforced rather than assumed. Codex rejects a deny carrying an empty reason and
  // then lets the call through, so emitting one would be strictly worse than allowing on purpose:
  // it would look like enforcement in our code and behave like nothing on the host.
  //
  // NO MUTATION TEST COVERS THIS BRANCH, and that is not an oversight — deleting it changes no
  // observable behaviour, because every reason `decide()` can build today is a non-empty template.
  // The reachable half of the invariant IS covered: empty out that template and seven tests fail.
  // This stays as the tripwire for the change that would otherwise disarm Codex silently — a
  // user-supplied reason (`guard.message` and the like), where "" is one empty config value away
  // and the symptom is not a bad message but no enforcement at all.
  const reason = typeof verdict.reason === "string" ? verdict.reason.trim() : "";
  if (reason === "") return 0;

  process.stdout.write(`${JSON.stringify(denyPayload(reason))}\n`);

  // `hard` mode also exits 2, which blocks unconditionally. `deny` mode exits 0 and relies on the
  // documented JSON contract — so if that contract ever changes, it fails OPEN rather than
  // blocking every tool call forever. That is the safe direction, and it is the default.
  const config = readJson(CONFIG(home));
  if (config?.guard?.mode !== "hard") return 0;

  // HOST DIFFERENCE 2 of 3. Both hosts take the reason for an exit-2 block from STDERR, not from
  // the stdout JSON. Claude Code reads the JSON anyway, so this was invisible there; Codex does
  // not, so hard mode would have blocked with no explanation at all. Writing it to both streams
  // changes no verdict — only whether the user is told why.
  process.stderr.write(`${reason}\n`);
  return 2;
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
