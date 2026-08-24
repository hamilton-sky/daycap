# Implementation Plan — LocalUsageMeter

_Stage: DESIGN → BUILD handoff · Rigor: standard · Date: 2026-08-24_
_Derives from: [`ARCHITECTURE_PROPOSAL.md`](ARCHITECTURE_PROPOSAL.md) **v2** §7 (authoritative)_
_Does **not** derive from `archive/ARCHITECTURE_PROPOSAL-v1-own-parsers.md`._

> **Scope fence.** We build **no** log readers, **no** tail, **no** dedupe, **no** pricing table,
> **no** reconciler, **no** daemon. Usage enters through `UsageSourcePort` or it does not enter.
> Any task that reintroduces one of those is out of scope by construction — see the import-boundary
> gate (`P1-9`), which fails CI if `src/` gains a JSONL parse path.

> **Open human decisions.** PRE-A…PRE-E in [`feedback/HUMAN_QUESTIONS.md`](feedback/HUMAN_QUESTIONS.md)
> are **OPEN** and this plan does not close any of them. Tasks that depend on one are marked
> **`⟨contingent: PRE-x⟩`** and carry the working assumption in the open. If a PRE lands differently,
> re-read that task before starting it. One new question is surfaced below as **PRE-F** (§8, finding 3)
> — it is raised, not answered.

---

## 0. Sizes, IDs, and the shape of a task

`S` ≤ half a day · `M` half to two days · `L` two to five days.
IDs are phase-prefixed and stable. Dependencies are hard unless marked *(soft)*.

```
P0 spike ──► P1 core ──┬──► P2 budget ──┐
                       │                ├──► P4 portability ──► release
                       └──► P3 statusline ┘
       (P2 and P3 are parallel after P1)
```

---

## 1. P0 — The spike. A real go/no-go gate.

**Purpose.** Decide whether a collector on this machine can answer *"how much did each tool cost me
today?"* without us doing token arithmetic. Everything downstream assumes yes.
**Time box: 4 hours.** Not concluded in 4h ⇒ `INCONCLUSIVE`, escalate. Do not extend.

### 1.1 Definition — "day-shaped"

A collector response is **day-shaped** iff all four hold:

| | Criterion |
|---|---|
| **D1** | It accepts a caller-specified date/instant range, **or** returns rows already keyed by calendar date. |
| **D2** | Each row carries a **USD** figure the collector computed. (Tokens alone is a fail — we will not price them.) |
| **D3** | Rows carry a tool/source identifier, **or** the endpoint can be scoped per tool. |
| **D4** | Two consecutive calls for a **closed past day** return identical totals. |

**Session-shaped** = rows keyed by session id with first/last-activity timestamps and no date
grouping. D1 fails; D2/D3 may still hold.

### 1.2 Tasks

**`P0-1` — Environment and route discovery.** `S`
*Goal:* learn what is installed and what routes actually exist, before guessing at URLs.
*Files:* `spike/00-env.txt` (scratch, never committed to `src/`).
*Deps:* none.
*Do exactly this:*
```bash
budi --version; budi status; budi doctor          # capture all three verbatim
curl -sS -m 2 -w '\n%{http_code}\n' http://127.0.0.1:7878/
curl -sS -m 2 -w '\n%{http_code}\n' http://127.0.0.1:7878/openapi.json
# highest-yield, zero-cost route discovery — read the routes out of the binary:
strings "$(command -v budi)" | grep -oE '/(analytics|pricing|admin)[a-zA-Z0-9/_{}-]*' | sort -u
```
*Acceptance:* a written list of candidate routes, plus budi's version string. If `budi` is not
installed, stop and record `INCONCLUSIVE` — **do not** infer a verdict from its absence.

**`P0-2` — Probe `/analytics/*`.** `S`
*Goal:* classify the HTTP surface as day-shaped, session-shaped, or unusable.
*Files:* `spike/analytics-<route>.json` (one file per route, response bodies scrubbed of local paths
and project names before they are kept).
*Deps:* `P0-1`.
*Probe list* (each with `-m 2`; add anything `P0-1` discovered):
`/analytics`, `/analytics/summary`, `/analytics/daily`, `/analytics/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`,
`/analytics/usage?from=…&to=…`, `/analytics/tools`, `/analytics/sessions`, `/pricing/models`,
`/admin/status`, `/admin/health`.
*Acceptance:* D1–D4 answered yes/no **with the evidence line quoted** for each. D4 is tested by
calling yesterday's window twice, ≥60s apart.

