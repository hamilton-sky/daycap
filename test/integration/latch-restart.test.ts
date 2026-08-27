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
// BIN is derived from package.json, not written down here — see the module for why.
import { BIN, BUILT } from "../support/bin-path.ts";

/**
 * P2-5 exit criteria, and P2-3 acceptance #2: a GENUINE restart test.
 *
 * Each run is a separate `node dist/lum.js today` process against the same temp HOME. In-process
 * re-invocation does not count and is explicitly excluded by the acceptance criteria — the whole
 * point is that the latch survives in the FILE, not in a module-level variable that a second
 * call in the same process would happen to see.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE = join(root, "test", "stubs", "fake-ccusage-bin.mjs");

let home: string;
let log: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lum-latch-"));
  log = join(home, "notifications.log");
  mkdirSync(join(home, ".daycap"), { recursive: true });
  const notify = join(home, "notify.sh");
  writeFileSync(notify, `#!/bin/sh\necho "$2" >> "${log}"\n`);
  chmodSync(notify, 0o755);
  writeFileSync(
    join(home, ".daycap", "config.json"),
    JSON.stringify({
      dailyBudgetUsd: 10,
      thresholds: [0.8, 1],
      notifications: { enabled: true, command: [notify, "--title", "{title}"] },
    }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** One `lum today` process with a controlled spend. */
function run(spend: number): void {
  execFileSync(process.execPath, [BIN, "today"], {
    env: {
      ...process.env,
      HOME: home,
      LUM_CCUSAGE_BIN: FAKE,
      LUM_FAKE_TOTAL: String(spend),
    },
    stdio: "ignore",
    timeout: 20_000,
  });
}

const fired = (): string[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
    : [];

const maybe = BUILT && process.platform !== "win32" ? describe : describe.skip;

maybe("latch across separate processes", () => {
  it("0.8 then 1.0 fire exactly once each, with no re-fire on restart or dip", () => {
    run(9); // 0.90 — crosses 0.8
    expect(fired()).toHaveLength(1);

    run(9); // identical spend, brand new process — the restart case
    expect(fired()).toHaveLength(1);

    run(5); // dip below the threshold
    expect(fired()).toHaveLength(1);

    run(9); // back up again — L4: a dip never re-arms
    expect(fired()).toHaveLength(1);

    run(12); // 1.20 — crosses 1.0, and only 1.0
    const all = fired();
    expect(all).toHaveLength(2);
    expect(all[0]).toContain("90%");
    expect(all[1]).toMatch(/over/);
  });

  it("a corrupt latch fires nothing and still exits 0 (L6 — fail quiet)", () => {
    run(9);
    expect(fired()).toHaveLength(1);

    const latch = join(home, ".daycap", "state", "latch.json");
    writeFileSync(latch, '{"schema":1,"usageDay":"2026'); // truncated mid-object

    run(12); // would cross 1.0 — but an unreadable latch must silence the day
    expect(fired()).toHaveLength(1);
  });

  it("a degraded read never fires and never advances the latch (L9)", () => {
    // No collector at all: `lum today` renders (no source) and must not alert on a number it
    // does not have.
    execFileSync(process.execPath, [BIN, "today"], {
      env: { ...process.env, HOME: home, LUM_CCUSAGE_BIN: "/nonexistent/ccusage" },
      stdio: "ignore",
      timeout: 20_000,
    });
    expect(fired()).toHaveLength(0);

    // ...and the crossing is still live afterwards, so a later trusted read fires normally.
    run(9);
    expect(fired()).toHaveLength(1);
  });
});
