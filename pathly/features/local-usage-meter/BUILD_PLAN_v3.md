# BUILD PLAN v3 — the path to a shippable `lum`

**SUPERSEDED IN PART — see `HANDOFF.md` (2026-08-27) for current state.** Everything in §4's DAG
through `P4-4` is now merged to `main`, plus a guard that did not exist when this was written. §5's
gate recommendations still stand; §1's competitive framing is CORRECTED by
`COMPETITIVE_ANALYSIS.md` — a proxy *can* see subscription usage, so the differentiator is setup
cost, not capability.

**Status: 2026-08-26.** Supersedes the sequencing in `IMPLEMENTATION_PLAN.md`. That document
remains authoritative for individual task acceptance criteria; this one is authoritative for
**order, gates, and scope**.

Written after three things were measured rather than assumed. Each one changed the plan.

---

## 1. The three findings that drove the re-plan

### 1.1 ccusage v20 is a compiled native binary, not TypeScript

Verified from the npm manifest: `ccusage@20.0.20` declares **no `main` and no `exports`** — only
`bin` — and ships per-platform prebuilt binaries as `optionalDependencies`
(`@ccusage/ccusage-darwin-arm64`, `-linux-x64`, `-win32-x64`, …). This is the esbuild/swc
distribution pattern.

Two consequences:

1. **There is no Node-importable API.** A shell-out adapter is mandatory. Do not design around
   `import('ccusage')`.
2. **The `1.2 s warm / 3.4 s cold` figure in `SPIKE_RESULT.md` is measuring `npx`, not ccusage.**
   `npx -y` pays registry resolution plus a Node spawn before the collector runs at all. The
   binary itself is native. **This number must be re-measured** (task `M-1`) before `PRE-F`'s
   urgency is taken at face value — the whole "the snapshot cache is load-bearing" argument rests
   on it.

### 1.2 `npx` is not just slow — it is already forbidden

`npx` performs registry resolution, which is a **non-loopback network call**, which `P1-9`'s
network gate fails the build for. So "don't shell out via npx" stops being a code-review note and
becomes a CI assertion. Binary resolution is a four-tier ladder (§4.1); `npx` is not the last rung,
it is off the ladder.

### 1.3 `PRE-F` has a fourth option the docs never considered

Claude Code has a documented **hooks** system (`SessionStart`, `SessionEnd`, `Stop`,
`PostToolUse`, `UserPromptSubmit`) and command hooks support `"async": true` and a `timeout`.

So `lum` can refresh its snapshot on real lifecycle events with **no resident daemon and no
statusline self-spawn**. That does not *answer* `ARCH_QUESTION 4` (may a background process appear
unasked?) — it **dissolves** it, because there is no longer any benefit to buy with the consent
cost.

Use **`Stop`** (one refresh per assistant turn) and `SessionStart` (warm the cache).
**Do not use `PostToolUse`** — it fires many times per turn, and a collector spawn per tool call is
literally ccusage issue #455 (statusline spawns accumulating until OOM) reproduced inside our own
tool. Throttle regardless: `mtime` on `state/last-refresh`, ≥ 5 s, checked before any spawn.

---

## 2. The structural move: gates become defaults, not forks

The old plan treated each open gate as a **code fork** — "if `PRE-F` lands differently, re-read
this task". That is why nothing was buildable while six gates sat open.

Findings 1.1–1.3 let every remaining gate become a **config default** instead. A gate that only
sets a default value blocks nothing: build both branches for ~20 extra lines, flip a constant
later.

```
BEFORE                                  AFTER
  PRE-C  ─► which adapter is built        (withdrawn: not on the critical path)
  PRE-F  ─► whether refresh exists        refreshVia default
  OPEN-F ─► what budget.ts accepts        alertOn: "auto" | "usd" | "rate-limit"
  ARCH-Q1─► accountMode config shape      resolver default
  ARCH-Q4─► whether we self-spawn         answered: never
```

**Result: 1 of 22 remaining tasks is genuinely blocked on a human** — `P4-6 release readiness`,
which needs `PRE-B` (demand) and `PRE-D` (the name). Nothing publishes until then. Everything else
is buildable now.

The four working defaults, recorded as **assumptions with an owner**, not as decisions:

```
alertOn:      "auto"     (OPEN-F)   — rate-limit where the surface has it, USD otherwise
refreshVia:   "hooks"    (PRE-F)    — installed only by an explicit `lum install`
autoRefresh:  false      (ARCH-Q4)  — no self-spawn, ever
accountMode:  "auto"     (ARCH-Q1)  — resolved from evidence, not defaulted to subscription
```

---

## 3. Amendments to the P1 domain (DONE — 2026-08-26)

Each is load-bearing for a contract case, and each was ~10× cheaper before the render layer
existed than after.

| Change | Why |
|---|---|
| `ToolSpend.usd: number \| null` | `usd: number` cannot express *"the collector reported activity it could not price."* The only way to say it becomes `0`, and the render layer can no longer tell "unpriced" from "$0.00" — which is the exact failure DoD #3 forbids. Pinned by `C9c`. |
| `UsageWindow` gains `tz: string` | A day-granularity collector must map an instant range back onto calendar dates, and that needs a zone. An adapter reaching for `process.env.TZ` makes `C14` unpassable by construction. |
| `UsageSourcePort` gains `granularity` | ccusage reports whole calendar days. Without this, `C8`'s sub-day assertion fails ccusage for something that is not a defect, and `app/meter.ts` has no basis for `dayBoundaryApprox`. The adapter states the **fact**; `app/` owns the **policy**. |
| new `src/domain/errors.ts` | `SourceError` base + `SourceIncompatibleError`, `SourceTimeoutError`, `SourceUnavailableError`. Typed channels so `meter.ts` maps failures by type, never by matching stack strings. |
| new `src/adapters/source/timeout.ts` | Timeouts leave the adapters and become `withTimeout(source, ms)`. Enforced once, tested once, and `timeoutMs` becomes per-source config — so a fast collector gets a tight budget and a slow one a loose one. An adapter author can no longer forget it. |

---

## 4. Re-sequenced DAG

Changes from `IMPLEMENTATION_PLAN.md`:

1. **`P0-1`/`P0-2` (budi HTTP probe) off the critical path.** Answering `PRE-C` costs a 13 MB
   install to settle a question that changes nothing on the ccusage path.
2. **`ccusage.shellout.ts` promoted `P4-1` → `P1-4` (primary).**
3. **`budi.http.ts` deleted from v1** — not demoted. The docs themselves call it *"a local daemon's
   internal surface, not a published contract."* Adapting to the least stable surface of the least
   active project (25 stars, no push since 2026-05-26), first, was the riskiest possible ordering.
4. **`P1-5` second adapter changed from `budi.cli.ts` to `jsonfile.ts`.** A fake-binary contract
   test for a collector nobody has run is fiction and buys false R2 confidence. `jsonfile.ts` is
   real, is the escape hatch for any collector we have not adapted, and exercises genuinely
   different failure modes.
5. **New `M-1` / `M-2` measurement tasks** inserted before `P1-3`. Each can delete work.

