#!/usr/bin/env node
/**
 * Claude Code statusline renderer. P3-1 / P3-2 / P3-3.
 *
 * Plain JS and unbundled on purpose: this runs on every prompt, so it must not pay a bundler or a
 * transpile step. That is also why the renderer lives HERE rather than in `adapters/render/` — the
 * import gate (P1-9) limits this file to node:fs, node:os, node:path and node:url, and a thin
 * cache reader that grew a dependency graph would have stopped being one.
 *
 * Three invariants, all correctness rather than style:
 *
 *  1. **Always exit 0.** A non-zero exit breaks the user's prompt. Every fault path renders a
 *     degraded string instead.
 *  2. **node:fs only.** No network, no child process, no dependency on the collector. It reads a
 *     cache `lum` wrote; it never queries anything. Enforced by test/gates/network.test.ts.
 *  3. **Never invent a number.** DESIGN §7: "I don't know" must never render as "you spent
 *     nothing". A `$0.00` here is a CLAIM that the collector confirmed zero spend. No degraded
 *     state ever prints a `$` numeral without a muted marker attached.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_DIR = join(homedir(), ".localusagemeter", "state");
const SNAPSHOT = join(STATE_DIR, "today.json");
const CONFIG = join(homedir(), ".localusagemeter", "config.json");
const ECHO = join(STATE_DIR, "stdin-echo.json");

export const NO_SOURCE = "lum — (no source)";
export const SOURCE_DOWN = "lum — (source down)";

/** DESIGN §1: 77 green, 208 amber, 203 red, 246 muted. */
const C256 = { green: "38;5;77", amber: "38;5;208", red: "38;5;203", muted: "38;5;246" };
/** 16-colour fallback for terminals without 256-colour support. */
const C16 = { green: "32", amber: "33", red: "31", muted: "90" };

/** Which palette — or none at all. */
export function colorMode(env = process.env, argv = process.argv) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (argv.includes("--no-color")) return "none";
  const term = env.TERM ?? "";
  if (term === "" || term === "dumb") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "256";
  return /256|kitty|alacritty|wezterm|ghostty/i.test(term) ? "256" : "16";
}

function paint(text, color, mode) {
  if (mode === "none" || color === null) return text;
  const code = (mode === "256" ? C256 : C16)[color];
  return `\x1b[${code}m${text}\x1b[0m`;
}

