#!/usr/bin/env node
/**
 * `lum` CLI entrypoint.
 *
 * P1-0 scaffold: argument routing and exit-code discipline only. The commands themselves land in
 * P1-8 (`today`), P4-5 (`doctor`) and P2 (`refresh`), each behind `UsageSourcePort` — never
 * reaching for a collector directly from here.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NullNotifier, OsNotifier } from "../adapters/notify/notifier.ts";
import { renderToday } from "../adapters/render/table.ts";
import { CcusageSource } from "../adapters/source/ccusage.shellout.ts";
import { withTimeout } from "../adapters/source/timeout.ts";
import { AtomicFileStore, defaultStateDir } from "../adapters/store/atomic.ts";
import { runAlerts } from "../app/alert.ts";
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
  lum --version        print the version
  lum --help           print this message
`;

type Command = "today" | "doctor" | "refresh" | "version" | "help";

/** Pure: maps argv to a command so it can be tested without spawning a process. */
export function parseArgs(argv: readonly string[]): { command: Command; unknown?: string } {
  const first = argv[0];
  if (first === undefined) return { command: "today" };
  switch (first) {
    case "today":
    case "doctor":
    case "refresh":
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

/** The composition root. Nothing above this line knows a collector exists. */
export async function runToday(home: string = homedir()): Promise<number> {
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

  let snapshot = await buildSnapshot({ source, clock, config, store });

  // Degradation matrix: a slow or unreachable collector falls back to the last good snapshot,
  // which `buildSnapshot` deliberately did not overwrite.
  if (snapshot.health.kind !== "ok") {
    const cached = await store.read<UsageSnapshot>(SNAPSHOT_KEY).catch(() => null);
    if (cached !== null && cached.schema === 1) {
      snapshot = { ...cached, health: snapshot.health };
    }
  }

  // P2-5. Runs BEFORE rendering so that a crossing is latched and notified even if the render
  // path somehow fails — and it never throws: an alerting fault must not cost the user the number.
  try {
    await runAlerts({
      snapshot,
      config,
      store,
      notifier: config.notifications.enabled
        ? new OsNotifier(
            config.notifications.command === undefined
              ? {}
              : { command: config.notifications.command },
          )
        : new NullNotifier(),
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
    case "doctor":
    case "refresh":
      process.stderr.write(`lum ${command}: not implemented yet (P2 / P4-5)\n`);
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
