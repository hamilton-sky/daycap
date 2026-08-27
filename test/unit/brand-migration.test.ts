/**
 * The rename's migration promise, asserted rather than hoped for.
 *
 * Anyone upgrading from `lum` has `~/.localusagemeter/` on disk holding their config AND their
 * latch. Two different failures if we ignore it:
 *
 *   - config lost  -> budget silently unset, so nothing can be crossed and no alert ever fires
 *   - latch lost   -> every threshold already warned about today re-fires (invariant 2, broken by
 *                     a rename rather than by a bug in the latch)
 *
 * The fallback is READ-ONLY on purpose. Copying would mean writing into a directory the user did not
 * ask us to create, during a command they ran for another reason — and a half-finished copy leaves
 * two configs disagreeing with no way to tell which is live.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultStateDir } from "../../src/adapters/store/atomic.ts";
import {
  CLI_NAME,
  LEGACY_CLI_NAME,
  LEGACY_STATE_DIR_NAME,
  STATE_DIR_NAME,
} from "../../src/domain/brand.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daycap-brand-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("brand constants", () => {
  it("names the product daycap and keeps lum as the compatibility alias", () => {
    expect(CLI_NAME).toBe("daycap");
    expect(LEGACY_CLI_NAME).toBe("lum");
    expect(STATE_DIR_NAME).toBe(".daycap");
    expect(LEGACY_STATE_DIR_NAME).toBe(".localusagemeter");
  });

  it("keeps the two directory names distinct, or the fallback is a no-op", () => {
    expect(STATE_DIR_NAME).not.toBe(LEGACY_STATE_DIR_NAME);
  });
});

describe("defaultStateDir — the upgrade path", () => {
  it("prefers the new directory when it exists", () => {
    mkdirSync(join(home, STATE_DIR_NAME, "state"), { recursive: true });
    expect(defaultStateDir(home)).toBe(join(home, STATE_DIR_NAME, "state"));
  });

  it("falls back to the pre-rename directory, so an upgrade keeps the latch", () => {
    mkdirSync(join(home, LEGACY_STATE_DIR_NAME, "state"), { recursive: true });
    writeFileSync(join(home, LEGACY_STATE_DIR_NAME, "state", "latch.json"), "{}");
    expect(defaultStateDir(home)).toBe(join(home, LEGACY_STATE_DIR_NAME, "state"));
  });

  it("prefers the NEW one when both exist — the old one is never authoritative once migrated", () => {
    // Otherwise a user who moved their files would keep silently reading the stale copy forever.
    mkdirSync(join(home, STATE_DIR_NAME, "state"), { recursive: true });
    mkdirSync(join(home, LEGACY_STATE_DIR_NAME, "state"), { recursive: true });
    expect(defaultStateDir(home)).toBe(join(home, STATE_DIR_NAME, "state"));
  });

  it("returns the NEW path on a fresh machine, so nothing is created under the old name", () => {
    // A first-time user must never end up with a `.localusagemeter` directory.
    expect(defaultStateDir(home)).toBe(join(home, STATE_DIR_NAME, "state"));
  });
});
