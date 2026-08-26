#!/usr/bin/env node
/**
 * `lum` CLI entrypoint.
 *
 * P1-0 scaffold: argument routing and exit-code discipline only. The commands themselves land in
 * P1-8 (`today`), P4-5 (`doctor`) and P2 (`refresh`), each behind `UsageSourcePort` — never
 * reaching for a collector directly from here.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NullNotifier, OsNotifier } from "../adapters/notify/notifier.ts";
import { renderToday } from "../adapters/render/table.ts";
import { CcusageSource } from "../adapters/source/ccusage.shellout.ts";
import { withTimeout } from "../adapters/source/timeout.ts";
import { AtomicFileStore, defaultStateDir } from "../adapters/store/atomic.ts";
import { runAlerts } from "../app/alert.ts";
import { planInstall, renderPlan } from "../app/install.ts";
import { buildSnapshot, SNAPSHOT_KEY } from "../app/meter.ts";
import { parseConfigText } from "../domain/config.ts";
import type { ClockPort } from "../domain/ports.ts";
import type { UsageSnapshot } from "../domain/types.ts";

const VERSION = "0.0.0";

/**
 * Measured, not guessed: ~35 ms of process overhead plus a full corpus read — ~90 ms warm and
 * ~980 ms cold on a 261 MB corpus, and the corpus only grows. The plan's 1500 ms was marginal
 * today and would not survive growth; 300 ms would kill every cold start. See M1_RESULT.md §1.
 */
const SOURCE_TIMEOUT_MS = 3000;

const USAGE = `lum — local budget guardrail for AI coding tools

Usage:
  lum today            today's spend across every configured tool, vs your allowance
  lum doctor           which collector was found, how fresh it is, what is missing
  lum refresh          re-read the collector and update the cached snapshot
  lum install          print the Claude Code settings block (--write to apply)
  lum --version        print the version
  lum --help           print this message
`;

type Command = "today" | "doctor" | "refresh" | "install" | "version" | "help";

/** Pure: maps argv to a command so it can be tested without spawning a process. */
export function parseArgs(argv: readonly string[]): { command: Command; unknown?: string } {
  const first = argv[0];
  if (first === undefined) return { command: "today" };
  switch (first) {
    case "today":
    case "doctor":
    case "refresh":
    case "install":
      return { command: first };
    case "-v":
    case "--version":
      return { command: "version" };
    case "-h":
    case "--help":
      return { command: "help" };
    default:
      return { command: "help", unknown: first };
  }
}

/**
 * `lum refresh` — rebuild the snapshot and evaluate alerts, printing nothing.
 *
 * This is what the `Stop` hook runs. It shares the whole pipeline with `lum today`; the only
 * difference is that it renders nothing, because a hook's stdout is not a place to write to.
 */
export async function runRefresh(home: string = homedir()): Promise<number> {
  const { config, clock, store, source } = await wire(home);
  const snapshot = await buildSnapshot({ source, clock, config, store });
  try {
    await runAlerts({
      snapshot,
      config,
      store,
      notifier: notifierFor(config),
      nowIso: new Date(clock.nowMs()).toISOString(),
    });
  } catch {
    // Best-effort, exactly as in `today`.
  }
  // Always 0: a hook that exits non-zero is noise in the user's session for something they did
  // not ask for and cannot act on.
  return 0;
}

/**
 * Where statusline.js actually lives.
 *
 * It is NOT bundled — it ships as-is from `src/bin/` (package.json `files`), because it runs on
 * every prompt and must not pay a transpile step. So the path differs between a built bundle
 * (`dist/lum.js`, one level below the package root) and a dev checkout (`src/bin/lum.ts`, beside
 * it). Probing beats guessing: writing a path that does not exist into the user's settings.json
 * is a broken statusline they will discover at the worst moment.
 */
function resolveStatuslinePath(): string {
  const candidates = [
    new URL("./statusline.js", import.meta.url), // dev: src/bin/lum.ts -> src/bin/statusline.js
    new URL("../src/bin/statusline.js", import.meta.url), // built: dist/lum.js -> src/bin/...
  ].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1] ?? "";
}