**`P0-3` — Probe the CLI paths, budi *and* ccusage, in the same sitting.** `S`
*Goal:* establish the fallback before we need it. §7 names only budi; probing ccusage here costs ten
minutes and de-risks R2 immediately.
*Files:* `spike/cli-budi.json`, `spike/cli-ccusage.json`.
*Deps:* `P0-1`.
```bash
budi stats --format json | head -c 4000
ccusage --version; ccusage daily --json --offline | head -c 4000
```
*Acceptance:* D1–D4 answered for `budi stats --format json` and for `ccusage daily --json --offline`.
Record the wall time of each spawn (it becomes the `lum` latency budget, not the statusline's).

**`P0-4` — Apply the decision rule; write `SPIKE_RESULT.md`.** `S`
*Deps:* `P0-2`, `P0-3`.
*Files:* `pathly/features/local-usage-meter/SPIKE_RESULT.md`.

| Observation | Verdict | Action |
|---|---|---|
| HTTP satisfies D1–D4 | **GO** | primary = `budi.http.ts`. P1 as written. |
| HTTP fails **D1 only**; `budi stats --format json` satisfies D1–D4 | **GO (fallback)** | primary = `budi.cli.ts`. `budi.http.ts` demoted to a P4 adapter. Spawn cost lands on `lum`, never on `statusline.js`. |
| Both budi paths session-shaped; ccusage `daily --json` satisfies D1–D4 | **GO (reorder)** | primary = `ccusage.shellout.ts`; promote `P4-1` into P1; budi drops to P4. Collapses R1 (zero-install) but caps coverage at Claude+Codex ⇒ **PRE-A becomes blocking**. |
| Everything session-shaped, no ccusage | **CONDITIONAL GO** | Adapter buckets sessions into the usage-day by `lastActivity`. Snapshot carries `dayBoundaryApprox: true`; `lum today` prefixes the total with `~`; `lum doctor` states the approximation. Human-visible, never silent. |
| D3 fails everywhere (no per-tool dimension) | **PARTIAL** | Port returns one row `{tool:"all"}`. Config `tools:[…]` scoping is undeliverable for that source; `lum doctor` says so. Feeds PRE-A. |
| D2 fails (tokens, no USD) | **NO-GO for that source** | We do not price tokens (ADR-v2-001). Try the next source. |
| No collector reachable at all | **INCONCLUSIVE** | Re-run on a machine with a collector. **Never** record as GO or NO-GO. |
| Every source NO-GO | **NO-GO** | Stop the plan. Escalate with PRE-E: the consume-a-collector premise does not hold. |

*Acceptance:* `SPIKE_RESULT.md` states one verdict, the evidence for each of D1–D4 per source, the
chosen primary adapter, and the raw response files. **The builder does not mark PRE-C resolved** —
PRE-C stays OPEN until a human reads this file.

**`P0-5` — Freeze the recorded responses as contract fixtures.** `S`
*Goal:* the spike's scrubbed responses become the stub corpus every adapter is later tested against.
*Files:* `test/fixtures/collector/{budi-http,budi-cli,ccusage}/*.json`, `spike/` deleted.
*Deps:* `P0-4`. *Acceptance:* fixtures contain no absolute paths, no project names, no session text.

---

## 2. P1 — Core: types, ports, the contract suite, `lum today`

**Exit criteria (§7):** per-tool and total reconcile; degrades cleanly with the daemon down.

**`P1-0` — Scaffold.** `M`
*Goal:* an empty repo that typechecks, lints, tests, and builds.
*Files:* `package.json` (ESM, Node ≥22, `bin: { lum, lum-statusline }`), `tsconfig.json` (strict),
`vitest.config.ts`, `tsdown.config.ts`, `biome.json`, `.github/workflows/ci.yml`, `src/**/.gitkeep`
per §2's tree.
*Deps:* `P0-4` = GO. *Size drivers:* CI matrix (macOS + Linux + Windows).
*Acceptance:* `pnpm ci` runs typecheck → lint → test → build green on all three OSes.
**⟨contingent: PRE-D⟩** *Assumption:* bin name `lum` and config dir `~/.localusagemeter/` are kept
(neither collides with TokenTracker). The **npm package name and the repo name are left unset** —
`"private": true`, no publish step, until PRE-D lands.

**`P1-1` — Domain types and ports.** `S`
*Files:* `src/domain/types.ts`, `src/domain/ports.ts`.
*Deps:* `P1-0`.
*Acceptance:* §3's four types and four ports compile verbatim. `tool` is `string` — **no enum, no
per-tool branch anywhere in `src/`**, so an unknown tool from any collector is renderable.
**⟨contingent: PRE-A⟩** *Assumption:* the tool set is open. This task's job is to make PRE-A cheap
to answer later rather than to answer it.

**`P1-2` — `usageDayFor(ts, resetHourLocal, tz)`.** `S`
*Files:* `src/domain/window.ts`, `test/unit/window.test.ts`.
*Deps:* `P1-1`. Pure: no `Date.now()`, no `fs`.
*Acceptance:* returns a `YYYY-MM-DD` label. Table tests cover `resetHourLocal` 0 and 4; a DST
spring-forward day (23h) and fall-back day (25h) in `America/New_York` and `Europe/London`; an
instant one millisecond either side of the boundary; and `TZ` unset. 100% branch coverage.

**`P1-3` — `UsageSourcePort` contract suite + in-memory reference adapter.** `M` — **do this before
the first real adapter, not after.**
*Goal:* one suite every adapter must pass, so budi / ccusage / tokentracker are provably
interchangeable. This is the R2 mitigation and it is worthless if it arrives at the end.
*Files:* `test/contract/usage-source.contract.ts` (exports `runUsageSourceContract`),
`test/contract/fake.memory.ts`, `test/contract/README.md`.
*Deps:* `P1-1`, `P0-5`.
*The suite (each case is a named, individually-reportable test):*

| # | Case |
|---|---|
| C1 | `id` is a stable, non-empty string across two constructions. |
| C2 | Collector absent (port closed / empty `PATH`) ⇒ `available()` resolves `false`, never throws. |
| C3 | Collector present ⇒ `available()` resolves `true`. |
| C4 | Window with no usage ⇒ `spendFor` resolves `[]`. Not `null`, not a throw. |
| C5 | Every row: finite `usd ≥ 0`, non-empty `tool`, `imputed` is a boolean. |
| C6 | Known tool ids normalise to the canonical kebab set; an **unknown** tool id passes through verbatim without crashing. |
| C7 | Idempotence: two calls, same closed past window, equal totals. |
| C8 | The window is honoured — a window excluding all fixture activity returns `[]`; widening it returns the rows. (Catches an adapter that ignores the window and always answers "today".) |
| C9 | No re-pricing: fixture says `usd = 1.23` ⇒ adapter returns `1.23`, drift < 1e-9. |
| C10 | `freshness()` resolves `{lastUpdatedUtc: null}` when unknown; never throws. |
| C11 | Stub that never responds ⇒ settles within `timeoutMs` (default 1500). Never hangs. |
| C12 | HTTP 200 with garbage/unknown-schema JSON ⇒ `available()` false **or** a typed `SourceIncompatibleError`. Never an unhandled `TypeError`. |
| C13 | Privacy: no canary string from the fixture corpus appears on any returned object; no socket opened outside `127.0.0.1`/`::1`. |
| C14 | Clock independence: results depend only on the passed window, not on `Date.now()`. |

*Two run modes:* `stub` (default, blocking in CI, uses `P0-5` fixtures) and `live`
(`LUM_LIVE_SOURCES=budi,ccusage`, nightly job, non-blocking, may skip C8/C9 if the machine has no data).
*Acceptance:* `fake.memory.ts` passes all 14 with zero collectors installed. Adding a new adapter is
three lines in a `*.contract.test.ts` file.

**`P1-4` — Primary source adapter.** `M`
*Files:* `src/adapters/source/budi.http.ts`, `test/contract/budi.http.contract.test.ts`,
`test/stubs/budi-server.ts` (a local HTTP server replaying `P0-5` fixtures).
*Deps:* `P1-3`, `P0-4`.
*Acceptance:* passes all 14 contract cases against the stub. Loopback only. Hard 1500 ms timeout.
*Note:* if `P0-4` chose a different primary, this task's file changes and nothing else does — that is
the point of §3's structural rule.

**`P1-5` — Second real adapter, pulled forward from P4.** `S`
*Goal:* from P1 onward the contract suite always runs against ≥2 **real** implementations, not one
real and one fake. §7 defers every alternate adapter to P4; that leaves R2 unmitigated for three
phases. `budi.cli.ts` is cheap and is already the `P0-4` fallback.
*Files:* `src/adapters/source/budi.cli.ts`, `test/contract/budi.cli.contract.test.ts`,
`test/stubs/fake-budi-bin.js`.
*Deps:* `P1-3`. *Acceptance:* passes all 14 against a fake binary on a temp `PATH`.

**`P1-6` — Atomic store.** `S`
*Files:* `src/adapters/store/atomic-json.ts`, `test/integration/store.test.ts`.
*Deps:* `P1-0`.
*Acceptance:* write is tmp → `fsync` → `rename` in the same directory. Tests: reader never observes a
partial file under 100 concurrent writes; a truncated file is reported as corrupt rather than parsed;
`EACCES` on the state dir surfaces as a typed error, not a crash. Windows rename-over semantics covered.

**`P1-7` — `app/meter.ts`: pull → snapshot.** `M`
*Files:* `src/app/meter.ts`, `src/adapters/source/select.ts`, `test/unit/meter.test.ts`.
*Deps:* `P1-2`, `P1-4`, `P1-6`.
*Acceptance:* resolves a source, computes the usage-day window, calls `spendFor`, writes
`~/.localusagemeter/state/today.json` `{schema, usageDay, generatedAtUtc, sourceId, sourceFresh,
tools:[…], totalUsd, imputed, dayBoundaryApprox}`. Injected `ClockPort`. Summing per-tool **USD** is
allowed; deriving USD from tokens is forbidden and asserted by C9 (see §8 finding 1).

**`P1-8` — `lum today` + degradation matrix.** `M`
*Files:* `src/bin/lum.ts`, `src/adapters/render/table.ts`, `src/domain/config.ts`,
`test/e2e/lum-today.test.ts`.
*Deps:* `P1-7`.
*Acceptance:* every row below renders, exits 0, and has a named test. **These are normal states.**

| Condition | Detection | `lum today` | Doctor line |
|---|---|---|---|
| No collector at all | all `available()` false | `lum — (no source)` | lists each source it looked for + how |
| Daemon down, binary present | `ECONNREFUSED` | falls through to `budi.cli` | `budi: daemon down, using CLI` |
| Daemon slow | 1500 ms timeout | last cached snapshot + age | `budi: timeout` |
| Stale cache (> 15 min) | `generatedAtUtc` age | value + `⋯` age marker | `snapshot: stale (18m)` |
| No cache, cold start | file absent | `lum — (no source)` | `snapshot: none` |
| Partial tool coverage | source covers < configured `tools` | rows present + `(partial)` | names covered vs configured |
| Schema drift | `SourceIncompatibleError` | `lum — (no source)` | `budi vX: adapter incompatible` |
| Config missing / invalid | parse | defaults, still renders | `config: defaults (reason)` |
| `dailyBudgetUsd` unset or 0 | config | absolute spend, no % and no bar | `budget: not set` |

**⟨contingent: PRE-D⟩** config schema. *Assumption:* `~/.localusagemeter/config.json`, §4's keys, plus
**back-compat aliases** — `clis` accepted as an alias for `tools`, `imputeCostForSubscription`
retained and honoured. See §8 finding 5: §4's claim that the brief's five keys "survive unchanged"
is not literally true, and this task is where the gap is closed rather than papered over.

**`P1-9` — Structural gates: privacy, imports, network.** `S` — lands in P1, stays green forever.
*Files:* `test/gates/{imports,network,privacy}.test.ts`.
*Deps:* `P1-0`.
*Acceptance, all three blocking in CI:*
1. **Import boundary** — no file under `src/` imports `node:readline`, `chokidar`, or opens a path
   under `~/.claude`, `~/.codex`, `~/.cursor`, or `**/*.jsonl`. Enforces the scope fence (ADR-v2-001).
   Nothing under `src/` may import from `test/`.
2. **Network boundary** — a `net.Socket` hook fails the run on any connect to a non-loopback address
   during the whole suite. `src/bin/statusline.js` opens no socket at all.
3. **Privacy canary** — canary strings seeded through every stub fixture must not appear in any
   rendered output, snapshot, latch, or notification argv (ADR-v2-004).

---

## 3. P2 — Budget, pacing, latch, notification

> **Cross-artifact rule added 2026-08-24 (from `DESIGN.md` §7).** The latch and the notifier fire
> **only from trusted data** — degradation states 0 (fresh-full) and 1 (fresh-partial). A stale,
> source-down or no-source read must never fire a notification and must never advance the latch:
> an alert derived from a number we are not sure about is worse than no alert, because it teaches
> the user to ignore the alerts. Add this as latch rule **L9** and test it alongside L1–L8.
> Corollary from the same section: **unknown must never render as `$0.00`.**

**Exit criteria (§7):** 0.8 then 1.0 fire exactly once each; no re-fire across restart or dip-below.

**`P2-1` — `budget.ts`.** `S`
*Files:* `src/domain/budget.ts`, `test/unit/budget.test.ts`. *Deps:* `P1-1`.
*Acceptance:* `evaluate(spendUsd, cfg) -> {fraction, state: 'ok'|'amber'|'red', crossed: number[]}`.
Pure. Boundary tests: exactly 0.8 and exactly 1.0 count as crossed (`>=`); `0.7999999999` does not;
budget 0 or absent ⇒ `fraction: null`, `state: 'ok'`, `crossed: []`; negative spend clamps to 0.

**`P2-2` — `pacing.ts`.** `S`
*Files:* `src/domain/pacing.ts`, `test/unit/pacing.test.ts`. *Deps:* `P1-2`, `P2-1`.
*Acceptance:* `pace(fraction, elapsedFractionOfUsageDay) -> 'ahead'|'on'|'behind'`, with a dead band
(±10 pp) so it does not flap. Elapsed fraction comes from `usageDayFor`, so `resetHourLocal` and DST
are already handled. At 00:05 with elapsed ≈ 0, never `ahead` — returns `'on'` (avoids "ahead of pace"
on the first turn of the day, which would be true and useless).

**`P2-3` — The threshold latch.** `M` — **the correctness centrepiece.**
*Files:* `src/app/latch.ts`, `test/unit/latch.property.test.ts`, `test/integration/latch-restart.test.ts`.
*Deps:* `P2-1`, `P1-6`.
*State file* `~/.localusagemeter/state/latch.json`:
```json
{ "schema": 1, "usageDay": "2026-08-24", "fired": { "0.8": "2026-08-24T15:02:11.442Z" } }
```
*Pure core* — all logic lives here, the file is only persistence:
```ts
evaluateLatch(prev: LatchState | null, day: string, fraction: number,
              thresholds: number[], nowIso: string): { next: LatchState; toFire: number[] }
```
*Rules:*
- **L1** fire when `fraction >= t`.
- **L2** only if `t` is absent from `prev.fired` **for the same `day`**.
- **L3** `prev.usageDay !== day` ⇒ discard `prev.fired` entirely and re-arm. Replace, never merge.
- **L4** a dip below `t` **never** clears `fired`. Re-arming happens only via L3.
- **L5** several thresholds crossed in one step all fire, ascending.
- **L6** corrupt or unreadable `prev` ⇒ treat as *all thresholds already fired today*, i.e. stay
  silent, and `lum doctor` prints `latch: recovered (silent until <next reset>)`. **Rationale:** a
  spurious duplicate alert trains the user to ignore alerts; a missed one is still visible in red on
  the statusline. Fail quiet, not loud.
- **L7** order is **persist the latch, then notify.** A notifier crash costs one alert; the reverse
  order costs an alert every invocation.
- **L8** two `lum` processes racing: `rename` is atomic, last writer wins, a duplicate alert is
  possible and accepted. Documented, not engineered around — a lock is how you get a stale lockfile.

*Acceptance — how it is tested:*
1. **Property (fast-check).** For any sequence of fractions within one usage day, each threshold
   appears **at most once** across the concatenated `toFire`. Generators must include: monotone rise;
   a sawtooth oscillating across 0.8 fifty times; exact-boundary values; a single jump 0 → 1.2 (both
   fire, ascending); float-edge `0.7999999999999999`.
2. **Restart.** `test/integration/latch-restart.test.ts` **spawns `lum` twice as separate processes**
   against the same temp `HOME`. Run 1 fires 0.8; run 2, same spend, fires nothing. In-process
   re-invocation does not count as a restart test.
3. **Corrupt file.** Truncate `latch.json` mid-object ⇒ zero notifications, exit 0, doctor reports
   `recovered`.
4. **Day rollover.** `resetHourLocal: 4`, clock stepped across 03:59 → 04:01 ⇒ exactly one re-arm and
   exactly one re-fire. Repeated on a DST spring-forward date.
5. **Config change mid-day.** Adding `0.9` at 15:00 with `fraction` already 0.95 fires `0.9` once,
   immediately. Removing a threshold leaves its `fired` entry intact but inert.
6. **Clock skew.** Snapshot timestamp in the future ⇒ no re-arm, no crash.

**`P2-4` — Notifier.** `S`
*Files:* `src/adapters/notify/notifier.ts`, `test/e2e/notify.test.ts`.
*Deps:* `P2-3`.
*Acceptance:* macOS `osascript`, Linux `notify-send`, Windows PowerShell toast, terminal bell last
resort; no `node-notifier`. All arguments passed as an argv array, never a shell string (a tool name
from a collector is untrusted input). `LUM_NOTIFY_CMD` override lets the e2e test capture argv.
A missing platform binary is a no-op, not an error. Copy per `DESIGN.md` §3.
**⟨contingent: ARCH_QUESTION 3⟩** *Assumption:* the A+C hybrid — same fractions for every account
type, wording swaps "budget" → "usage allowance" on subscriptions. Ratified by an agent, **never
acknowledged by a human**. It is one string interpolation; it stays that way so a reversal is cheap.

**`P2-5` — Wire budget + pacing + latch into the meter.** `S`
*Files:* `src/app/meter.ts`, `test/e2e/threshold-crossing.test.ts`.
*Deps:* `P2-1`…`P2-4`, `P1-7`.
*Acceptance:* the §7 exit criterion, end to end: a stub source ramping 0 → 0.85 → 0.75 → 1.05 across
four separate `lum` process invocations produces **exactly two** notifications, in order, with the
right wording, and `state/latch.json` matching.

---

## 4. P3 — Statusline

**Exit criteria (§7):** < 30 ms p95; exit 0 on every injected fault; `rate_limits` absent handled.

**`P3-1` — `bin/statusline.js`.** `M`
*Files:* `src/bin/statusline.js` (**authored as hand-written ESM `.js`, shipped verbatim, never
bundled**), `test/e2e/statusline-faults.test.ts`.
*Deps:* `P1-6`.
*Acceptance:* imports `node:fs` and `node:process` and nothing else — asserted by a source scan for
`import`/`require`. Consumes stdin with `process.stdin.resume(); process.stdin.destroy();` before
writing stdout, and never blocks on the pipe. Exactly one line on stdout. **Exit 0 on every injected
fault:** missing cache, zero-byte cache, truncated JSON, cache owned by another user, `$HOME` unset,
state dir is a file, stdin closed immediately, stdin never written, stdin 1 MB of garbage, `NO_COLOR`,
`TERM=dumb`, `SIGPIPE` on stdout. Self-timeout at 150 ms prints the degraded line and exits 0.

**`P3-2` — stdin parsing and the rate-limit echo.** `M`
*Files:* `src/adapters/stdin/claude-status.ts`, `src/bin/statusline.js`, `test/unit/claude-status.test.ts`.
*Deps:* `P3-1`.
*Acceptance:* extracts `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.*`,
`cost.total_cost_usd`, `context_window.used_percentage`. **Every field independently optional** — the
absence of `rate_limits`, of one window, or of the whole payload is a normal path, never an error
(ADR-v2-003, R5, issue #45133). Fixture set covers: full payload, `rate_limits` absent, `five_hour`
present but `seven_day` absent, `used_percentage` null, an unknown extra top-level key.
*Also:* the statusline writes the last-seen `rate_limits` to `state/stdin-echo.json` (atomic, ~200
bytes) so `lum today` and `lum doctor` — which have no stdin — can show the primary signal on
subscriptions. See §8 finding 4: without this, ADR-v2-003's primary signal exists only in the
statusline. This is the one write on the hot path; it is inside the latency budget of `P3-4`.

**`P3-3` — Render.** `S`
*Files:* `src/adapters/render/statusline.ts`, `test/unit/render-statusline.test.ts`.
*Deps:* `P3-2`, `P2-1`, `P2-2`.
*Acceptance:* all six §5 forms render byte-exactly. `primarySignal: "auto"` ⇒ rate-limit when
`rate_limits` is present, USD otherwise. 256-colour with a 16-colour fallback; `NO_COLOR` and
`--no-color` strip every escape. `≈` prefix on imputed. State markers (`⋯`, `(partial)`, `?`) sit
outside the colour reset so they never inherit the threshold colour.

**`P3-4` — Latency budget, asserted in CI.** `M`
*Files:* `bench/statusline.bench.ts`, `.github/workflows/ci.yml`, `test/perf/statusline.perf.test.ts`.
*Deps:* `P3-3`.
*The problem:* absolute wall-clock p95 of a spawned Node process on a shared CI runner is dominated
by interpreter start (~25–40 ms) and is far too noisy to gate on. Asserting `< 30 ms` absolute would
be a permanently flaky gate. So assert it in three layers:

| Layer | Measure | Threshold | CI |
|---|---|---|---|
| **A — render path** | in-process: read cache + parse stdin + format, `hrtime.bigint()`, n=1000 | **p95 < 5 ms** | blocking |
| **B — marginal spawn cost** | `spawnSync` p95 of `statusline.js`, minus `spawnSync` p95 of `node -e ''` on the same runner, n=200, discard first 20 | **p95 delta < 30 ms** — this is §6's "< 30 ms", read as *our* cost, not Node's boot | blocking |
| **C — hard ceiling** | absolute `spawnSync` p95 | **< 150 ms** (§6's hard budget) | blocking |
| **D — absolute reference** | absolute p95 recorded per run | none | reported, non-blocking |

*Acceptance:* the job fails on a regression in A, B, or C, and prints all four numbers. Also asserts
the syscall shape: the statusline opens ≤ 3 files and zero sockets.

**`P3-5` — `lum install-statusline`.** `S`
*Files:* `src/bin/lum.ts`, `test/e2e/install-statusline.test.ts`. *Deps:* `P3-1`.
*Acceptance:* prints the exact `settings.json` block, and with `--write` merges it idempotently after
backing the file up. Never rewrites an unrelated key. Running it twice is a no-op.

**`P3-6` — Snapshot refresh trigger.** `S` — **⟨contingent: PRE-F, newly raised, §8 finding 3⟩**
*Goal:* decide what actually refreshes `today.json`, given that `statusline.js` may not touch the
network and there is no daemon.
*Files:* `src/bin/lum.ts` (`lum refresh`), docs.
*Deps:* `P3-1`, `P1-7`.
*What this task builds now, unconditionally:* the explicit path — `lum refresh` as a command, plus
documented wiring via a Claude Code `Stop` hook and a shell `precmd`. That is opt-in, consented, and
works today.
*What it does **not** build:* auto-spawn of a detached `lum refresh` from `statusline.js` when the
cache is stale. That is ARCH_QUESTION 4 in new clothes — a background process appearing without
explicit consent — and `feedback/HUMAN_QUESTIONS.md` called it "resolved by deletion" when it was not (now corrected there, and recorded as PRE-F). If a human wants it,
it is `autoRefresh: true`, default **off**, throttled ≥ 5 s by a timestamp file.
*Acceptance:* `lum refresh` exits 0 in ≤ 2 s with a live source and ≤ 1.6 s without one; the docs
show both wiring options; no code path spawns anything unless `autoRefresh` is explicitly `true`.

---

## 5. P4 — Portability and diagnosis

**Exit criteria (§7):** works with zero collectors (degraded) and with each one.

**`P4-1` — `ccusage.shellout.ts`.** `M` — **⟨contingent: PRE-A, PRE-E⟩**
*Files:* `src/adapters/source/ccusage.shellout.ts`, `test/contract/ccusage.contract.test.ts`.
*Deps:* `P1-3`. *Assumption:* budi-first ordering per §7. **If PRE-E comes back "no, doubled install
friction is unacceptable", this task promotes into P1 and becomes the primary** — it is the
zero-install path (R1). If PRE-A confirms Cursor is in scope, ccusage can never be the only source.
*Acceptance:* all 14 contract cases against a fake `ccusage` binary; `daily --json --offline` shape;
absent binary ⇒ `available()` false, silently.

**`P4-2` — `tokentracker.ts`.** `M` — **⟨contingent: PRE-A⟩**
*Files:* `src/adapters/source/tokentracker.ts`, `test/contract/tokentracker.contract.test.ts`.
*Deps:* `P1-3`. *Acceptance:* all 14 contract cases. Delivers R2's "≥2 working adapters before v1.0"
with margin (this makes four).

**`P4-3` — Source selection.** `S` — **⟨contingent: PRE-A⟩**
*Files:* `src/adapters/source/select.ts`, `test/unit/select.test.ts`. *Deps:* `P4-1`, `P4-2`.
*Acceptance:* `source: "auto"` probes in a documented, config-overridable order and picks the first
`available()`; `available()` results cached for the process lifetime only; an explicit `source` that
is unavailable is an error with a remedy, never a silent fallback. Zero collectors ⇒ the `no source`
degradation path, exit 0.

**`P4-4` — `lum doctor`.** `M`
*Files:* `src/bin/lum.ts`, `src/adapters/render/doctor.ts`, `test/e2e/doctor.test.ts`.
*Deps:* `P4-3`, `P2-3`.
*Acceptance:* 80 columns, no colour unless `--color`. One line per source naming **what it looked for
and where** (`budi: http://127.0.0.1:7878 — refused; budi on PATH — not found`), plus snapshot age,
latch state (including `recovered`), config source, budget, covered-vs-configured tools, and
`dayBoundaryApprox` if set. Exit 0 when healthy, 1 when nothing at all is usable. R1's remedy text
("install budi, or ccusage for Claude+Codex only") lives here.

**`P4-5` — Collector conformance harness.** `S` — non-blocking, informational.
*Goal:* use `fixtures/claude-session-scrubbed.jsonl` for what it now is — a **collector** conformance
fixture (88 lines, 30 unique turns, 58 duplicate records), not parser input.
*Files:* `test/conformance/collector-conformance.test.ts`, `test/conformance/EXPECTED.md`.
*Deps:* `P4-3`.
*Acceptance:* the harness computes the fixture's ground-truth totals **once**, records them in
`EXPECTED.md`, then reports whether a live collector's figure for that file matches — flagging the
2.41× dedup inflation and the cache-bucket direction from the v2 Appendix.
**Fence, enforced by `P1-9`:** this aggregation lives under `test/conformance/` only, is never
imported by `src/`, and is never shipped. It is a yardstick for judging collectors, not a parser. If
this code ever moves into `src/`, v1 has been resurrected.

**`P4-6` — Release readiness.** `S` — **⟨contingent: PRE-B, PRE-D⟩**
*Files:* `README.md`, `package.json`, `CHANGELOG.md`.
*Deps:* everything. *Assumption:* nothing publishes until PRE-D names the package and PRE-B says
someone wants it (R4). This task exists to make that gate visible, not to pass it.

---

## 6. Test strategy

| Layer | What | Where | Speed | Gate |
|---|---|---|---|---|
| **Unit** | `domain/*` only. Pure: no fs, no net, no `Date.now()` — `ClockPort` injected. Property tests for latch and budget boundaries. | `test/unit/` | < 2 s | blocking, **≥ 95% branch on `src/domain/`** |
| **Contract** | The 14-case `UsageSourcePort` suite, run against every adapter incl. the in-memory fake. Same file, parameterised. | `test/contract/` | < 10 s | blocking — **every adapter, every PR** |
| **Contract (live)** | Same suite against real collectors on the machine. | `test/contract/` + `LUM_LIVE_SOURCES` | minutes | nightly, non-blocking |
| **Integration** | Adapters vs stub servers and fake binaries; store atomicity; latch across real processes. | `test/integration/` | < 30 s | blocking |
| **E2E** | Spawned `lum` / `statusline.js` in a temp `HOME` with a stub collector and a captured notifier. Asserts rendered bytes, notification argv, exit codes. | `test/e2e/` | < 60 s | blocking |
| **Gates** | Import boundary, network boundary, privacy canary (`P1-9`). | `test/gates/` | < 5 s | blocking |
| **Perf** | `P3-4` layers A/B/C. | `test/perf/`, `bench/` | < 30 s | blocking (A, B, C) |
| **Conformance** | Collector-quality yardstick (`P4-5`). | `test/conformance/` | varies | informational only |

**CI gates on every PR (blocking):** typecheck · biome · unit + contract + integration + e2e green on
macOS/Linux/Windows · `src/domain` branch coverage ≥ 95% · the three structural gates · statusline
fault matrix all exit 0 · latency layers A, B, C.
**Non-blocking jobs:** live contract suite (nightly), collector conformance, absolute latency number.
**Not a gate, deliberately:** overall coverage percentage. Adapters are covered by the contract suite
or they are not covered at all; a global number would reward testing the wrong layer.

---

## 7. Assumptions register — every contingency in one place

| PRE | Status | Working assumption in this plan | Tasks that change if it lands differently |
|---|---|---|---|
| **PRE-A** tool list | **OPEN** | Open set. `tool` is `string`, no enum, no per-tool branch. | `P1-1`, `P4-1`, `P4-2`, `P4-3` |
| **PRE-B** demand | **OPEN** | Build proceeds; nothing ships. | `P4-6` |
| **PRE-C** `/analytics/*` shape | **OPEN** | P0 gathers the evidence; a **human** closes it. | all of P0, then P1-4 |
| **PRE-D** rename | **OPEN** | `lum` bin + `~/.localusagemeter/` kept; package/repo name unset, `private: true`. | `P1-0`, `P1-8`, `P4-6` |
| **PRE-E** install friction | **OPEN** | budi-first per §7. | `P4-1` (promotes to P1 if "no") |
| **PRE-F** *(new, §8-3)* refresh trigger consent | **OPEN — raised here** | Explicit `lum refresh` only; `autoRefresh` default off. | `P3-6` |
| ARCH_Q3 threshold wording | agent-ratified, no human ack | A+C hybrid, one interpolation. | `P2-4` |

---

## 8. Findings in the v2 architecture

**1 — R6 overstates the no-arithmetic rule, and §3 contradicts it.** R6 says "we do no arithmetic on
tokens — we display the collector's totals." But `spendFor(window) -> ToolSpend[]` plus §5's single
`today $X` total requires summing per-tool USD, and the session-shaped branch would require bucketing
into days. The defensible rule is narrower: **no token → USD arithmetic; USD summation is fine.**
Contract case C9 pins the real invariant. Suggest rewording R6.

**2 — §7's P0 fallback assumes something unestablished.** "If `/analytics/*` is session-shaped, P1
shifts to `budi stats --format json`" presumes the CLI is day-shaped. Nothing in RESEARCH §5 says so —
it says the CLI is *more stable*, which is a different property. §7 has no branch for "both are
session-shaped." `P0-4`'s table adds two: ccusage-primary, and conditional-go with an explicit
`dayBoundaryApprox` flag.

**3 — The largest hole: nothing refreshes the cache.** §6 says `statusline.js` reads "a small cache
file that `lum` refreshes", §2 says it imports `node:fs` only, and ADR-v2-002 says no daemon resides
in memory. So on a machine where the user never types `lum`, `today.json` is written by nobody and the
statusline shows a permanently stale number. The only zero-config fix is the statusline spawning a
detached `lum refresh` — which is **ARCH_QUESTION 4 verbatim** (a background process without explicit
consent), the one question this board never answered. `feedback/HUMAN_QUESTIONS.md` called it "resolved by deletion"; deleting
the daemon moved the consent question, it did not answer it. Raised as **PRE-F**; `P3-6` builds only
the consented path.

**4 — ADR-v2-003's primary signal is unreachable from `lum`.** `rate_limits` arrives only on the
statusline's stdin. `lum today` and `lum doctor` have no stdin, so on a subscription account they can
never show the signal the architecture calls primary. `P3-2` adds a ~200-byte echo file. Without it,
§5's `5h 23% · 7d 41%` row exists in exactly one of three surfaces.

**5 — "The brief's five original config keys all survive unchanged" (§4) is not true.** `clis` was
renamed to `tools`, and `imputeCostForSubscription` does not appear in §4's example at all. Two of
five changed. `P1-8` keeps both as honoured aliases; the sentence in §4 should be corrected rather
than left to surprise someone reading the brief and the architecture side by side.

*(Minor: `DESIGN.md` §1's degradation strings — `(paused)`, "no daemon" — describe a daemon v2 deleted.
`P1-8`'s matrix supersedes them; `lum — (no source)` is the v2 form.)*
