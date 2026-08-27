/**
 * Atomic small-file persistence: write to a temp file in the SAME directory, fsync it, then
 * rename over the target.
 *
 * `rename(2)` within one filesystem is atomic, so a reader sees either the whole previous file or
 * the whole new one — never a half-written mixture. That property is what the latch depends on:
 * a torn latch file means a threshold either fires twice or never fires at all, and a budget
 * guardrail that misses the crossing it exists to catch is worse than no guardrail.
 *
 * The fsync BEFORE the rename is the part that is easy to omit and hard to notice. Without it the
 * rename can reach disk while the file's contents have not, so a power loss leaves a correctly
 * named file full of zeroes — the one outcome atomic-rename is supposed to prevent.
 */

import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LEGACY_STATE_DIR_NAME, STATE_DIR_NAME } from "../../domain/brand.ts";

/** The stored bytes are not the value we wrote. Distinct from "absent", which is `null`. */
export class StoreCorruptError extends Error {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`stored value for ${JSON.stringify(key)} is corrupt: ${detail}`);
    this.name = "StoreCorruptError";
    this.key = key;
  }
}

/** The path exists but cannot be read or written — EACCES, EPERM, EROFS. */
export class StoreAccessError extends Error {
  readonly key: string;
  readonly code: string;
  constructor(key: string, code: string, op: string) {
    super(`cannot ${op} ${JSON.stringify(key)}: ${code}`);
    this.name = "StoreAccessError";
    this.key = key;
    this.code = code;
  }
}

const ACCESS_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR"]);

/** Transient on Windows only: the target is momentarily held open by another process. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename(2) is atomic on POSIX even when the target is open. Windows is different: renaming over
 * a file another handle has open fails with EPERM until that handle closes.
 *
 * That is not hypothetical — it is what the concurrent-writers test hit on the Windows CI leg,
 * where a reader holds `today.json` open while eight writers rename over it. Retrying with a short
 * backoff is the standard fix and preserves atomicity: each attempt is still all-or-nothing, we
 * simply wait for the reader to let go.
 */
async function renameWithRetry(tmp: string, target: string, attempts = 40): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = errnoOf(err);
      if (i >= attempts - 1 || code === undefined || !RENAME_RETRY_CODES.has(code)) throw err;
      // 1ms, 2, 4, 8... capped. Windows typically releases the handle within a few ms.
      await sleep(Math.min(2 ** i, 50));
    }
  }
}

function errnoOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Keys are filenames; a key that escapes the base directory is a bug, not a feature. */
function assertSafeKey(key: string): void {
  if (key.length === 0 || key.includes("/") || key.includes("\\") || key.includes("..")) {
    throw new TypeError(`unsafe store key: ${JSON.stringify(key)}`);
  }
}

let counter = 0;

export class AtomicFileStore {
  #dir: string;

  constructor(baseDir: string) {
    this.#dir = baseDir;
  }

  #path(key: string): string {
    return join(this.#dir, `${key}.json`);
  }

  async read<T>(key: string): Promise<T | null> {
    assertSafeKey(key);
    let raw: string;
    try {
      raw = await readFile(this.#path(key), "utf8");
    } catch (err) {
      const code = errnoOf(err);
      if (code === "ENOENT") return null;
      if (code !== undefined && ACCESS_CODES.has(code)) {
        throw new StoreAccessError(key, code, "read");
      }
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Reported, never silently treated as absent. "Absent" makes a caller start fresh; "corrupt"
      // means something wrote bytes we did not, and `lum doctor` should say so.
      throw new StoreCorruptError(key, "not valid JSON");
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    assertSafeKey(key);
    const target = this.#path(key);
    // The temp file MUST live in the same directory: rename is only atomic within one filesystem,
    // and os.tmpdir() is frequently a different mount.
    const tmp = join(this.#dir, `.${key}.${process.pid}.${counter++}.tmp`);
    const body = `${JSON.stringify(value, null, 2)}\n`;

    try {
      await mkdir(this.#dir, { recursive: true });
      const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await fh.writeFile(body, "utf8");
        // Contents durable before the name points at them.
        await fh.sync();
      } finally {
        await fh.close();
      }
      await renameWithRetry(tmp, target);
      await this.#syncDir();
    } catch (err) {
      // Never leave the temp file behind: this runs on every refresh, and a leaked temp per run
      // fills the state directory silently.
      await unlink(tmp).catch(() => {});
      const code = errnoOf(err);
      if (code !== undefined && ACCESS_CODES.has(code)) {
        throw new StoreAccessError(key, code, "write");
      }
      throw err;
    }
  }

  /**
   * fsync the directory so the rename itself survives a power loss.
   *
   * Best-effort: Windows cannot open a directory for fsync and throws EPERM/EISDIR. The rename is
   * still atomic there, so swallowing this loses durability-across-power-loss, not correctness.
   */
  async #syncDir(): Promise<void> {
    try {
      const dh = await open(this.#dir, constants.O_RDONLY);
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // See above.
    }
  }
}

/**
 * `~/.daycap/state`, the one directory `daycap` persists into — falling back to the pre-rename
 * `~/.localusagemeter/state` when it exists and the new one does not.
 *
 * The fallback matters more here than for config: this directory holds the LATCH. Silently starting
 * fresh would re-fire every threshold the user had already been warned about today, which is
 * invariant 2 broken by a rename rather than by a bug in the latch.
 */
export function defaultStateDir(home: string): string {
  const current = join(home, STATE_DIR_NAME, "state");
  if (existsSync(current)) return current;
  const legacy = join(home, LEGACY_STATE_DIR_NAME, "state");
  return existsSync(legacy) ? legacy : current;
}

export { dirname };