/** `lum install` — P3-5 + P3-6. Prints the settings block; `--write` applies it after a backup. */
export async function runInstall(write: boolean, home: string = homedir()): Promise<number> {
  const settingsPath = join(home, ".claude", "settings.json");
  const existing = await readFile(settingsPath, "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);

  const statuslinePath = resolveStatuslinePath();
  const plan = planInstall(existing, "lum", statuslinePath);

  if (!write) {
    process.stdout.write(`${renderPlan(plan, settingsPath).join("\n")}\n`);
    return 0;
  }
  if (plan.changes.length === 0) {
    process.stdout.write(`Already installed in ${settingsPath}.\n`);
    return 0;
  }
  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    // Back up BEFORE writing. This file is the user's, and it usually contains hooks they wrote.
    if (existing !== null) await copyFile(settingsPath, `${settingsPath}.bak`);
    await writeFile(settingsPath, `${JSON.stringify(plan.merged, null, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`lum install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 74; // EX_IOERR
  }
  process.stdout.write(`Installed: ${plan.changes.join(", ")}\n${settingsPath}\n`);
  return 0;
}

/** The composition root. Nothing above this line knows a collector exists. */
/**
 * One composition root, shared by `today` and `refresh`.
 *
 * Extracted so the hook path and the human path cannot drift: if `refresh` built its own source
 * with a different timeout or a different store, the number the statusline shows and the number
 * `lum today` prints would silently diverge, and nothing would catch it.
 */
async function wire(home: string) {
  const configText = await readFile(join(home, ".localusagemeter", "config.json"), "utf8").catch(
    () => null,
  );
  const { config } = parseConfigText(configText);
  const clock: ClockPort = {
    nowMs: () => Date.now(),
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
  };
  const store = new AtomicFileStore(defaultStateDir(home));
  const collector = new CcusageSource();
  const source = withTimeout(collector, SOURCE_TIMEOUT_MS, {
    // Without this a timed-out ccusage keeps reading the corpus after we have stopped waiting.
    onTimeout: () => collector.killInFlight(),
  });
  return { config, clock, store, collector, source };
}

function notifierFor(config: { notifications: { enabled: boolean; command?: readonly string[] } }) {
  if (!config.notifications.enabled) return new NullNotifier();
  return new OsNotifier(
    config.notifications.command === undefined ? {} : { command: config.notifications.command },
  );
}

export async function runToday(home: string = homedir()): Promise<number> {
  const { config, clock, store, source } = await wire(home);

  let snapshot = await buildSnapshot({ source, clock, config, store });

  // Degradation matrix: a slow or unreachable collector falls back to the last good snapshot,
  // which `buildSnapshot` deliberately did not overwrite.
  if (snapshot.health.kind !== "ok") {
    const cached = await store.read<UsageSnapshot>(SNAPSHOT_KEY).catch(() => null);
    if (cached !== null && cached.schema === 1) {
      snapshot = { ...cached, health: snapshot.health };
    }
  }

  // Runs BEFORE rendering so a crossing is latched and notified even if the render path fails —
  // and it never throws: an alerting fault must not cost the user the number.
  try {
    await runAlerts({
      snapshot,
      config,
      store,
      notifier: notifierFor(config),
      nowIso: new Date(clock.nowMs()).toISOString(),
    });
  } catch {
    // Alerting is best-effort. `lum doctor` reports latch health (P4-4).
  }

  const lines = renderToday(snapshot, config, {
    nowMs: clock.nowMs(),
    width: process.stdout.columns ?? 80,
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  // Every matrix row is a NORMAL state and exits 0. A non-zero exit here would break any prompt
  // or script that shells out to us.
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, unknown } = parseArgs(argv);

  if (unknown !== undefined) {
    process.stderr.write(`lum: unknown command ${JSON.stringify(unknown)}\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "today":
      return await runToday();
    case "refresh":
      return await runRefresh();
    case "install":
      return await runInstall(argv.includes("--write"));
    case "doctor":
      process.stderr.write(`lum ${command}: not implemented yet (P4-4)\n`);
      return 69; // EX_UNAVAILABLE
  }
}

/**
 * Only run when executed directly. Without this guard, importing the module to test `parseArgs`
 * runs the CLI as a side effect — writing to stderr and setting `process.exitCode` mid-suite.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`lum: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 70; // EX_SOFTWARE
    },
  );
}
