/**
 * `lum today` rendering. PURE — takes a snapshot, returns lines.
 *
 * The matrix in IMPLEMENTATION_PLAN.md §2 P1-8 is a list of NORMAL states, not error paths. Every
 * one of them renders something truthful and exits 0. The single rule that outranks legibility:
 *
 *     UNKNOWN NEVER RENDERS AS $0.00
 *
 * A budget guardrail that shows $0.00 when it does not know is claiming safety it cannot vouch
 * for, which is strictly worse than showing nothing. Unknown money is an em dash, everywhere.
 */

import { CLI_NAME } from "../../domain/brand.ts";
import type { Config, UsageSnapshot } from "../../domain/types.ts";

export const NO_SOURCE = `${CLI_NAME} — (no source)`;

/** Older than this and the figure is marked with `⋯` rather than presented as current. */
export const STALE_AFTER_SECONDS = 15 * 60;

export type RenderOptions = {
  nowMs: number;
  /** Terminal width, for the budget bar. */
  width?: number;
};

function money(usd: number | null): string {
  // The em dash IS the feature. See the header.
  if (usd === null) return "—";
  return `$${usd.toFixed(2)}`;
}

function humanAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * True when this snapshot carries no usable figure at all.
 *
 * `no-source` and `incompatible` both mean the collector told us nothing, so both render the same
 * bare line — the difference between them belongs in `lum doctor`, not in a status row.
 */
export function isUnusable(snapshot: UsageSnapshot | null): boolean {
  if (snapshot === null) return true;
  const k = snapshot.health.kind;
  return k === "no-source" || k === "incompatible" || snapshot.totalUsd === null;
}

export function renderToday(
  snapshot: UsageSnapshot | null,
  config: Config,
  options: RenderOptions,
): string[] {
  // Cold start with no cache, no collector, or a payload we could not read.
  if (isUnusable(snapshot)) return [NO_SOURCE];
  const snap = snapshot as UsageSnapshot;

  const ageSeconds = Math.max(
    0,
    Math.round((options.nowMs - Date.parse(snap.generatedAtUtc)) / 1000),
  );
  const stale = ageSeconds > STALE_AFTER_SECONDS || snap.health.kind === "timeout";

  const marks: string[] = [];
  // A day-granularity collector cannot honour a non-midnight reset hour exactly; say so rather
  // than presenting an over-reaching total as precise.
  if (snap.dayBoundaryApprox) marks.push("~");
  if (stale) marks.push("⋯");

  const lines: string[] = [];
  const head = `${CLI_NAME} — ${snap.usageDay}${marks.length > 0 ? ` ${marks.join("")}` : ""}`;
  lines.push(head);
  lines.push("");

  const rows = [...snap.tools].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const nameWidth = Math.max(8, ...rows.map((r) => r.tool.length));
  for (const r of rows) {
    lines.push(`  ${r.tool.padEnd(nameWidth)}  ${money(r.usd).padStart(10)}`);
  }
  if (rows.length > 0) lines.push(`  ${"─".repeat(nameWidth + 12)}`);

  const suffix: string[] = [];
  // "some of your tools reported activity nobody could price" — the total is real but incomplete.
  if (snap.pricingPartial) suffix.push("(partial)");
  if (snap.imputed) suffix.push("(imputed)");
  lines.push(
    `  ${"TOTAL".padEnd(nameWidth)}  ${money(snap.totalUsd).padStart(10)}${
      suffix.length > 0 ? `  ${suffix.join(" ")}` : ""
    }`,
  );

  // dailyBudgetUsd unset or 0 => absolute spend only. No percentage, no bar, no invented target.
  if (config.dailyBudgetUsd > 0 && snap.totalUsd !== null) {
    const fraction = snap.totalUsd / config.dailyBudgetUsd;
    const width = Math.max(10, Math.min(30, (options.width ?? 60) - 30));
    lines.push("");
    lines.push(
      `  ${bar(fraction, width)}  ${Math.round(fraction * 100)}% of ${money(config.dailyBudgetUsd)}`,
    );
  }

  if (stale) {
    lines.push("");
    lines.push(
      snap.health.kind === "timeout"
        ? `  ⋯ collector timed out after ${snap.health.afterMs}ms; showing the last snapshot (${humanAge(ageSeconds)} old)`
        : `  ⋯ snapshot is ${humanAge(ageSeconds)} old`,
    );
  }

  return lines;
}

export { humanAge };
