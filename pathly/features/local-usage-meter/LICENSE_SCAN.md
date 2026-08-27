# License scan — `P4-6`

**Run 2026-08-27** against `main` @ `7664f55`. Re-run before any release; the method is at the
bottom so the numbers can be reproduced rather than trusted.

---

## 1. The published artifact carries no third-party code at all

This is the finding that makes the rest of the scan short.

`package.json` `files` publishes exactly three things — `dist/`, `src/bin/statusline.js`, and
`src/bin/guard.js` — and **`dependencies` is empty**. Not "small": empty. `pnpm list --prod
--depth Infinity` returns nothing.

Verified at the artifact rather than at the manifest, because a manifest describes intent and a
bundle describes fact:

| Shipped file | Modules it pulls in | Third-party |
|---|---|---|
| `dist/lum.js` | `node:module`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`, `node:child_process`, `node:timers/promises` | **none** |
| `src/bin/statusline.js` | `node:fs`, `node:os`, `node:path`, `node:url` | **none** |
| `src/bin/guard.js` | `node:fs`, `node:os`, `node:path`, `node:url` | **none** |

So the runtime license surface is our own license plus Node itself. There is nothing to attribute,
nothing to vendor, and no transitive obligation to track.

That is a consequence of the architecture rather than a coincidence: ADR-v2-001 says consume a
collector instead of parsing logs, which is what removes the parser, the watcher and the date
library that would each have arrived with a license. The hot-path import gate
(`test/gates/imports.test.ts`) is what keeps it true — `statusline.js` and `guard.js` may import
four `node:` modules and nothing else, and the build fails otherwise.

**One methodological note, because the first attempt got this wrong.** A regex for `from "…"` over
the bundle reported a third-party module called `the collector confirms zero spend`. That is prose
from a comment in `resolve.ts`, surviving into the bundle because tsdown preserves comments. The
scan strips comments before matching. A license scan that reports a false positive is a license scan
someone stops reading, so the stripping is part of the method, not a tidy-up.

## 2. The dev tree is entirely permissive

Not distributed — recorded because "we checked" is worth being able to say with a number.

**146 distinct packages** across the whole pnpm store:

| Count | License |
|---|---|
| 117 | MIT |
| 13 | ISC |
| 6 | BSD-3-Clause |
| 5 | BlueOak-1.0.0 |
| 3 | Apache-2.0 |
| 2 | MIT OR Apache-2.0 |

**Nothing copyleft, source-available, or unstated.** No GPL / AGPL / LGPL, no SSPL, no BUSL, no
CC-BY-NC, and no package with a missing or `UNLICENSED` field.

## 3. `ccusage` is spawned, never redistributed

`ccusage@20` is **MIT**, across its own tree.

It matters less than it looks: we never bundle or re-ship it. `lum` spawns whatever the user
installed, and the README tells them to install it themselves. There is no redistribution, so no
attribution obligation attaches to our artifact — the MIT note here is for completeness, and because
a reader who sees us recommend an install will reasonably want to know what it is.

---

## 4. Two things this scan cannot decide

Both are the owner's call, both block release, and neither is a code change.

### ~~`license` is `UNLICENSED`, and there is no `LICENSE` file~~ — RESOLVED 2026-08-27: MIT

```json
"license": "UNLICENSED"
```

This is the real blocker in this section. `UNLICENSED` is not a placeholder meaning "not decided" —
it is a positive statement that nobody may use the software. Publishing a public repo with it says
"you may read this and may not run it", which is almost certainly not the intent for a tool whose
whole pitch is that people install it in one command.

Recommendation, not a decision: **MIT**. It matches all 146 dev packages, it matches `ccusage`,
it is what the ecosystem this tool lives in expects, and it imposes nothing on us. Apache-2.0 is
the reasonable alternative if patent language is wanted.

**Resolved: MIT.** Both halves done — the `license` field and a `LICENSE` file, because the field
alone is not the grant. `npm pack --dry-run` confirms `LICENSE` is in the tarball (npm includes it
regardless of `files`, but "npm probably does that" is not the same as having looked).

### ~~`engines` requires Node 22~~ — RESOLVED 2026-08-27: `>=20.11`, with a CI job behind it

```json
"engines": { "node": ">=22" }
```

Grepping for anything 22-only — `node:sqlite`, the stable test runner, `--experimental` flags —
found **nothing**. Older planning documents said `>=20.11`, so this floor may have drifted upward
without a reason attached to it.

It is not free: Node 20 is still in maintenance LTS and a `>=22` floor makes `npm i -g` fail outright
for those users, which is a strange first impression for a tool selling zero setup.

**Resolved by getting the evidence rather than arguing.** A `node20-compat` CI job now installs
under 22 and runs typecheck plus tests under 20; the floor is `>=20.11`.

Two things that job found, both worth knowing:

- **pnpm cannot run on Node 20 at all.** `pnpm@11.23.0` imports `node:sqlite`, absent before Node 22,
  so the first attempt — a `node: [20, 22]` matrix dimension — died inside `pnpm/action-setup` before
  reaching any of our code. The question was never asked, let alone answered. Hence install-under-22,
  run-under-20. The constraint is the toolchain's, not the product's: nobody installing `lum` uses
  pnpm.
- **626 of 648 tests passed on Node 20**, and the one failure was the test HARNESS: the SIGKILL
  atomicity case spawns a child importing `atomic.ts` under `--experimental-strip-types`, a Node 22.6
  flag. It now skips below 22 with that reason in the code. Raising the floor for every consumer to
  accommodate one test's harness would have been the tail wagging the dog.

A third, unrelated thing it exposed is recorded in §6.

---

## 5. Method

```bash
# 1. Is anything shipped at all beyond our own code?
node -e 'console.log(require("./package.json").dependencies ?? "NONE")'
pnpm list --prod --depth Infinity

