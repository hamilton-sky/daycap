/**
 * `ccusage` source adapter — the primary collector for v1.
 *
 * Everything here is shaped by what M1_RESULT.md measured against a live corpus. The three
 * findings that decide the design:
 *
 *  1. **One spawn, not two.** `ccusage daily` ALREADY includes Codex — its `modelBreakdowns`
 *     entry for a gpt model is byte-identical to what `ccusage codex daily` reports for the same
 *     day. The planned "spawn both, sum them" would double-count by the whole Codex total.
 *  2. **The per-tool split comes from `modelBreakdowns[]`, never from `--by-agent`,** which on
 *     20.0.20 returns `agent: "all"` for every row and never splits.
 *  3. **The date key is `period`, not `date`.** `ccusage codex daily` is a different schema again
 *     (`date`/`costUSD`/`models{}`) — we do not call it.
 *
 * ADR-v2-001 holds throughout: the collector's own USD passes through untouched. Token counts are
 * carried for display only and are NEVER multiplied by anything. Contract case C9b exists to catch
 * a violation of exactly that.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { SourceIncompatibleError } from "../../domain/errors.ts";
import type { SourceGranularity, UsageSourcePort } from "../../domain/ports.ts";
import type { ToolSpend, UsageWindow } from "../../domain/types.ts";
import { usageDayFor } from "../../domain/window.ts";

/** How the binary is invoked. `prefixArgs` covers a JS launcher that must run under node. */
export type ResolvedBinary = { command: string; prefixArgs: readonly string[] };

export type CcusageOptions = {
  /** Explicit escape hatch — `config.sources.ccusage.binPath`. Always wins. */
  binPath?: string;
  /** Injected by the contract harness to arrange the `absent` scenario. */
  resolveBinary?: () => ResolvedBinary | null;
  /** Hard ceiling on collector stdout. A corrupted collector must not OOM us. */
  maxBufferBytes?: number;
};

/**
 * ccusage reads the entire transcript corpus on every call regardless of `--since`/`--until`
 * (measured: 1 day, 25 days and all-time all cost the same). So output size tracks the corpus,
 * not the window. 32 MB is far above a realistic daily-rows payload and still bounded.
 */
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

const PLATFORM_PACKAGES = [`@ccusage/ccusage-${process.platform}-${process.arch}`] as const;

/**
 * Four tiers. `npx` is deliberately absent and is not a fallback: it performs registry
 * resolution, which is a non-loopback network call, which P1-9's network gate fails the build
 * for. Using it would also cost ~2.6 s cold against the ~35 ms this path measures.
 */
function defaultResolveBinary(binPath?: string): ResolvedBinary | null {
  if (binPath !== undefined && binPath.length > 0) {
    return { command: binPath, prefixArgs: [] };
  }
  // Tier 0: an explicit override. Real users need this for a non-standard install; the restart
  // test needs it to make spend controllable across separate processes.
  const fromEnv = process.env.LUM_CCUSAGE_BIN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { command: fromEnv, prefixArgs: [] };
  }
  const require = createRequire(import.meta.url);
  for (const pkg of PLATFORM_PACKAGES) {
    try {
      // The platform package ships the native binary; resolving its package.json gives us its dir.
      const manifest = require.resolve(`${pkg}/package.json`);
      const dir = manifest.slice(0, manifest.lastIndexOf("/"));
      const exe = process.platform === "win32" ? "ccusage.exe" : "ccusage";
      return { command: `${dir}/${exe}`, prefixArgs: [] };
    } catch {
      // Not installed for this platform — fall through to PATH.
    }
  }
  // Tier 3: a global install. `execFile` searches PATH for a bare command name.
  return { command: "ccusage", prefixArgs: [] };
}

/** `YYYYMMDD` for the local calendar date of an instant, in the window's own zone. */
function ccusageDate(instantMs: number, tz: string): string {
  // resetHourLocal 0 => the plain local calendar date, which is ccusage's own bucketing.
  return usageDayFor(instantMs, 0, tz).replace(/-/g, "");
}

/**
 * Which tool a model belongs to.
 *
 * Lives HERE, inside the adapter, not in a shared registry — P1-1 forbids a per-tool branch
 * anywhere in `src/` outside the adapter that owns the collector's vocabulary, and revised C6
 * says alias maps are per-adapter. An unrecognised model is not dropped or coerced: it becomes
 * its own bucket, syntactically normalised, so a model family we have never seen still renders.
 */
