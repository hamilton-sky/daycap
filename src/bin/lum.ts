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
import { type DoctorFacts, renderDoctor } from "../adapters/render/doctor.ts";
import { renderToday } from "../adapters/render/table.ts";
import { resolveSource, UnavailableSource } from "../adapters/source/resolve.ts";
import { withTimeout } from "../adapters/source/timeout.ts";
import { AtomicFileStore, defaultStateDir } from "../adapters/store/atomic.ts";
import { runAlerts } from "../app/alert.ts";
import { planCodexInstall, planInstall, renderCodexPlan, renderPlan } from "../app/install.ts";
import { isLatchState, LATCH_KEY, type LatchState } from "../app/latch.ts";
import { buildSnapshot, SNAPSHOT_KEY, snapshotAgeSeconds } from "../app/meter.ts";
import { parseConfigText } from "../domain/config.ts";
import type { ClockPort } from "../domain/ports.ts";
import { markerDirFor, UNPRICEABLE_TOOLS } from "../domain/surfaces.ts";
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
                       --guard also installs the PreToolUse enforcement hook
                       --codex targets Codex (~/.codex/hooks.json) instead;
                       hooks only — Codex has no statusline lum can write into
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
function resolveBinPath(file: string): string {
  const candidates = [
    new URL(`./${file}`, import.meta.url), // dev: src/bin/lum.ts -> src/bin/<file>
    new URL(`../src/bin/${file}`, import.meta.url), // built: dist/lum.js -> src/bin/<file>
  ].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1] ?? "";
}

function resolveStatuslinePath(): string {
  return resolveBinPath("statusline.js");
}

/**
 * `lum doctor` — P4-4. Answers "why is the number what it is" in one screen.
 *
 * It deliberately does NOT refresh: a diagnostic that changes the thing it is diagnosing makes an
 * intermittent fault impossible to catch. It reports what is on disk right now.
 */
