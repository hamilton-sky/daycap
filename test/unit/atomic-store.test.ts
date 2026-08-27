import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtomicFileStore, StoreCorruptError } from "../../src/adapters/store/atomic.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lum-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bigValue = (tag: string) => ({ tag, filler: "x".repeat(256 * 1024) });

describe("AtomicFileStore — basics", () => {
  it("round-trips a value", async () => {
    const s = new AtomicFileStore(dir);
    await s.write("today", { schema: 1, totalUsd: 12.34 });
    await expect(s.read("today")).resolves.toEqual({ schema: 1, totalUsd: 12.34 });
  });

  it("returns null for an absent key — absent is not an error", async () => {
    await expect(new AtomicFileStore(dir).read("nope")).resolves.toBeNull();
  });

  it("creates the state directory on first write", async () => {
    const nested = join(dir, "a", "b", "state");
    await new AtomicFileStore(nested).write("k", { v: 1 });
    await expect(new AtomicFileStore(nested).read("k")).resolves.toEqual({ v: 1 });
  });

  it("reports corruption instead of pretending the key is absent", async () => {
    const s = new AtomicFileStore(dir);
    await s.write("latch", { v: 1 });
    writeFileSync(join(dir, "latch.json"), '{"truncated": ');
    // null would make a caller start fresh and silently re-arm a fired threshold.
    await expect(s.read("latch")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it.each(["../escape", "a/b", "a\\b", ""])("rejects the unsafe key %j", async (key) => {
    await expect(new AtomicFileStore(dir).write(key, {})).rejects.toBeInstanceOf(TypeError);
  });

  it("leaves no temp files behind", async () => {
    const s = new AtomicFileStore(dir);
    for (let i = 0; i < 20; i++) await s.write("today", { i });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

/**
 * These two assert CORRECTNESS, not speed, and so they carry an explicit and generous wall-clock
 * budget rather than vitest's 5s default.
 *
 * WHY, from a real failure: the concurrent-writers case timed out at 5000ms on a Windows CI runner
 * while asserting nothing about time. Layer D, added in the same commit, recorded what that runner
 * was doing — bare `node -e ""` p95 of 447ms, roughly 17x its normal 26ms — so the machine was
 * saturated and 8 concurrent 4MB write loops could not finish inside the default. Locally the same
 * case takes ~1.2s.
 *
 * A timeout is a latency assertion whether or not you meant it as one. Leaving the default here
 * meant "atomicity holds" and "this runner is not busy" shared a single red light, and the second
 * one is not a property of this code. 120s is far past any plausible honest duration; if either of
 * these ever really hangs, it hangs, and 120s still reports it.
 */
const ATOMICITY_BUDGET_MS = 120_000;

describe("AtomicFileStore — atomicity", () => {
  it("a reader never observes a torn file under concurrent writers", {
    timeout: ATOMICITY_BUDGET_MS,
  }, async () => {
    const s = new AtomicFileStore(dir);
    await s.write("today", bigValue("seed"));

    let stop = false;
    const writers = Array.from({ length: 8 }, (_, w) =>
      (async () => {
        for (let i = 0; i < 25 && !stop; i++) await s.write("today", bigValue(`w${w}-${i}`));
      })(),
    );

    // Read as fast as possible while 8 writers churn 256 KB payloads through the same key.
    let reads = 0;
    const reader = (async () => {
      while (!stop && reads < 400) {
        const v = (await s.read<{ tag: string; filler: string }>("today")) as {
          tag: string;
          filler: string;
        } | null;
        // Yield between reads. Without it the target is held open essentially continuously, and on
        // Windows — where rename-over-an-open-file fails with EPERM — no retry budget can ever find
        // a gap. The test is meant to discriminate atomicity, not to model a workload `lum` never
        // produces: it writes this file once per invocation, not hundreds of times a second.
        await new Promise((r) => setTimeout(r, 1));
        if (v !== null) {
          // A torn file would parse as garbage or truncate the filler.
          expect(v.filler.length).toBe(256 * 1024);
          expect(typeof v.tag).toBe("string");
        }
        reads++;
      }
    })();

    await Promise.all(writers);
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(0);
  });

  /**
   * Node 22+ only, and the constraint is the TEST HARNESS, not the code under test.
   *
   * The child below imports `atomic.ts` directly under `--experimental-strip-types`, which arrived
   * in Node 22.6. On Node 20 that flag does not exist, so the child exits before writing anything
   * and the case times out waiting for writes that never happen — a red build saying nothing about
   * atomicity. `dist/` is plain JS and runs on the floor `engines` claims; only this harness needs
   * 22, which is why the skip is here rather than the floor being raised back to satisfy it.
   *
   * Found by the `node20-compat` CI job: 626 of 648 tests passed on Node 20, and this was the one.
   */
  const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
  const stripsTypes = NODE_MAJOR >= 22 ? it : it.skip;

  stripsTypes(
    "SIGKILL mid-write never leaves a torn file",
    { timeout: ATOMICITY_BUDGET_MS },
    async () => {
      const s = new AtomicFileStore(dir);
      // .href, not .pathname: a bare Windows path is not a valid ESM specifier.
      const storePath = new URL("../../src/adapters/store/atomic.ts", import.meta.url).href;

      // The child runs EIGHT concurrent write loops, not one.
      //
      // Measured: with a single loop this test caught a deliberately non-atomic write() only 3 times
      // in 5 runs, because SIGKILL usually landed between writes rather than during one. A detector
      // that fires 60% of the time is worse than none — it flakes both ways and gives false
      // confidence. With eight writes in flight at all times, a kill lands inside one of them
      // essentially always, so the case is a reliable discriminator rather than a coin flip.
      const SIZE = 4 * 1024 * 1024;
      for (let trial = 0; trial < 3; trial++) {
        await s.write("today", { generation: "previous", size: 16 });

        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            "-e",
            `const { AtomicFileStore } = await import(${JSON.stringify(storePath)});
           const s = new AtomicFileStore(${JSON.stringify(dir)});
           const big = "z".repeat(${SIZE});
           const loop = async () => { for (;;) await s.write("today", { generation: "child", size: big.length, filler: big }); };
           await Promise.all(Array.from({ length: 8 }, loop));`,
          ],
          { stdio: "ignore" },
        );

        await new Promise((r) => setTimeout(r, 150 + trial * 80));
        child.kill("SIGKILL");
        await new Promise((r) => child.on("exit", r));

        const raw = readFileSync(join(dir, "today.json"), "utf8");
        let parsed: { generation: string; size: number };
        try {
          parsed = JSON.parse(raw) as { generation: string; size: number };
        } catch {
          throw new Error(
            `trial ${trial}: today.json is torn — ${raw.length} bytes of unparseable JSON`,
          );
        }
        expect(["previous", "child"]).toContain(parsed.generation);
        // The declared size must match the filler that is actually there: a truncated write would
        // pass a bare JSON.parse only by accident, but cannot keep this invariant.
        const expectedSize = parsed.generation === "child" ? SIZE : 16;
        expect(parsed.size).toBe(expectedSize);
        if (parsed.generation === "child") {
          expect((parsed as unknown as { filler: string }).filler.length).toBe(SIZE);
        }
      }
    },
  );
});
