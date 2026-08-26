import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Gate 3 of 3 — the privacy canary (ADR-v2-004).
 *
 * The stub collector's payload carries canary strings in exactly the fields a real payload uses
 * for repository names, session titles and file paths. This drives the WHOLE pipeline as a real
 * process and asserts none of them reach any of the four places user data could escape to:
 *
 *   rendered stdout · the snapshot file · the latch file · the notification argv
 *
 * Unit tests already assert the adapter does not copy them. This is the end-to-end version,
 * because the leak that matters is the one that happens two layers after the adapter.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(root, "dist", "lum.js");
const FAKE = join(root, "test", "stubs", "fake-ccusage-bin.mjs");
const CANARIES: string[] = JSON.parse(
  readFileSync(join(root, "test", "fixtures", "collector", "CORPUS.json"), "utf8"),
).canaries;

let home: string;
let argvLog: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lum-privacy-"));
  argvLog = join(home, "notify-argv.log");
  mkdirSync(join(home, ".localusagemeter"), { recursive: true });
  const notify = join(home, "notify.sh");
  // Records the FULL argv, so a canary smuggled into any argument is caught.
  writeFileSync(notify, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\n`);
  chmodSync(notify, 0o755);
  writeFileSync(
    join(home, ".localusagemeter", "config.json"),
    JSON.stringify({
      dailyBudgetUsd: 10,
      thresholds: [0.8, 1],
      notifications: { enabled: true, command: [notify, "--title", "{title}", "--body", "{body}"] },
    }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const built = existsSync(BIN);
const maybe = built && process.platform !== "win32" ? describe : describe.skip;

maybe("gate: privacy canary — end to end", () => {
  it("has canaries to look for", () => {
    expect(CANARIES.length).toBeGreaterThan(3);
  });

  it("no canary reaches stdout, the snapshot, the latch, or the notification argv", () => {
    const stdout = execFileSync(process.execPath, [BIN, "today"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, LUM_CCUSAGE_BIN: FAKE, LUM_FAKE_TOTAL: "12" },
      timeout: 20_000,
    });

    const stateDir = join(home, ".localusagemeter", "state");
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    const surfaces: Array<[string, string]> = [
      ["rendered stdout", stdout],
      ["snapshot", read(join(stateDir, "today.json"))],
      ["latch", read(join(stateDir, "latch.json"))],
      ["notification argv", read(argvLog)],
    ];

    // Sanity: the run must actually have produced these, or the assertions below prove nothing.
    expect(stdout).toContain("$12.00");
    expect(read(join(stateDir, "today.json"))).toContain("totalUsd");
    expect(read(argvLog).length).toBeGreaterThan(0);

    for (const [name, content] of surfaces) {
      for (const canary of CANARIES) {
        expect(content, `${canary} leaked into ${name}`).not.toContain(canary);
      }
    }
  });

  it("the stub really does emit the canaries — otherwise this gate proves nothing", () => {
    const raw = execFileSync(process.execPath, [FAKE, "daily", "--json", "--since", "20260826"], {
      encoding: "utf8",
      env: { ...process.env, LUM_FAKE_TOTAL: "12" },
    });
    for (const canary of CANARIES.slice(0, 2)) expect(raw).toContain(canary);
  });
});