export async function runDoctor(home: string = homedir()): Promise<number> {
  const configPath = join(home, ".localusagemeter", "config.json");
  const configText = await readFile(configPath, "utf8").catch(() => null);
  const { config, warnings } = parseConfigText(configText);

  const store = new AtomicFileStore(defaultStateDir(home));

  // P4-3. Doctor runs the SAME resolver the real commands run, rather than reporting on a collector
  // it constructed for itself. A diagnostic that probes differently from the thing it diagnoses is
  // how "works in doctor, broken in today" happens.
  const resolved = await resolveSource(config);

  const snapshot = await store.read<UsageSnapshot>(SNAPSHOT_KEY).catch(() => null);

  // A latch we cannot parse is `recovered` (L6) — the reason no alert fired today, and precisely
  // the thing a user would otherwise never find out.
  let latch: DoctorFacts["latch"] = { present: false, recovered: false, firedToday: [] };
  try {
    const raw = await store.read<unknown>(LATCH_KEY);
    if (raw !== null && !isLatchState(raw))
      latch = { present: true, recovered: true, firedToday: [] };
    else if (raw !== null) {
      const l = raw as LatchState;
      const sameDay = snapshot === null || l.usageDay === snapshot.usageDay;
      latch = {
        present: true,
        recovered: false,
        firedToday: sameDay ? Object.keys(l.fired) : [],
      };
    }
  } catch {
    latch = { present: true, recovered: true, firedToday: [] };
  }

  const echoRaw = await store.read<Record<string, unknown>>("stdin-echo").catch(() => null);
  const echoSeen =
    echoRaw === null
      ? null
      : {
          ageSeconds: Math.max(
            0,
            (Date.now() - Date.parse(String(echoRaw.seenAtUtc ?? ""))) / 1000,
          ),
        };

  // P5-3. Existence only — we never look INSIDE a marker directory, which is the whole reason this
  // is allowed to exist at all (`domain/surfaces.ts` has the argument). Detection lives here
  // because `renderDoctor` is pure and this is the composition root; it is also cheap enough to sit
  // in a diagnostic that deliberately does no I/O of its own beyond reading what is already cached.
  const unpriceableFound = UNPRICEABLE_TOOLS.filter((tool) =>
    existsSync(join(home, markerDirFor(tool))),
  );

  const { lines, exitCode } = renderDoctor({
    home,
    sourceId: resolved.selection.chosen ?? config.source,
    attempts: attemptsFor(resolved),
    available: resolved.selection.chosen !== null,
    selection: resolved.selection,
    probes: resolved.probes,
    snapshot,
    snapshotAgeSeconds: snapshot === null ? null : snapshotAgeSeconds(snapshot, Date.now()),
    latch,
    config,
    configPath: configText === null ? `${configPath} (absent, using defaults)` : configPath,
    configWarnings: warnings,
    echoSeen: echoSeen !== null && Number.isFinite(echoSeen.ageSeconds) ? echoSeen : null,
    unpriceableFound,
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCode;
}

/**
 * `lum install` — P3-5 + P3-6, and `--codex` from P5-2.
 *
 * Prints the settings block; `--write` applies it after a backup.
 *
 * Both hosts land in one function on purpose. The backup-then-write half is the part that touches
 * a file the user owns and did not ask us to rewrite, and duplicating THAT for a second host is how
 * one of the two copies quietly loses its `.bak`.
 */
export async function runInstall(
  write: boolean,
  guard = false,
  home: string = homedir(),
  codex = false,
): Promise<number> {
  // Both are CONFIGURATION, never transcript data — the same distinction `test/gates/imports.test.ts`
  // forced into the open for `.claude` and now holds for `.codex`.
  const settingsPath = codex
    ? join(home, ".codex", "hooks.json")
    : join(home, ".claude", "settings.json");
  const existing = await readFile(settingsPath, "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);

  const guardPath = resolveBinPath("guard.js");
  const plan = codex
    ? planCodexInstall(existing, "lum", { guard, guardPath })
    : planInstall(existing, "lum", resolveStatuslinePath(), { guard, guardPath });

  if (!write) {
    const rendered = codex ? renderCodexPlan(plan, settingsPath) : renderPlan(plan, settingsPath);
    process.stdout.write(`${rendered.join("\n")}\n`);
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
  // Writing the file is not the same as arming the hook on Codex, and saying "Installed" without
  // this line would overstate what just happened: Codex runs no non-managed hook until it has been
  // reviewed, and it pins that trust to the hook's hash.
  if (codex) {
    process.stdout.write(
      "Now run `/hooks` in Codex and trust them — until then, none of this runs.\n",
    );
  }
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

  // P4-3. `auto` by default, so the common case is unchanged; an explicit `source:` is honoured and
  // a named-but-missing source resolves to null rather than quietly becoming the other one.
  const resolved = await resolveSource(config);
  // A source that could not be selected becomes a source that is down, so `app/` keeps exactly one
  // shape and the existing nine-row degradation matrix handles this without a tenth row.
  const chosen =
    resolved.source ??
    new UnavailableSource(
      config.source === "auto" ? "auto" : config.source,
      resolved.probes.map((pr) => `${pr.id}: ${pr.where}`),
    );
  const source = withTimeout(chosen, SOURCE_TIMEOUT_MS, {
    // Without this a timed-out ccusage keeps reading the corpus after we have stopped waiting.
    // A no-op for jsonfile, which spawns nothing.
    onTimeout: () => resolved.killInFlight(),
  });
  return { config, clock, store, resolved, source };
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
      return await runInstall(
        argv.includes("--write"),
        argv.includes("--guard"),
        homedir(),
        argv.includes("--codex"),
      );
    case "doctor":
      return await runDoctor();
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

/**
 * The resolution ladder to show for the CHOSEN source.
 *
 * ccusage has a real four-tier ladder worth printing — "looked for @ccusage/ccusage-darwin-arm64 in
 * node_modules, then ccusage on PATH" is what tells someone what to install. jsonfile has exactly
 * one place it could be, so its ladder is one rung. Both go through the same field so the renderer
 * does not branch on which adapter won.
 */
function attemptsFor(resolved: Awaited<ReturnType<typeof resolveSource>>): DoctorFacts["attempts"] {
  const probe = resolved.probes.find((p) => p.id === resolved.selection.chosen);
  if (probe === undefined) {
    // Nothing was chosen. The renderer prints the `selected` block instead of a ladder in that
    // case, because that block already lists every candidate with an accurate mark — so handing it
    // rungs here would only give it a second, worse copy of the same list.
    return [];
  }
  return [{ where: probe.where, found: probe.available, detail: probe.where }];
}
