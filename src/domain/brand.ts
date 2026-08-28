/**
 * The product's own name, in one place. PURE — constants only, no `node:` imports.
 *
 * This file exists because of a bug the rename would otherwise have shipped. `runInstall` used to
 * pass a hardcoded `"lum"` into `planInstall`, and that string is written VERBATIM into the user's
 * `~/.claude/settings.json` as `"command": "lum refresh"`. So the CLI's name is not a cosmetic
 * label — it is a value persisted into a file we do not own, on a machine we cannot revisit. A
 * rename that missed this line would leave every existing install pointing at a command that no
 * longer exists, and hooks fail SILENTLY: no statusline updates, no guard enforcement, no error.
 *
 * Keeping it as a constant means the next rename is one edit, and the compatibility alias below is
 * a deliberate decision with a written expiry rather than an accident.
 */

/** What the user types, and what gets written into their hook config. */
export const CLI_NAME = "daycap";

/**
 * The previous command name, still shipped as a `bin` alias.
 *
 * NOT decoration, and not sentiment. Anyone who ran `lum install --write` before this rename has
 * `"command": "lum refresh"` sitting in their `settings.json`. Dropping the alias would break them
 * with no diagnostic — the failure mode is a guardrail that quietly stops guarding, which is the
 * one outcome this project treats as worse than not existing (invariant 3, in spirit).
 *
 * Retire it only after `daycap install --write` has had a release to rewrite those blocks, and
 * delete this constant in the same commit so nothing keeps referring to a name that is gone.
 */
export const LEGACY_CLI_NAME = "lum";

/**
 * The directory we persist into, under the user's home.
 *
 * Renamed with the product. `LEGACY_STATE_DIR_NAME` is read as a fallback when this one is absent,
 * so an upgrade does not silently orphan a user's latch and cached snapshot — losing the latch
 * would re-fire every threshold they had already been warned about.
 */
export const STATE_DIR_NAME = ".daycap";

/** The pre-rename directory. Read when `STATE_DIR_NAME` does not exist; never written. */
export const LEGACY_STATE_DIR_NAME = ".localusagemeter";

/**
 * Which of the two directory names is live, given whether each exists. PURE — the caller does the
 * `existsSync`, so this stays testable and the domain stays clean.
 *
 * WHY THIS IS ONE FUNCTION AND NOT A CHECK PER FILE, learned the hard way:
 *
 * The first version decided per file. `configPathFor` preferred `~/.daycap/config.json` when that
 * FILE existed; `defaultStateDir` preferred `~/.daycap/state` when that DIRECTORY existed. Those are
 * different questions, and on a real machine they gave different answers — a freshly written
 * `~/.daycap/config.json` with no `~/.daycap/state` yet, alongside a `~/.localusagemeter/state` left
 * over from before. Config was read from the new home and the latch was written to the old one.
 *
 * Nothing was lost and the tool worked, which is what made it insidious: two directories, no error,
 * and no way for the user to find out. This project's whole thesis is saying where the number came
 * from, and it could not say where it kept its own state.
 *
 * So the directory is decided ONCE per run and both files follow it. A split is now unrepresentable
 * rather than merely unlikely.
 */
export function stateDirName(hasCurrent: boolean, hasLegacy: boolean): string {
  if (hasCurrent) return STATE_DIR_NAME;
  return hasLegacy ? LEGACY_STATE_DIR_NAME : STATE_DIR_NAME;
}
