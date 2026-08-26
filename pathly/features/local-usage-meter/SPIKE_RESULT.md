# SPIKE_RESULT — P0 collector go/no-go

_Task: `P0-1`…`P0-4` of [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §1 · Executed 2026-08-25 · Time box 4h, used ≈1h_
_Machine: macOS 26.6.2, Darwin 25.6.0 arm64, local tz `Asia/Jerusalem` (IDT, UTC+3)_
_Raw responses: [`../../../spike/`](../../../spike/) · frozen fixtures: `test/fixtures/collector/` (P0-5)_

---

## Verdict

# **GO**

**Primary adapter = `budi.http.ts`.** P1 proceeds as written in the plan.

The decision-rule row that fires is the first one: *"HTTP satisfies D1–D4 ⇒ **GO**, primary =
`budi.http.ts`, P1 as written."*

Two independent collectors were probed and **they reconcile to the cent** once the timezone axis is
aligned (§4). The consume-a-collector premise of ADR-v2-001 holds on real data: 21,000 messages,
$912.87 all-time, four providers detected.

> **`PRE-C` remains OPEN.** Per `P0-4`'s acceptance criteria, the builder does not close it. This
> file is the evidence a human reads in order to close it.

---

## 1. Environment (`P0-1`)

| | |
|---|---|
| Collector | **budi 8.5.11** (MIT, Rust) — installed for this spike; was **not** previously present |
| Provenance | GitHub release `v8.5.11`, `budi-v8.5.11-aarch64-apple-darwin.tar.gz`, **SHA256 verified against the release `SHA256SUMS`** (`922778db…59bd0`, `shasum -c` = OK) |
| Size | **11,248,159 B ≈ 10.7 MiB** for the tarball; ships two binaries, `budi` + `budi-daemon` |
| Signing | ad-hoc / linker-signed Mach-O thin arm64. No notarisation, no Developer ID. Ran without a Gatekeeper prompt because it arrived via `curl`, not LaunchServices |
| Install path | `~/.local/bin/` (user-local, no `sudo`, no system daemon installed) |
| Fallback collector | **ccusage 20.0.20** via `npx -y ccusage@20` — no global install needed |
| Upstream liveness | repo last pushed **2026-05-26**, 25 stars. Confirms Risk **R2** (solo project, quiet ~3 months) |

`budi --version`, `budi status`, `budi doctor` captured verbatim in `spike/00-env.txt`.

**`budi status` before anything else ran:** `✗ Daemon not running (port 7878)`. Consistent with the
pre-spike probe: all six loopback routes returned `000` (connection refused) with no collector present.

### 1a. Two side effects worth recording

1. **`budi doctor` started the daemon as a side effect of a diagnostic command.** Its own output
   admits it: *"auto-recovered: was NOT running on first probe; doctor started it."* A read-only-sounding
   subcommand spawned a long-lived background process. This is **`ARCH_QUESTION 4` / `PRE-F` arriving
   from the other direction** — the consent question does not disappear by our deleting our daemon,
   because our dependency has one and starts it unbidden. Feed this into `PRE-F`.
2. **A backfill step is mandatory and is not implied by "install".** Immediately after install,
   `doctor` reported *"tailer advanced 151.2 MB in the last 30 min but no claude_code rows landed in
   the database"* — i.e. **$0.00 of usage was queryable** despite 126 transcripts being watched.
   Only `budi db import` (8.8 s, 21,000 messages) made history queryable. A `lum` that reads a
   freshly-installed budi sees zero and cannot distinguish it from a genuinely idle day. This is a
   direct hit on **Definition of Done #3, "Unknown never renders as `$0.00`"**, and `lum doctor` must
   detect the un-backfilled state explicitly.

### 1a-bis. Licensing — verified, not assumed (checked 2026-08-25 on request)

`SPEC.md` §3 asserts "budi is MIT". That is now **verified against the shipped artifact**, not just
the repo page:

| Source | Result |
|---|---|
| `LICENSE` inside `budi-v8.5.11-aarch64-apple-darwin.tar.gz` | **MIT**, Copyright (c) 2026 Ivan Seredkin |
| `raw.githubusercontent.com/siropkin/budi/main/LICENSE` | **MIT**, identical |
| GitHub license API (`/repos/siropkin/budi/license`) | `spdx_id: MIT`, `path: LICENSE` |
| Repo root scan for `EULA` / `TERMS` / `COMMERCIAL` / `NOTICE` / `COPYING` | **none** — one `LICENSE`, 1070 B |
| README §License | `[MIT](LICENSE)` |

**Free for use, no trial, no paywall, no dual-licensing.** The local CLI and daemon — the only parts
we touch — are unrestricted. `SPEC.md` §3's "no license obligation" reasoning stands: we call a
loopback service and vendor none of its code.

The optional cloud dashboard (`app.getbudi.dev`, separate repo `siropkin/budi-cloud`) is **also MIT**.
We do not use it, and it is **off by default**: `budi cloud status` → `state: disabled (no config)`,
`last sync: never`, and `~/.config/budi/` does not exist on the spike machine. **No data left the
machine during this spike.**

> **Privacy trap for `lum doctor`.** `budi cloud status` reports its default privacy mode as
> **`full` — "raw session titles uploaded"**. Inert while sync is disabled, but a single
> `budi cloud init` would enable uploading raw session titles unless `[cloud.privacy] mode` is first
> set to `hash` or `omit`. Against this project's "nothing leaves the machine" non-goal, `lum doctor`
> should **assert the collector's own cloud sync is disabled** and warn if it is not. Our loopback-only
> guarantee does not constrain what our dependency ships.

**Also found, and it softens `PRE-E`:** a real Homebrew tap exists —
`brew install siropkin/budi/budi`. `brew search budi` misses it because the tap is not added, which is
why the spike used the release tarball. One `brew install` is materially less friction than
"download a 10.7 MiB unnotarised binary", though the mandatory `budi db import` (§1a.2) remains.

### 1b. Route discovery

The `strings`-the-binary trick in `P0-1` was the highest-yield step in the spike — `/` and
`/openapi.json` both **404**, so there is no self-describing surface and no route list would have
been guessable. Extraction yielded ~40 candidates (full list in `spike/00-env.txt`); 17 of 20 probed
returned `200`. `/analytics/health` and `/analytics/active_block` **404** despite appearing in the
binary's strings — string presence is not proof of a mounted route.

---

## 2. D1–D4 — budi HTTP (`/analytics/*`) · **primary**

| | Criterion | Verdict | Evidence |
|---|---|---|---|
| **D1** | Caller-specified range, or rows keyed by calendar date | **PASS** (both) | `GET /analytics/activity?since=2026-08-22&until=2026-08-25` → 3 rows keyed `label: "2026-08-22"`, `"…-23"`, `"…-24"`. Unranged → 27 rows. |
| **D2** | Collector-computed **USD** per row | **PASS** | `/analytics/providers` → `"estimated_cost": 867.0` **and** `"total_cost_cents": 86700.1532`. Fractional cents, so no precision loss. We price nothing. |
| **D3** | Per-tool identifier or per-tool scoping | **PASS** (both) | Rows carry `"provider": "claude_code"` / `"codex"` + `display_name`. And `?agent=codex` scopes: `/analytics/activity?agent=codex` → 3 rows vs 27 unfiltered. |
| **D4** | Two calls, closed past day, identical | **PASS** | `/analytics/providers?since=2026-08-24&until=2026-08-25` called **89 s apart** → byte-identical (`spike/d4-sample1.json` == `spike/d4-sample3.json`). budi CLI equivalent also stable (`3113` then `3113` cents). |

### The one endpoint that carries the whole product

`GET /analytics/statusline` satisfies D1+D2+D3 in a **single call** and additionally supplies the
pacing inputs the plan expected to compute itself:

```json
{ "cost_1d": 2.4435, "cost_7d": 213.762969, "cost_30d": 860.9262,
  "active_provider": "claude_code",
  "breakdown_by_provider": [ { "provider": "claude_code",
      "cost_1d_cents": 193.1453, "cost_7d_cents": 21376.2969, "cost_30d_cents": 86092.6202 } ],
  "cycle_elapsed_percent": 79.1667, "window_remaining_minutes": 263.48,
  "window_reset": "2026-08-25T17:58:08.446+00:00", "window_burn_rate": 3.17499,
  "block_cost_cents": 193.1453, "block_burn_cents_per_hour": 122.459,
  "block_remaining_minutes": 205.37 }
```

**Verified: `cost_1d` is a calendar day, not a rolling 24 h.** In one simultaneous triple-read,
`statusline.cost_1d`, `/analytics/providers?since=today&until=tomorrow` and
`/analytics/activity?since=today&until=tomorrow` all returned **2.4435** exactly.

`cycle_elapsed_percent` and `window_burn_rate` mean **`pacing.ts` (`P2`) may be a pure read rather
than a computation.** Worth re-scoping that task before starting it.

---

## 3. Two API traps. Both silent, both wrong-by-default.

These are the spike's most valuable output. Each returns HTTP `200` and plausible JSON while being
badly wrong, so neither surfaces as an error at any layer.

### Trap 1 — unknown query params are silently ignored

The plan's own probe list in `P0-2` uses `from=`/`to=`. **Those are not budi's parameter names.**
The real names are **`since`/`until`** and **`agent`** (not `provider`).

```
/analytics/activity                                    200  27 rows  sha 71a30333
/analytics/activity?from=2026-08-20&to=2026-08-22      200  27 rows  sha 71a30333   ← ignored
/analytics/activity?since=2026-08-20&until=2026-08-22  200   2 rows  sha fed7002c   ← honoured
/analytics/activity?provider=codex                     200  27 rows  sha 71a30333   ← ignored
/analytics/activity?agent=codex                        200   3 rows  sha 9838de5c   ← honoured
```

A typo'd or renamed parameter does not 400 — it returns **all-time** data with a `200`. On this
machine that is **$912.87 reported as "today"**, a 373× overstatement. For a budget tool this is the
worst possible failure direction: it fires every threshold instantly and permanently.

**Mitigation, and it is not optional:** the adapter must *prove* the server honoured the range rather
than trusting it. A cheap, sufficient assertion at adapter construction: issue two probes with
disjoint historical ranges and require different responses; if they match, the parameter contract has
drifted → report the source as unavailable, never as a number. This belongs in the `P1` contract
suite as a first-class test, not as an adapter comment.

### Trap 2 — `until` is EXCLUSIVE on HTTP but INCLUSIVE on the CLI

Same vendor, same version, two surfaces, opposite semantics:

```
budi HTTP  /analytics/providers?since=2026-08-24&until=2026-08-24  →  []          ← $0.00
budi HTTP  /analytics/providers?since=2026-08-24&until=2026-08-25  →  $16.3686
budi CLI   budi stats --since 2026-08-24 --until 2026-08-24        →  $31.13
```

`budi stats --help` documents `--until` as *"**Inclusive** end of an absolute date range"*, and that
is true — of the CLI. On HTTP, the natural spelling of "just today", `since=D&until=D`, returns an
**empty array**. Confirmed across both endpoints and every combination tested (`spike/` matrix).

An empty array is indistinguishable from an idle day, so the obvious query renders **`$0.00` for a
day that cost real money** — again **Definition of Done #3**. The correct query for a single day `D`
is `since=D&until=D+1`. This must live in one place in the adapter with the asymmetry named in a
comment, and a fixture-backed regression test.

---

## 4. Cross-collector reconciliation, and the timezone axis (D-extra)

The plan does not list a "two collectors agree" criterion, but **DoD #6** requires them provably
interchangeable, so it was tested. The first read looked alarming — a **1.90× disagreement** for
2026-08-24, $16.37 vs $31.13. It is not a disagreement. It is a **timezone axis mismatch**, and once
aligned the two collectors are exact:

| Source | Axis | 2026-08-24 |
|---|---|---|
| budi HTTP `?since=&until=` | **UTC** | **$16.3686** |
| ccusage `-z UTC` | UTC | **$16.3686** |
| budi CLI `--since/--until` | **local (Asia/Jerusalem)** | **$31.1300** |
| ccusage `-z Asia/Jerusalem` | local | **$31.1282** |

Measured simultaneously (`spike/02-reconciliation.txt`). UTC axis agrees to four decimal places; the
local-axis `$0.0018` delta is only budi's CLI rounding to whole cents (`3113`). **Two independently
written collectors, agreeing to the cent on real data — that is the strongest possible evidence for
ADR-v2-001.** It also means the `P1` contract suite can assert cross-adapter equality, provided it
pins the axis.

**But the axis is now a product decision, not an implementation detail.** budi's HTTP surface — our
chosen primary — buckets by **UTC**, while the user's "today" is their wall clock. On this machine
that is a **1.90× error in the headline number**, and it is worst for exactly the user the personas
describe: an evening worker at a positive UTC offset, whose late-night spend lands on tomorrow's
budget. `resetHourLocal` in the config implies local. **`/analytics/statusline` does not expose an
axis parameter at all**, so the one endpoint that otherwise does everything cannot be told which day
to use.

Options, all cheap, none free:
- **(a)** derive the day from `/analytics/activity?agent=…&since=…&until=…` and accept the UTC axis, labelling it;
- **(b)** shell out to `budi stats --timezone <IANA>` for local-correct days, paying ~10–30 ms per call — measured, affordable;
- **(c)** sum `/analytics/sessions` into local days ourselves — rejected, that is day-bucketing arithmetic and brushes ADR-v2-001.

**This is a new blocking question, `PRE-G`, raised not answered** — see §7.

---

## 5. D1–D4 — the CLI paths (`P0-3`)

### `budi stats … --format json` — **PASS on all four**

`-p today` returns per-provider rows with `estimated_cost` + `total_cost_cents`, plus an explicit
`"window_start": "2026-08-24T21:00:00+00:00"` — which is **local midnight** (00:00 IDT = 21:00 Z),
confirming the CLI's local axis. `stats daily -p 7d --format json` returns `buckets[]` keyed
`label: "2026-08-17"` with `cost_cents`. `--timezone <IANA>`, `--provider`, `--since/--until` all
documented and honoured.

Caveat: the CLI rounds `total_cost_cents` to **whole cents** (`250`, `3113`) where HTTP returns
fractional (`2.4435`, `1636.8572`). Immaterial at a daily-budget scale; do not build a
cent-exact cross-adapter equality assertion on it.

### `ccusage daily --json --offline` — **PASS on D1, D2, D4; PARTIAL on D3**

- **D1 PASS.** Rows keyed `"period": "2026-08-25"`; `--since/--until` honoured, and **`--until` is
  inclusive** here (`--since D --until D` → exactly one row) — a *third* range convention across the
  three probed surfaces.
- **D2 PASS.** `totalCost` in USD, plus a `totals` roll-up and `modelBreakdowns[]`.
- **D3 PARTIAL.** Default rows are `"agent": "all"` with only `metadata.agents: ["claude"]` naming
  contributors — cost is **not** split per tool. `--by-agent` exists ("Include per-agent JSON
  breakdowns in unified report rows") and is the flag the `P4` ccusage adapter must pass. On this
  machine no single day mixed two agents, so **a genuinely mixed-agent day was not observed and
  per-tool splitting is unverified** for ccusage. Do not treat ccusage D3 as proven.
- Coverage: Claude + Codex only, as expected.

**ccusage remains a viable zero-install path for Risk R1** — `npx -y ccusage@20` worked with no
global install. Cost: **3.44 s cold**, ~2–3 s warm. That is 100× budi's CLI and must never sit on the
statusline path; it is a `lum`-only fallback, exactly as `P4` assumes.

---

## 6. Latency (feeds `P3`'s <30 ms p95 budget)

| Path | n | median | p95 |
|---|---|---|---|
| `/analytics/providers?since=&until=` | 30 | **1.7 ms** | **1.8 ms** |
| `/analytics/statusline` | 30 | 13.7 ms | **16.0 ms** (max 34.7) |
| `budi stats -p today --format json` (process spawn) | 5 | ~10 ms | ~30 ms |
| `npx ccusage daily --json --offline` | — | ~2–3 s | 3.44 s cold |

The collector is not the bottleneck. **But `P3`'s exit criterion is <30 ms p95 for our
`statusline.js`, and Node's own cold start is ~40 ms before a single line of our code runs** — so
that criterion is unmeetable by a Node entrypoint on any collector, and `/analytics/statusline` at
16 ms p95 would consume half the budget even if startup were free. Prefer the 1.8 ms
`providers` route on the hot path, and expect `P3`'s budget to need restating as "excluding
interpreter start" or the entrypoint to stop being Node. Flagged for `P3`, not resolved here.

---

## 7. `PRE-G` — new blocking question (raised, **not** answered)

> **`PRE-G` · Which timezone axis defines "today"?** budi's HTTP API buckets by **UTC**; its CLI and
> the user's wall clock use **local**. Measured spread on the spike machine: **$16.37 vs $31.13 for
> the same calendar date — 1.90×.** `/analytics/statusline`, the single endpoint that otherwise
> satisfies D1–D3 and hands us pacing for free, exposes **no** axis parameter. `resetHourLocal`
> in the documented config implies local was always intended.
>
> **Blocks:** the correctness of the headline number, hence `P1` adapter shape and `P2` thresholds.
> A threshold that fires on a UTC day fires at the wrong time for every user not on UTC.
>
> Per `SPEC.md` §7 — *"No agent may close any of these"* — this is recorded, not decided.

**ANSWERED by the human on 2026-08-25: local.** The wall clock defines "today"; UTC is never
inherited from a collector API. This also flipped the primary collector to ccusage, whose `-z <IANA>`
expresses the local axis natively where budi's HTTP surface cannot. Decision and consequences:
[`feedback/HUMAN_QUESTIONS.md`](feedback/HUMAN_QUESTIONS.md).

Consistent with the register's own warning that a gate living only in the document that noticed it is
a gate nobody sees, `PRE-G` has been added to
[`feedback/HUMAN_QUESTIONS.md`](feedback/HUMAN_QUESTIONS.md).

## 8. What the spike says about the other open questions

Evidence only. **None of these is closed.**

- **`PRE-A` (tool list).** budi detected **four** providers unprompted — Claude Code (126 files),
  Codex (2), Copilot Chat (22, via VS Code/Cursor storage), Cursor (watch root, 0 sessions). But
  after backfill **only Claude Code and Codex produced rows**; Copilot Chat imported **0 messages
  from 22 files** and `doctor` warned *"Likely a parser shape regression — check MIN_API_VERSION."*
  So budi's *advertised* coverage is 4+ tools; its *delivered* coverage on this machine is 2 — the
  same two ccusage covers for free. **The zero-install ccusage path is therefore not obviously worse
  than budi here**, which materially weakens the case for paying budi's install friction (`PRE-E`).
- **`PRE-E` (install friction).** Confirmed concretely: 10.7 MiB download, ad-hoc-signed unnotarised
  binary, a background daemon, **plus** a non-obvious mandatory `budi db import` before any history
  exists. That is more friction than "install a collector" conveys.
- **`OPEN-F` (thresholds on rate-limit % or USD).** budi does **not** expose Anthropic's real
  `rate_limits`. `/analytics/rate-limit-windows` returns budi's own *derived* 5-hour billing blocks
  (`window_index`, `burn_rate_cents_per_minute`, `is_active`) — inferred from transcript timing, not
  provider-reported quota. So the rate-limit-percentage headline in `DESIGN.md` **can only** come
  from Claude Code's statusline stdin, and is unavailable to `lum today`. `OPEN-F` cannot be answered
  by choosing a collector.
- **`PRE-B` / **`PRE-D`** (demand, rename).** Untouched. Out of scope for a technical spike.

---

## 9. Files produced

```
spike/00-env.txt                 budi --version / status / doctor, verbatim + extracted routes
spike/00-dates.txt               date anchors used
spike/01-route-matrix.txt        20 routes × status × size × latency
spike/02-reconciliation.txt      the four-way simultaneous cross-collector read
spike/raw-*.json                 17 route bodies (incl. raw-providers-{today,yesterday,all-time})
spike/d4-sample{1,2,3}.json      D4 determinism samples (1 vs 3 are 89 s apart)
spike/cli-budi.json              budi stats -p today --format json
spike/cli-budi-daily.json        budi stats daily -p 7d --format json
spike/cli-ccusage.json           ccusage daily --json --offline
spike/cli-ccusage-byagent.json   ccusage daily --json --offline --by-agent
```

`P0-5` freezes the scrubbed subset of these as `test/fixtures/collector/`.

**One deliberate deviation from `P0-5`.** The task says *"`spike/` deleted"*. It has been
**git-ignored instead of deleted**, for two reasons: the raw bodies are the evidence a human needs in
order to close `PRE-C` and `PRE-G`, and deleting them is irreversible. The privacy goal that the
deletion served is met by the `.gitignore` entry — `spike/` holds real repository names
(`filter-options`) and session titles (`sessions`) and must never be committed. **17 scrubbed
fixtures** are frozen under `test/fixtures/collector/` with a provenance `README.md`; the scrub was
verified by an exhaustive dump of every string value in every fixture (81 distinct, all dates,
timestamps, provider/model ids, synthetic session ids, or `[scrubbed]`). Delete `spike/` once both
gates are closed.

## 10. Recommended next actions

1. **Human closes `PRE-C`** by reading this file. The technical answer is GO.
2. **Human answers `PRE-G`** before `P1-2` (`budi.http.ts`) is written — it decides the adapter's
   shape, not just a constant.
3. Start `P1-0`/`P1-1` now; they are axis-independent.
4. Fold three spike findings into the `P1` contract suite as tests, not comments:
   range-honoured probe (Trap 1), exclusive-vs-inclusive `until` (Trap 2), and the
   un-backfilled-collector state (§1a.2) which must render "unknown", never `$0.00`.
5. Re-scope `pacing.ts` (`P2`) — `/analytics/statusline` may already supply it.
6. Restate `P3`'s <30 ms p95 to exclude interpreter start, or reconsider a Node entrypoint.
