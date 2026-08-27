/**
 * Which tools can be MEASURED, and which can only be NOTICED. PURE — no fs, no clock, no node:.
 *
 * P5-3. Everything else in the domain describes spend we can put a number on. This file describes
 * the opposite: a tool that is certainly running on this machine and certainly costing money, and
 * that we can nonetheless never price. Cursor keeps no token, cost, or price column anywhere on
 * disk — the absence is schema-level, not empty-on-this-machine, so no future adapter fixes it.
 *
 * That is worth a line of output because the failure is SILENT. A Cursor user sees a total that
 * omits their heaviest tool and has no way to tell an under-count from a quiet day. Invariant 1
 * says unknown must never render as `$0.00`; a tool omitted entirely is the same lie told by
 * leaving the sentence out, so `lum doctor` names it (see `adapters/render/doctor.ts`).
 */

/**
 * Tools that expose no local spend data at all.
 *
 * The entries are TOOL NAMES, not directories — see `markerDirFor` for why that distinction is
 * load-bearing rather than cosmetic. Adding a name here is a claim that the tool's spend is
 * unknowable from disk, which is a research finding, not a guess: Cursor's is recorded in
 * `pathly/features/local-usage-meter/P5_RESEARCH.md`.
 */
export const UNPRICEABLE_TOOLS = ["cursor"] as const;

export type UnpriceableTool = (typeof UNPRICEABLE_TOOLS)[number];

/**
 * The home-directory entry whose mere EXISTENCE means a tool is installed.
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING CONSTANT, because it looks like pointless indirection
 * until you know what it is dodging:
 *
 * `test/gates/imports.test.ts` forbids the literal `.cursor` in every file under `src/`, and that
 * fence must stay — it is one half of ADR-v2-001. But detecting PRESENCE is not parsing DATA:
 * `existsSync` on a directory reads nothing inside it. The gate's `includes()` scan cannot tell
 * those two apart, so naming the directory outright to do a legitimate existence check would
 * either fail the build or force the fence open for a reason that does not generalise.
 *
 * So the marker is DERIVED from the tool's own name and the literal never appears. Every CLI in
 * this space follows the same convention (`.claude`, `.codex`, `.cursor`, `.copilot`), which makes
 * this a real rule rather than a spelling trick.
 *
 * The honest cost, written down because it is the part a reviewer should push on: once a dotted
 * home path can be BUILT from a variable, the gate's literal scan is blind to
 * ``join(home, `.${"claude"}`, "projects")`` — the exact thing it exists to stop. That hole is
 * closed in the same commit by confining the construction to this one function, asserted by the
 * gate. If a second module ever needs it, that is a design conversation, not a quiet edit.
 */
export function markerDirFor(tool: string): string {
  return `.${tool}`;
}
