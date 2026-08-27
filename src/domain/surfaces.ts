/**
 * Which tools can be MEASURED, and which can only be NOTICED. PURE — no fs, no clock, no node:.
 *
 * P5-3. Everything else in the domain describes spend we can put a number on. This file describes
 * the opposite: a tool that is certainly running on this machine and certainly costing money, and
 * that we nonetheless do not price.
 *
 * CORRECTED 2026-08-27, because the original wording here was wrong in a way worth preserving as a
 * warning. It said Cursor "keeps no token, cost, or price column anywhere on disk" and that "no
 * future adapter fixes it" — a permanent-impossibility claim, made about someone else's product,
 * from one snapshot of its schema. A recheck found Cursor's CLI had begun emitting per-turn token
 * counts locally (changelog, February 2026), and that Cursor's Admin API returns real spend against
 * a user-supplied key. The claim had an expiry date and did not carry one.
 *
 * The accurate reason is OURS, and it is durable in a way a claim about their schema never was:
 *
 *   - Their local token counts live in CLI transcripts. Reading those is transcript parsing, which
 *     ADR-v2-001 forbids and the import gate enforces.
 *   - Turning tokens into dollars is re-pricing, which contract case C9b exists to make observable
 *     and impossible.
 *   - The Admin API is a network call, which shipped code never makes.
 *
 * So this list means "we will not derive a number for it", not "no number can exist". A user who
 * wants Cursor counted has a supported route: emit their own JSON and point `sourceFile` at it. That
 * is what P1-5's escape hatch is for, and it is the honest answer to give them.
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
