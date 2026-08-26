# P1 build notes — deviations and things the plan could not have known

_Started 2026-08-25, after `P0-4` returned **GO**. Companion to [`SPIKE_RESULT.md`](SPIKE_RESULT.md)._
_Covers `P1-0` (scaffold), `P1-1` (types + ports), `P1-2` (usage-day boundary)._

Everything here is a place where the built thing differs from
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), or where building revealed something the plan
assumed. Recorded so the next task does not rediscover it.

## Done

| Task | State | Notes |
|---|---|---|
| `P1-0` scaffold | **done** | `pnpm verify` green: typecheck → lint → 74 tests → build |
| `P1-1` types + ports | **done** | §3's types and all four ports compile; `tool` is `string`, no enum |
| `P1-2` `usageDayFor` | **done** | 100% branch/line/statement/function coverage on `src/domain/window.ts` |

Not started: `P1-3` (contract suite) onward. **`P1-4` should wait for `PRE-G`.**

## Deviations from the plan

### 1. `pnpm ci` cannot be the gate — renamed to `pnpm verify`

`P1-0`'s acceptance is *"`pnpm ci` runs typecheck → lint → test → build green"*. **`ci` is a built-in
pnpm command** (it reinstalls `node_modules`, like `npm ci`) and it **shadows a script of the same
name**. Running `pnpm ci` deleted `node_modules`, reinstalled, and exited **0 without running a
single check** — a gate that always passes.

The script is `verify`, and `.github/workflows/ci.yml` calls `pnpm verify`. Anyone re-reading
`P1-0` should read "`pnpm ci`" as "`pnpm verify`". (`pnpm run ci` would also work, but a gate whose
correctness depends on remembering to type `run` is not a gate.)

### 2. `src/**/.gitkeep` alone cannot satisfy "build green"

`P1-0` specifies placeholder `.gitkeep` files per §2's tree, but also requires `build` to pass —
and `tsdown` fails with `Cannot find entry` against an empty tree. Two minimal entrypoints exist
ahead of their phases:

- `src/bin/lum.ts` — argument routing and exit codes only. `parseArgs` is exported and pure so it
  is testable. **The commands deliberately do not stub a number**: `lum today` writes
  `not implemented yet` to stderr and exits `69` (`EX_UNAVAILABLE`). Printing `$0.00` here would
  violate DoD #3 during construction, which is exactly when it is least likely to be noticed.
- `src/bin/statusline.js` — the three invariants from §6 hold from the first commit (always exit 0,
  `node:fs` only, never invent a number). Rendering is `P3`; until then it returns
  `lum — (no source)` unconditionally. Verified by hand against a truncated snapshot: exit 0, no
  crash, degraded string.

### 3. Node `>=22`, not `>=20.11`

`README.md` says Node ≥ 20.11; `P1-0` says Node ≥22. Followed the plan (`engines.node: ">=22"`,
`target: node22`, CI on Node 22). The README's figure predates the v2 plan.

### 4. Package name and publishing stay unset (as instructed)

`⟨contingent: PRE-D⟩` honoured: `"private": true`, `"license": "UNLICENSED"`, no publish step. The
bin name `lum` and config dir `~/.localusagemeter/` are kept per the plan's working assumption.

### 5. Coverage thresholds are scoped per-file, not to `src/domain/**`

A directory-wide 100% threshold fails on `types.ts`, which is type-only and emits no runtime code
(a coverage number for it is meaningless). `types.ts` is excluded from the coverage report;
`window.ts` and `ports.ts` each carry their own 100% threshold.

Genuinely unreachable defensive code is marked `/* v8 ignore start/stop */` **with a reason on the
line above**, never silently. Four such places: the ICU-less `hostZone` fallback, the
`Intl`-omitted-field guard, the `hour === 24` normalisation, and `dayElapsedFraction`'s clamps
(unreachable because `usageDayFor` guarantees the instant lies inside its own day). Note the
`v8 ignore next N` form does **not** work when the reason text wraps onto a second line — use
`start`/`stop`.

### 6. `pnpm` needs `allowBuilds` for esbuild, in `pnpm-workspace.yaml`

pnpm 11 blocks install scripts by default and **exits 1**, which breaks CI. The fix is
`allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml` — note that the pnpm 10 spelling
(`onlyBuiltDependencies` in `package.json`) is silently ignored with a warning, and the
`pnpm.onlyBuiltDependencies` field in `package.json` is no longer read at all.

Also: `biome check --write` reformatted `pathly/**/*.json` — the generated Pathly board artifacts.
`pathly` is now excluded in `biome.json`. If a board file shows a spurious one-line diff, this was
why.

## Two bugs found by the tests that were written for them

Both were in `window.ts`, both silent, both would have produced plausible wrong numbers.

**1 — DST gap resolved backwards.** The classic two-pass offset refinement (offset at the naive
guess, then offset at that result) resolves a spring-forward gap **backwards** in
`America/New_York` and **forwards** in `Europe/London`, depending on which side of the transition
the naive guess lands. With `resetHourLocal = 2` on 2026-03-08 in New York it put the day boundary
at 01:00 EST, making a **23-hour day 24 hours long** — pacing would read ~4% low all day, and the
day would overlap its neighbour.

Replaced with: probe the offsets a day either side (transitions are never within 24 h of each
other), verify each candidate by formatting it back, then take the *earlier* valid one (fall-back
ambiguity → first occurrence) or, when neither is valid, the *later* (gap → shift forward, matching
Temporal's `compatible` mode). Both zones are now pinned by tests in both directions.

**2 — the CLI ran on import.** `src/bin/lum.ts` called `main()` at module top level, so importing it
to test `parseArgs` executed the CLI: stderr output mid-suite and a mutated `process.exitCode`. Now
guarded by an `import.meta.url` vs `process.argv[1]` check.

## Carried forward from the spike into the code

These are in comments at the point of use, not only in the spike report:

- `usageDayRange` returns a **half-open** `[from, to)` window, with budi-HTTP-exclusive /
  budi-CLI-inclusive / ccusage-inclusive named at the definition. Adapters convert; the domain has
  one convention.
- `SourceHealth` has a **`not-backfilled`** variant, because a freshly installed budi answers
  successfully with zero rows until `budi db import` runs (`SPIKE_RESULT.md` §1a.2). Without a
  distinct state that is indistinguishable from an idle day.
- `Config.timezone` exists so the `PRE-G` axis is explicit and testable. It does **not** decide
  `PRE-G`. `test/unit/window.test.ts` has a `PRE-G — the axis is observable` case asserting that one
  instant lands on different days under UTC and local.

## For `P1-3`, next

The plan's 14 contract cases stand. Three additions the spike argues for:

1. **C8 is more important than it reads.** budi returns HTTP 200 with **all-time** data for an
   unrecognised range parameter — $912.87 as "today" on the spike machine. C8 must assert the
   adapter *proves* the range was honoured (two disjoint historical windows must differ), not merely
   that a window was passed.
2. **A `[]`-is-not-zero case.** `since=D&until=D` returns an empty array from budi HTTP. The port
   must map that to *unknown*, not `$0.00`.
3. **A cloud-sync-is-off assertion for `lum doctor`.** budi's default cloud privacy mode is `full`
   ("raw session titles uploaded"). Inert unless someone runs `budi cloud init`, but this project
   promises nothing leaves the machine, and that promise now depends on a dependency's config.

Fixtures for 1 and 2 are already frozen: `providers-all-time.json` and
`providers-empty-exclusive-until.json`.