/** DESIGN §1: filled/empty cells, `display.barWidth` wide, default 5. */
export function bar(fraction, width = 5) {
  if (fraction === null || !Number.isFinite(fraction)) return "";
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function money(usd) {
  return usd.toFixed(2);
}

/** Threshold colour. Only states 0 and 1 are ever allowed to use it (DESIGN §7). */
export function thresholdColor(fraction) {
  if (fraction === null) return null;
  if (fraction >= 1) return "red";
  if (fraction >= 0.8) return "amber";
  return "green";
}

/**
 * The five-state trust taxonomy (DESIGN §7), in descending order of trust.
 *
 * Two things this must never do: fold state 2 into state 3 (a collector a few seconds behind is
 * still trustworthy; one that has gone away gives a number of unknown age), and print a numeral
 * without a marker in any state below 0.
 */
export function trustState(snapshot, nowMs, staleAfterSeconds = 120) {
  if (snapshot === null || snapshot.schema !== 1) return 4;
  const kind = snapshot.health?.kind;
  if (kind === "no-source") return 4;
  if (kind === "timeout" || kind === "incompatible" || kind === "not-backfilled") return 3;
  const ageSeconds = (nowMs - Date.parse(snapshot.generatedAtUtc)) / 1000;
  if (kind === "stale" || ageSeconds > staleAfterSeconds) return 2;
  return snapshot.pricingPartial === true ? 1 : 0;
}

/** rate_limits are each independently optional. Never render a placeholder for an absent window. */
export function rateLimitSegments(rateLimits) {
  const out = [];
  const five = rateLimits?.five_hour?.used_percentage;
  const seven = rateLimits?.seven_day?.used_percentage;
  if (typeof five === "number" && Number.isFinite(five)) out.push({ label: "5h", pct: five });
  if (typeof seven === "number" && Number.isFinite(seven)) out.push({ label: "7d", pct: seven });
  return out;
}

/**
 * Render the status row. Pure.
 *
 * @param {object|null} snapshot parsed snapshot, or null
 * @param {object} opts { config, stdin, nowMs, mode }
 */
export function render(snapshot, opts = {}) {
  const config = opts.config ?? {};
  const mode = opts.mode ?? "none";
  const nowMs = opts.nowMs ?? 0;
  const width = config.display?.barWidth ?? 5;
  const state = trustState(snapshot, nowMs);

  if (state === 4) return NO_SOURCE;
  if (snapshot === null || snapshot.totalUsd === null) {
    return state === 3 ? SOURCE_DOWN : NO_SOURCE;
  }

  const segments = rateLimitSegments(opts.stdin?.rate_limits);
  const budget = typeof config.dailyBudgetUsd === "number" ? config.dailyBudgetUsd : 0;
  const symbol = snapshot.imputed === true ? "≈" : "";

  // States 2 and 3 mute the ENTIRE numeric field, not just the suffix: colouring a value we are
  // unsure of with a threshold colour overstates confidence in it.
  const degraded = state >= 2;
  const suffix = state === 1 ? " *" : state === 2 ? " ⋯" : state === 3 ? " (source down)" : "";

  let body;
  if (segments.length > 0) {
    // §5 rate-limit-primary. The HIGHER window drives the shared bar: the two are independent
    // caps and crossing either one blocks you, so a fixed choice would hide the other's red.
    const fraction = Math.max(...segments.map((s) => s.pct)) / 100;
    const parts = segments.map((s) => {
      const text = `${s.label} ${String(Math.round(s.pct)).padStart(3)}%`;
      return degraded ? paint(text, "muted", mode) : paint(text, thresholdColor(s.pct / 100), mode);
    });
    const usd = `${symbol}$${money(snapshot.totalUsd)} today`;
    body = `${parts.join(" · ")} ${bar(fraction, width)}  ${paint(usd, "muted", mode)}`;
  } else {
    // §1 USD-primary.
    const fraction = budget > 0 ? snapshot.totalUsd / budget : null;
    const spend = `${symbol}$${money(snapshot.totalUsd)}`;
    const head =
      fraction === null
        ? `today ${spend}`
        : `today ${spend} / $${money(budget)} (${String(Math.round(fraction * 100)).padStart(3)}%)`;
    const color = degraded ? "muted" : thresholdColor(fraction);
    body = `${paint(head, color, mode)} ${bar(fraction, width)}`.trimEnd();
  }

  // The marker is appended OUTSIDE the colour reset so it never inherits the threshold colour.
  return `${body}${suffix === "" ? "" : paint(suffix, "muted", mode)}`;
}

// ---------------------------------------------------------------------------------------------
// I/O — everything below is the thin shell around the pure functions above.
// ---------------------------------------------------------------------------------------------

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Consume stdin BEFORE writing anything.
 *
 * Claude Code writes a JSON session payload here. Leaving it unread risks an EPIPE on the writer,
 * and P3-1 requires it be consumed and discarded regardless of whether we can parse it.
 */
export function readStdin() {
  if (process.stdin.isTTY === true) return null;
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim() === "") return null;
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The echo file — the bridge OPEN-F needs.
 *
 * The statusline can SEE rate_limits but cannot notify (fs only). `lum refresh` can notify but
 * cannot see stdin. So the statusline records what it saw, and the next refresh reads it. Kept to
 * a few hundred bytes: it is on the hot path, and it must carry nothing but the numbers.
 */
export function echoPayload(stdin, nowIso) {
  const rl = stdin?.rate_limits;
  if (rl === undefined || rl === null) return null;
  const pick = (w) =>
    typeof w?.used_percentage === "number"
      ? { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null }
      : undefined;
  const payload = { schema: 1, seenAtUtc: nowIso };
  const five = pick(rl.five_hour);
  const seven = pick(rl.seven_day);
  if (five !== undefined) payload.five_hour = five;
  if (seven !== undefined) payload.seven_day = seven;
  return payload.five_hour === undefined && payload.seven_day === undefined ? null : payload;
}

function main() {
  const stdin = readStdin();
  let line = NO_SOURCE;
  try {
    const snapshot = readJson(SNAPSHOT);
    const config = readJson(CONFIG) ?? {};
    line = render(snapshot, { config, stdin, nowMs: Date.now(), mode: colorMode() });
  } catch {
    line = NO_SOURCE;
  }
  process.stdout.write(`${line}\n`);

  // AFTER the write: the prompt gets its line even if the echo cannot be persisted.
  try {
    const payload = echoPayload(stdin, new Date().toISOString());
    if (payload !== null) writeFileSync(ECHO, JSON.stringify(payload));
  } catch {
    // A read-only state dir must not cost the user their statusline.
  }
}

/**
 * Only run when executed directly — the same guard, and the same reason, as bin/lum.ts: importing
 * this module to table-test render() must not run the CLI as a side effect.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  try {
    main();
  } catch {
    // Invariant 1: the prompt must never break.
    process.stdout.write(`${NO_SOURCE}\n`);
  }
  process.exitCode = 0;
}