export function toolForModel(modelName: string): string {
  const m = modelName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (m.startsWith("claude")) return "claude-code";
  if (/^(gpt|o1|o3|o4)([-.]|$)/.test(m)) return "codex";
  return m;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse `ccusage daily --json`.
 *
 * Alias-tolerant because the JSON shape drifts inside a major version and carries no stability
 * contract (`period` vs `date`, `totalCost` vs `costUSD` differ between subcommands of the SAME
 * version). Unknown extra keys are ignored, never fatal.
 *
 * On an unknown shape it reports the top-level KEYS only, never values — a payload may contain
 * repository names and file paths, and an error message is the easiest place to leak them.
 */
export function parseDaily(raw: unknown, sourceId: string): ToolSpend[] {
  const root = asRecord(raw);
  const container = root?.daily ?? (Array.isArray(raw) ? raw : undefined);
  if (!Array.isArray(container)) {
    const keys = root === null ? typeof raw : Object.keys(root).sort().join(",");
    throw new SourceIncompatibleError(sourceId, `no daily[] array; top-level keys: ${keys}`);
  }

  // cents per tool; `null` means "reported, but the collector priced nothing".
  const byTool = new Map<string, number | null>();
  const add = (tool: string, cost: number | null): void => {
    const cents = cost === null ? null : Math.round(cost * 100);
    if (!byTool.has(tool)) {
      byTool.set(tool, cents);
      return;
    }
    const prev = byTool.get(tool) ?? null;
    byTool.set(tool, prev === null && cents === null ? null : (prev ?? 0) + (cents ?? 0));
  };

  for (const rowRaw of container) {
    const row = asRecord(rowRaw);
    if (row === null) continue;
    const breakdowns = row.modelBreakdowns;
    if (Array.isArray(breakdowns) && breakdowns.length > 0) {
      for (const bRaw of breakdowns) {
        const b = asRecord(bRaw);
        if (b === null) continue;
        const name = typeof b.modelName === "string" ? b.modelName : null;
        if (name === null) continue;
        add(toolForModel(name), asFiniteNumber(b.cost ?? b.costUSD ?? b.totalCost));
      }
      continue;
    }
    // No per-model detail: attribute the day's total to whatever the row says it is. Better a
    // correct total under a coarse label than a dropped day.
    const total = asFiniteNumber(row.totalCost ?? row.costUSD ?? row.cost);
    const agents = asRecord(row.metadata)?.agents;
    const label =
      Array.isArray(agents) && agents.length === 1 && typeof agents[0] === "string"
        ? toolForModel(agents[0] === "claude" ? "claude-code" : agents[0])
        : "unattributed";
    add(label, total);
  }

  return [...byTool.entries()].map(([tool, cents]) => ({
    tool,
    usd: cents === null ? null : cents / 100,
    // ccusage prices subscription usage at API list rates, so on a subscription this is money
    // that was never actually charged. app/ decides how to word that; the adapter states it.
    imputed: true,
  }));
}

export class CcusageSource implements UsageSourcePort {
  readonly id = "ccusage";
  /**
   * ccusage reports whole calendar days. Any `resetHourLocal` other than 0 makes a window
   * straddle both ends, so `app/meter.ts` marks the total approximate. The adapter states the
   * fact; it does not decide the policy.
   */
  readonly granularity: SourceGranularity = "day";

  #resolve: () => ResolvedBinary | null;
  #maxBuffer: number;
  /**
   * The child currently in flight, if any. Tracked so a timeout can KILL it rather than abandon
   * it — an abandoned `ccusage` on every statusline tick is ccusage issue #455 (spawns
   * accumulating until OOM) reproduced inside our own tool. Contract case C11b asserts the kill.
   */
  #child: ChildProcess | null = null;

  constructor(options: CcusageOptions = {}) {
    this.#resolve = options.resolveBinary ?? (() => defaultResolveBinary(options.binPath));
    this.#maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  #run(args: readonly string[]): Promise<string> {
    const resolved = this.#resolve();
    if (resolved === null) {
      return Promise.reject(new SourceIncompatibleError(this.id, "no ccusage binary resolved"));
    }
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        resolved.command,
        [...resolved.prefixArgs, ...args],
        {
          // Never a shell string: dates and ids must never reach a shell.
          shell: false,
          maxBuffer: this.#maxBuffer,
          // Minimal env so the collector cannot pick up configuration we did not choose.
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ...(process.env.LUM_FAKE_TOTAL === undefined
              ? {}
              : { LUM_FAKE_TOTAL: process.env.LUM_FAKE_TOTAL }),
            ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          },
        },
        (err, stdout) => {
          if (this.#child === child) this.#child = null;
          if (err) reject(err);
          else resolve(stdout);
        },
      );
      this.#child = child;
    });
  }

  /**
   * PID of the collector process currently running, if any.
   *
   * Deliberately NOT on UsageSourcePort — only a spawning adapter has one, and the port must stay
   * implementable by a source that never forks. The contract harness reaches for it on the
   * concrete type.
   */
  inFlightPid(): number | undefined {
    return this.#child?.pid;
  }

  /** Kill the in-flight collector. Wired to `withTimeout`'s `onTimeout` by the caller. */
  killInFlight(): void {
    const child = this.#child;
    if (child === null || child.killed) return;
    child.kill("SIGKILL");
    this.#child = null;
  }

  async available(): Promise<boolean> {
    // Must never throw, even with no collector present (C2).
    try {
      if (this.#resolve() === null) return false;
      await this.#run(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async spendFor(window: UsageWindow): Promise<ToolSpend[]> {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new SourceIncompatibleError(this.id, "window bounds were not ISO-8601");
    }
    // The domain window is half-open [from, to); ccusage's --until is INCLUSIVE. The -1 ms IS
    // the conversion. Without it every query bleeds one extra calendar day.
    const since = ccusageDate(from, window.tz);
    const until = ccusageDate(to - 1, window.tz);

    const stdout = await this.#run([
      "daily",
      "--json",
      // Keeps the network gate green; ccusage must not phone out for pricing.
      "--offline",
      "--since",
      since,
      "--until",
      until,
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new SourceIncompatibleError(this.id, "stdout was not JSON");
    }
    return parseDaily(parsed, this.id);
  }

  async freshness(): Promise<{ lastUpdatedUtc: string | null }> {
    // ccusage exposes no watermark of its own, and inventing one from the corpus would mean
    // reading transcripts — which is exactly what ADR-v2-001 forbids. Unknown is honest.
    return { lastUpdatedUtc: null };
  }
}