# 2. What does the built artifact actually import? (comments stripped first)
#    See §1 — the un-stripped version produces false positives from prose.

# 3. Whole-store license tally, walking node_modules/.pnpm
#    (pnpm licenses list reports nothing useful here precisely because the prod tree is empty)

# 4. The spawned collector
npm view ccusage@20 license --json
```

---

## 6. ~~A side-effect worth recording: `layer C` is contention-sensitive~~ — RESOLVED 2026-08-27

Not a license finding. It belongs here because this scan's own follow-up work is what surfaced it.

Doubling the CI matrix to test Node 20 took the job count from three to six, and
`layer C — absolute wall clock is < 150ms p95` failed on the Windows runner at **188.5 ms** — on a
commit that touched only CI config and a version string. It had passed on the two PRs immediately
before. Reverting to three jobs made it pass again.

So layer C is partly measuring how busy the runner is. That is the same defect `a7dee06` fixed for
layer B, arriving from the other direction — and this time it was my own change to the harness that
perturbed what the harness measures.

**Resolved by fixing what the gate measured rather than what it permitted.** Four changes, two
loosening and two tightening, in one commit:

- **Layer C** now asserts `p95(script) < p95(bare) + 120ms`, calibrated against the same run's own
  interpreter boot. On idle macOS that is a ~146ms ceiling — indistinguishable in strictness from the
  old flat 150 — and on a slow Windows runner it scales with the platform instead of failing it. The
  120ms is derived: twice the worst batched two-p95 noise measured under deliberate core saturation
  (57.7ms), against real observed CI failures of 34.1 and 40.6ms.
- **The absolute 150ms** is now asserted only under `DAYCAP_PERF=1`, on a machine someone quietened
  on purpose. Written down as a loss, not glossed: **no CI leg asserts it.** It belongs in the
  pre-release checklist, and it is now in HANDOFF §7.
- **Layer A2** is new and is the compensation. `IMPLEMENTATION_PLAN.md:394` always specified layer A
  as "read cache + parse stdin + format", but as built it timed `render()` alone — so the two
  `readFileSync` calls, the only I/O on the hot path, were measured nowhere except through a whole
  process spawn where Node's boot buries them. Now timed end to end, on every platform, budget 5ms
  against a measured p95 of 0.045ms.
- **Layer B stays at 30ms**, and the attempt to tighten it is worth recording. It was set to 20 in
  an earlier draft, justified by the worst median-of-pairs under deliberate core saturation — 8.7ms,
  measured on macOS. **Layer D disproved that within one CI run**, which is precisely why layer D
  exists: the Windows runner reported median pairs of 17.5, 11.0, 5.3 and 17.2ms for the same
  statistic, twice the macOS figure. 20ms against a 17.5ms observation is 1.14x margin — a flake
  waiting for a busy afternoon. 30 is now evidence-based rather than inherited: 1.7x the worst real
  Windows observation. Extrapolating one platform's noise onto another was the mistake.
- **Layer D** finally exists, as `IMPLEMENTATION_PLAN.md:397` specified and nobody built: bare p95,
  script p95, delta, median pair and headroom used, printed every run, asserting nothing. A perf
  suite that speaks only when it fails cannot show a trend.

### What the recheck turned up about the number itself

**150 was never a spawn-time budget.** `IMPLEMENTATION_PLAN.md:362` defines it as an IN-PROCESS
budget enforced by a self-timeout — "Self-timeout at 150 ms prints the degraded line and exits 0."
That timer does not exist and cannot: the read path is fully synchronous, so no timer can fire while
`readFileSync` blocks. Layer C inherited the number for a different quantity, and the CI matrix was
merely the trigger that exposed it. Widened layer A2 is that claim's real home.

Also corrected: an earlier note in this session called `p95`'s behaviour at n=30 an arithmetic bug.
It is not. `Math.floor(30 * 0.95) = 28` is index 28, the 29th of 30 — exactly nearest-rank P95, the
textbook estimator. The near-maximality is a property of n=30 and no index change fixes it; for a
*ceiling* assertion it errs conservative, which is the right direction. The helper is untouched,
because layer A shares it and any "small-n fix" would silently shift a passing, unrelated threshold.

### Mutation-verified sensitivity ladder

A perf gate never observed to fail is decoration, so it was made to fail on purpose (stall injected
into `readJson`, file restored byte-identical afterwards):

| injected regression | caught by |
|---|---|
| none | nothing — green, so the gates are not vacuous |
| ~2 ms | **nothing** — the honest sensitivity floor |
| ~6 ms | layer A2 |
| ~30 ms | layer A2, layer B |
| ~200 ms | layer A2, layer B, layer C |

The ~2ms floor is recorded rather than tuned away: on a path costing 0.03ms it is a real multiple,
but 2ms on a prompt is imperceptible, and chasing it would mean setting a budget close enough to the
noise that the suite starts reporting the platform again — which is the exact mistake being fixed.

### Two more things the first CI run of this change turned up

**A negative delta, and what it proves.** One Windows job reported `bare p95 447.4ms | script p95
233.5ms | delta -213.9ms`. The bare interpreter's p95 came out *higher* than the script's, which is
impossible as a measurement of our code and is therefore direct evidence that a batched p95 on a
loaded runner reports the scheduler. Layer C passes trivially in that state rather than failing
falsely, and layer D says so out loud at `headroom used -178%` — which is the correct behaviour for a
gate whose input has become noise, and the reason the median-of-pairs in layer B is the real guard.

**An unrelated flake, fixed by the same insight.** `AtomicFileStore — a reader never observes a torn
file under concurrent writers` timed out at vitest's 5000ms default on that same saturated runner —
*while asserting nothing about time*. It takes ~1.2s locally. A timeout is a latency assertion whether
or not you meant it as one, and leaving the default there meant "atomicity holds" and "this runner is
not busy" shared one red light. Both atomicity cases now carry an explicit 120s budget with that
reasoning attached.