```
DONE (as of 2026-08-27, all merged to main) ═══════════════════════
 P1-0..P1-4, P1-6..P1-9   scaffold, domain, contract suite, ccusage
                          adapter, store, meter, today, gates       ✅
 P2-1, P2-3, P2-4, P2-5   budget, latch (L1-L9), notifier, wiring   ✅
 P3-1..P3-6               statusline, latency gates, lum install    ✅
 P4-1, P4-4               ccusage primary, lum doctor               ✅
 GUARD                    PreToolUse enforcement (PR #7)            ✅  ← not in the original plan
 P0-1/P0-2, P2-2, P4-5    retracted (budi probe, pacing, harness)   ✂
NEW GOAL p5-multi-tool-parity — P5-1..P5-5, see HANDOFF.md §5/§7

ORIGINAL PLAN BELOW (kept for its reasoning) ══════════════════════
 P1-0  scaffold, CI, verify                                  ✅
 P1-1  domain types + ports (+ v3 amendments §3)             ✅
 P1-2  usageDayFor / usageDayRange, 100% branch              ✅
 P1-3  UsageSourcePort contract suite + in-memory fake       ✅

NEXT ═══════════════════════════════════════════════════════════
 M-1   measure the resolved ccusage binary; freeze fixtures  ← highest leverage
 M-2   dump hook stdin; check for rate_limits                ← may delete P3-2's echo file

WAVE 2 ════════════════════════ adapters ══════════════════════
 P1-4′ ccusage.shellout.ts  (PRIMARY)      ◄── P1-3, M-1
 P1-5′ jsonfile.ts (2nd real adapter)      ◄── P1-3
 P1-6  atomic store (tmp→fsync→rename)     ◄── P1-0
 P1-9  structural gates (import/net/canary)◄── P1-0

WAVE 3 ════════════════════ first user value ══════════════════
 P1-7  app/meter.ts  pull → snapshot       ◄── P1-4′, P1-6
 P1-8  lum today + degradation matrix      ◄── P1-7
   ▲ SHIPPABLE SLICE 1 — a real number, on a machine with nothing but Node

WAVE 4 ══════════════════════ THE WEDGE ═══════════════════════
 P2-1′ budget.ts  evaluate(Signal, cfg)    ◄── P1-1
 P2-3′ latch.ts   key (day, signal, thr)   ◄── P2-1′, P1-6
 P2-4  notifier                            ◄── P2-3′
 P2-5  wire into meter                     ◄── P2-1′..P2-4
   ▲ SHIPPABLE SLICE 2 — the thing nobody else has

WAVE 5 ═══════════════════════ statusline ═════════════════════
 P3-1  bin/statusline.js                   ◄── P1-6
 P3-2  stdin parse (+echo iff M-2 says so) ◄── P3-1
 P3-3  render                              ◄── P3-2, P2-1′
 P3-4  latency layers A/B/C in CI          ◄── P3-3
 P3-6′ lum refresh + lum install (hooks)   ◄── P1-7, P3-1   [absorbs P3-5]
   ▲ SHIPPABLE SLICE 3 — v1

WAVE 6 ═══════════════════ portability / post-v1 ══════════════
 P4-3  select.ts source resolution         ◄── P1-5′
 P4-4  lum doctor                          ◄── P4-3, P2-3′
 P4-1b budi.cli.ts     (evidence-blocked, not human-gated)
 P4-6  release                             ◄── PRE-B, PRE-D   ← THE ONLY HUMAN BLOCKER
```

### 4.1 ccusage binary resolution — four tiers

```
1. config.sources.ccusage.binPath                    explicit escape hatch, always wins
2. createRequire → @ccusage/ccusage-{platform}       ← the tier that kills the 1.2 s figure
3. `ccusage` on PATH (global install)                one which/where, cached
4. nothing resolves ⇒ available() === false, silently
   (npx is NOT tier 5 — see §1.2)
```

Declare `ccusage` as an `optionalDependency` at `^20.0.20`; npm installs the right platform
package and `createRequire(import.meta.url).resolve(...)` finds it with zero probing.

### 4.2 The `[from, to)` → inclusive `--until` conversion

```
since = localDate(from, tz)
until = localDate(to − 1 ms, tz)      ← the −1 ms IS the half-open→inclusive conversion
```

ccusage's `--until` is **inclusive**; the domain window is **half-open**. Table-test at exactly
`from`, `from − 1 ms`, `to`, `to − 1 ms`, across a DST spring-forward and fall-back, and at Lord
Howe's 30-minute offset.

**Over-fetch, which the docs never confront:** when `resetHourLocal !== 0` the domain window is not
day-aligned, so ccusage's day buckets straddle both ends and summing over-reports. Declare it
approximate rather than reaching for `blocks`: `granularity: 'day'` on the port, `app/meter.ts`
sets `dayBoundaryApprox`, `lum today` prefixes `~`, `lum doctor` explains. `resetHourLocal`
defaults to `0`, so the common case stays exact.

---

## 5. Gate recommendations

Recommendations, not decisions. Each is the user's to make.

