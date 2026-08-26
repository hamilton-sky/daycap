# local-usage-meter

Planning-stage repo for **LocalUsageMeter** — a local **budget guardrail** for AI coding tools.
It reads today's spend from a usage collector already on the machine, compares it against a
configurable daily allowance across *every* tool you use — Claude Code, Codex, Cursor, Copilot — and
warns you before the allowance is gone. No server, no proxy, no login.

> **Status: P0 passed (GO), P1 started — 2026-08-25.** The collector spike is done and the verdict
> is **GO**: see [`SPIKE_RESULT.md`](pathly/features/local-usage-meter/SPIKE_RESULT.md). budi + ccusage
> reconcile to the cent on 21,000 real messages. `src/` now exists — the P1-0 scaffold, the domain
> types and ports (P1-1), and the usage-day boundary with 100% branch coverage (P1-2). `pnpm verify`
> is green. Next: `P1-3`, the `UsageSourcePort` contract suite.
>
> **Four gates moved on 2026-08-25.** **`PRE-G` is answered: local.** The user's wall clock defines
> "today" — every day label, budget window and threshold is computed in the user's IANA timezone with
> `resetHourLocal`, and UTC is never inherited from a collector's API. **`PRE-D` is answered:** this
> repo is `local-usage-meter` (bin `lum` unchanged). **`PRE-A` is narrowed** to Claude Code + Codex +
> Cursor, and measurement shows **Cursor exposes no local spend data at all** — its own tracking DB
> has no token or cost column, so no local collector can price it. **The collector flipped:**
> `ccusage@20` is primary (zero install, native `-z <IANA>`, per-tool split verified), with
> `budi.cli.ts` kept as the second real adapter so the contract suite always runs against two real
> implementations. `PRE-C` still needs a human to read `SPIKE_RESULT.md`, and **`PRE-F` is now the
> next real blocker** — ccusage costs 1–3 s per call, so the snapshot cache is load-bearing rather
> than an optimization. See
> [`feedback/HUMAN_QUESTIONS.md`](pathly/features/local-usage-meter/feedback/HUMAN_QUESTIONS.md).
>
> **The design pivoted on 2026-08-24.** v1 planned to build its own usage collector for two CLIs.
> Market research found that layer is thoroughly commoditised — [budi](https://github.com/siropkin/budi)
> ships almost exactly that architecture for five tools, and
> [Token Tracker](https://github.com/xiufengsun/TokenTracker) covers 34. But **none of them does
> budgets or alerts.** v2 consumes a collector and owns the policy layer instead. See
> [Where this stands](#where-this-stands).

---

## Why

Provider consoles aggregate usage server-side with 1–2 day latency, so you can't see today's spend
in time to stay inside a daily allowance. Local transcripts carry the provider-reported `usage`
block per turn, so a collector reading them gives an immediate, reasonably accurate number — that
part is solved, several times over.

What isn't solved: every AI coding tool has its own console, its own plan, and its own limit. None of them tells you
your **total** for today, and none of them warns you before you run out. The existing trackers all
answer *"what did I spend?"* — this answers *"am I about to blow my allowance?"*

The primary surface is one line in your Claude Code statusline:

```
today $3.20 / $10.00 (32%) ▓▓░░░          API-key account, under 80%     (green)
5h 23% · 7d 41% ▓▓░░░  ≈$3.20 today       subscription — rate limit first
today $6.40 / $10.00 (64%) ▓▓▓░░ ↑        ahead of pace for the time of day
today $8.40 / $10.00 (84%) ▓▓▓▓░          crossed 80%      (amber + notification)
today $11.90 / $10.00 (119%) ▓▓▓▓▓        over budget      (red + notification)
lum — (no source)                          no collector installed or running
```

On a subscription the headline is **rate-limit percentage**, not dollars — imputed USD is money that
doesn't exist, and Claude Code hands the real constraint to the statusline on stdin. Plus
`lum today` (per-tool breakdown) and `lum doctor` (which collector, how fresh, what's missing).

## Design in one diagram

We never parse a log. A collector already on the machine does that — for more tools than we ever
would — and we own the budget policy on top.

```
  Claude Code ─┐
  Codex CLI   ─┤   (collector already tails these)
  Cursor      ─┼──►  budi daemon :7878  ──► normalised, priced usage
  Copilot     ─┤     (or Token Tracker, or ccusage)
  …           ─┘                                  │
                                          GET /analytics/*
                                                  ▼
                     ┌────────────────────────────────────────────┐
                     │  lum  —  budget policy only                │
                     │  evaluate → latch → render → notify        │
                     └───────────────────┬────────────────────────┘
     Claude Code stdin ──────────────────┤  rate_limits, cost, context_window
                                         ▼
                        statusline row · lum today · OS notification
```

Node ≥ 20.11, TypeScript, ESM-only. `domain/` is pure (no fs, no clock, no network — enforced by
lint *and* a test that greps the build output); `adapters/source/*` implements `UsageSourcePort`
once per collector, so no collector is load-bearing.

**No daemon of our own.** v1 needed one to own a dedup set (now the collector's job) and a threshold
latch (a file, not a process). Deleting it also deletes the lockfile, liveness detection, the
self-spawning background process nobody consented to, and `service install`.

### The traps — now collector-selection criteria

Verified against a real 3,683-line session log on 2026-08-24. We no longer implement these, but a
collector that gets them wrong reports wrong numbers, so they're worth testing before you trust one:

- **Double-counting.** Claude Code writes the same assistant message into several `.jsonl` files on
  resume/compact/branch. Measured inflation without a `message.id` + `requestId` dedup key: **2.41×**.
- **Cache-bucket direction.** Anthropic's `input_tokens` *excludes* cache reads (measured: max
  `input_tokens` = **2** vs max `cache_read_input_tokens` = **992,185**); OpenAI's includes them.
  Cache read was **97.4%** of a 30-day sample — mispricing it as plain input turns ~$1,135 into ~$6,792.
- **Cache TTL.** Real logs carried the 5m/1h split on **100%** of turns, and it was **100% 1-hour
  (2×)** — not the 5-minute tier (1.25×) that v1's own ADR assumed.

## Repo layout

```
src/domain/{types,ports,window}.ts      P1-1, P1-2 — pure: no fs, no net, no clock
src/bin/{lum.ts,statusline.js}          entrypoints; statusline is node:fs only, always exit 0
test/unit/                              74 tests; src/domain/** is at 100% branch coverage
test/fixtures/collector/                17 scrubbed collector fixtures frozen by P0-5, + README
local-usage-meter-BRIEF.md              the original seed (scope-change banner at top)
pathly/features/local-usage-meter/
  SPIKE_RESULT.md                       ← P0 verdict (GO), the two API traps, and PRE-G
  ARCHITECTURE_PROPOSAL.md              ← v2, CURRENT. Start here.
  archive/…-v1-own-parsers.md           v1 (927 lines), superseded — kept for its reasoning
  PO_NOTES.md                           personas, success criteria, constraints
  RESEARCH.md                           §1–4 API findings · §5 competitive landscape (forced v2)
  DESIGN.md                             palette, statusline format, notification copy
  fixtures/                             scrubbed real Claude log — collector conformance fixture
  feedback/HUMAN_QUESTIONS.md           the five open decisions (PRE-A…PRE-E)
  artifacts/BOARD_EVAL.md               v1 execution plan — superseded
  BOARD.json / EVENTS.jsonl / STATE.json   Pathly board + event log (generated)
```

Read `ARCHITECTURE_PROPOSAL.md` (v2) first — §1 position statement, §3 the port, §7 phases.
`feedback/HUMAN_QUESTIONS.md` is the shortest path to what is *not* settled.

## Where this stands

A [Pathly](https://github.com/hamilton-sky/pathly-adapters) agent pipeline ran PO → architecture →
research → design → planning on 2026-08-10 and produced ~1,650 lines of markdown, four goals,
fourteen tasks, and no code. On 2026-08-24 a competitive review found the design was aimed at the
commoditised half of the problem, and v2 replaced it.

**Five decisions are open, all needing a human:**

| # | Decision | Why it matters |
|---|---|---|
| **PRE-A** | **The exact tool list.** The brief says Claude Code + Codex; the target market also uses **Cursor**. | Decides the collector, and whether a zero-install path exists. Cursor can't be served by v1's design at all. |
| **PRE-B** | **Has anyone asked for this?** No budget/alert issue has ever been filed on budi. | Unclaimed and unwanted look identical from outside. File the issue — cheap signal. |
| **PRE-C** | **Does budi's `/analytics/*` return day-shaped per-tool spend?** | One `curl`. Go/no-go on the whole plan before any code is written. |
| **PRE-D** | **Rename.** [Token Tracker](https://github.com/xiufengsun/TokenTracker) is an established OSS project doing exactly this. | The repo is two commits old — cheapest it will ever be to fix. |
| **PRE-E** | **Is doubled install friction acceptable?** Users install a 13 MB Rust collector before this does anything. | The brief promised "setup is trivial". Main adoption threat. |

## Planned phases (v2)

| Phase | Delivers | Exit criteria |
|---|---|---|
| **P0** | Spike: hit `127.0.0.1:7878/analytics/*`, print today's per-tool spend | Real numbers for ≥2 tools. **Go/no-go gate.** |
| **P1** | `domain/*`, `budi.http.ts`, `lum today` | Per-tool and total reconcile; degrades cleanly when the daemon is down |
| **P2** | `budget.ts`, `pacing.ts`, `latch.ts`, notifier | 0.8 then 1.0 fire exactly once; no re-fire across restart or dip-below |
| **P3** | `statusline.js`, stdin parsing, rate-limit primary | <30 ms p95; exit 0 on every fault; `rate_limits` absent handled silently |
| **P4** | `ccusage.shellout.ts`, `tokentracker.ts`, `lum doctor` | Works with zero collectors (degraded) and with each one |

P0 is a genuine gate, not a formality. If budi's analytics endpoints are session-shaped rather than
day-shaped, P1 shifts to `budi stats --format json` — worth knowing before anything else exists.

## Non-goals

- **Collecting usage.** We consume a collector; we never parse a transcript. That's ADR-v2-001.
- Hard-blocking when over budget — advisory only; nothing here can intercept a CLI.
- Central multi-user aggregation — no server, no backend, no shared database.
- Any network call beyond `127.0.0.1` to the local collector.
- Billing-exact accuracy — "reasonable" is the bar.

## Privacy

Nothing leaves the machine, and v2 strengthens this: we no longer read transcripts at all. The only
network call any shipped code may make is loopback to the local collector, enforced by a lint rule
*and* a build-artifact grep test. A canary-string test asserts no fixture content reaches any output.

The fixture in `fixtures/` was built by whitelist — constructing a new object from permitted fields,
never filtering the original — and verified to contain 10 keys, one content string (`[scrubbed]`),
zero prose, and zero filesystem paths.

## License

Not yet chosen. ccusage, whose pricing table this design vendors, is MIT.