| Gate | Recommendation | Reversibility |
|---|---|---|
| **PRE-C** | **Withdraw as a gate**, re-file as `P4-1b` evidence. With ccusage primary it blocks nothing and costs a 13 MB install to answer. | Total — one adapter file, any day. |
| **PRE-F** | **Option D — Claude Code hooks**, installed by an explicit `lum install`; `lum refresh` always available manually. A hook block the user writes into their own `settings.json` **is** explicit consent, needs no resident process, and fires exactly when spend changes. | High — deleting the block is one edit. |
| **ARCH-Q4** | **Answer "no self-spawn, ever", and close it.** Option D leaves no benefit to buy with the consent cost. This board has re-opened this twice by relocating it rather than answering it. | n/a — it is a deletion. |
| **OPEN-F** | **Fire on whichever signal is primary *and available to the surface doing the firing*,** with independent latch tracks. `alertOn: "auto"`. The statusline **sees** `rate_limits` but cannot notify (fs-only); `lum refresh` **can** notify but cannot see stdin. Hooks close that loop via a small echo file. | **Very high if `P2-1`/`P2-3` take a `Signal` from the start; very low if they do not.** That asymmetry is the whole argument. |
| **ARCH-Q2** | **Mark MOOT and delete.** It asks whether we get a real log to validate *our own Codex parser*. We have no parser — `ccusage codex daily` owns those semantics entirely. Delete the `PROVISIONAL` marker and `lum verify-codex`. | n/a. |
| **ARCH-Q1** | Keep Option A's **shape**, change the default from `"subscription"` to `"auto"`. Defaulting everything to subscription stamps `≈` on honest API-key dollars — the mirror image of the error Option A was chosen to avoid. Order: explicit config → echo evidence → source's `imputed` flag → subscription. | High — one resolver. |
| **ARCH-Q3** | Keep A+C, extend from two wordings to **three**: `usd+api` → "daily budget"; `usd+subscription` → "daily usage allowance"; `rate-limit` → *"Claude 7-day limit at 80% — resets Thu 14:00"*. A rate-limit alert worded as "budget" reintroduces exactly the confusion A+C exists to prevent. | High — one interpolation site. |

**The notification must name its window.** "AI Spend: Amber — $8.00 of $10.00" fired because a
7-day rate limit crossed 80% is the wrong-number problem in new clothes.

---

## 6. Cut from v1 (accepted 2026-08-26)

| Cut | Why | Recovery |
|---|---|---|
| **`budi.http.ts` entirely** | An unpublished internal daemon surface on a 25-star project with no push since May. | `budi.cli.ts` post-v1 if anyone asks. |
| **Pacing (`P2-2`)** | A `Should`; both constants admitted-unmeasured; needs a suppression rule for all five degradation states. Ship the warning first. | ~1.5 days, one pure module, zero migration. |
| **Conformance harness (`P4-5`)** | Already non-blocking and informational — and it is the one piece of code in the repo that *looks like* the v1 parser, which `P1-9` exists to prevent. Keep the numbers as prose in the README. | ~1 day. |
| **Blocking Windows CI** | Keep Windows in the types and the store's rename test; make the **matrix leg** non-blocking until there is a Windows user. `spawn` + `.exe` + `PATHEXT` + PowerShell toast is where ~40% of CI pain will come from, for a user population of zero. | One `continue-on-error` flip. |
| **`tokentracker.ts` (`P4-2`)** | Two real adapters is the bar; `ccusage` + `jsonfile` meets it. The third needs a desktop app installed to verify honestly. | ~1 day. |
| **`lum --live` TUI** | Fully specified in `DESIGN.md` and not on the board — cut it **explicitly** so nobody builds it. Needs chokidar, a redraw loop, and width logic for a screen `lum today` already covers. | ~2 days. |
| **Per-tool `accountMode` map** | With `"auto"` resolution the map is unused surface. Ship the resolver. | ~2 hours. |

**Not cut, though it looks cuttable:** `P1-9`'s three structural gates (the only thing making the
scope fence real); `P3-4` layer B, the marginal-spawn-cost assertion (the only version of the
`< 30 ms` claim that is assertable on a shared runner — Node's own cold start is ~40 ms); and the
genuine two-process latch restart test.

---

## 7. Shortest credible path to a demoable v1

```
M-1 → P1-4′ → P1-6 → P1-7 → P1-8 → P2-1′ → P2-3′ → P2-4 → P2-5
    → P3-1 → P3-2 → P3-3 → P3-6′ → P4-4
```

Fourteen tasks. Runs on a machine with nothing but Node — which is also the most persuasive
possible answer to `PRE-E`.
