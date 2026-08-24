# Architecture Proposal v2 — LocalUsageMeter

_Stage: DESIGN · Rigor: standard · Date: 2026-08-24_
_Supersedes: [`archive/ARCHITECTURE_PROPOSAL-v1-own-parsers.md`](archive/ARCHITECTURE_PROPOSAL-v1-own-parsers.md) (927 lines, never built)_
_Sources of truth: `PO_NOTES.md`, `../../../local-usage-meter-BRIEF.md`, `RESEARCH.md` §5_

---

## Why there is a v2

v1 designed a complete usage-collection stack: its own JSONL readers for two CLIs, its own
rotation-safe tail, its own dedup, its own vendored price table, a reconciler, and a single-writer
daemon. The engineering was sound. The premise was not.

**Market research on 2026-08-24 found that layer is thoroughly commoditised**, by projects that do
it for far more tools than v1 planned to support:

| Project | Tools covered | Method | Budget + alerts | License |
|---|---|---|---|---|
| [budi](https://github.com/siropkin/budi) | Claude Code, Cursor, Codex, Copilot Chat, Copilot CLI | transcript tailing, no proxy | ❌ | MIT |
| [Token Tracker](https://github.com/xiufengsun/TokenTracker) | **34 tools**, 2,200+ models | log parsing | ❌ | OSS |
| [ccusage](https://github.com/ryoppippi/ccusage) | Claude + Codex | log parsing | ❌ | MIT |
| **v1 (planned)** | Claude + Codex **(2)** | log tailing | ✅ | — |

budi is, almost line for line, the architecture v1 specified — local-first, transcript-tailing, no
proxy, daemon-backed — already shipped, MIT, covering five tools including Cursor.

**But none of them does budgets or alerts.** Every one answers *"what did I spend?"* Not one answers
*"am I about to blow my allowance?"* That gap is real and unclaimed.

> **v2 in one sentence: stop collecting usage, start governing it.**
> We consume a collector's normalised output and own the budget policy, the threshold latch, the
> notification, and the readout — the parts nobody has built.

This also fixes v1's worst product flaw. v1 defaulted `accountMode` to `"subscription"` and then
computed an *imputed* dollar figure — money that does not exist — while §6.2 explicitly refused to
read stdin. Claude Code hands the statusline `rate_limits.five_hour.used_percentage` and
`seven_day.used_percentage` on that very pipe. For a subscription developer that is the binding
constraint, and v2 treats it as the primary signal.

---

## 1. Position statement

Three decisions carry v2.

1. **Never parse a log file.** Usage arrives already normalised, deduped and priced from a
   collector behind `UsageSourcePort`. Every accuracy trap v1 spent 300 lines on — cross-file
   duplicate `message.id`, cumulative Codex totals, cache-bucket direction, the `iterations[]`
   array — becomes the collector's problem, and they already solve it for more tools than we would.
2. **No daemon of our own.** v1 needed one to own the dedup set and the threshold latch. Dedup is
   gone. The latch is a *file*, not a process. The collector already runs a daemon; adding a second
   is how you get a lockfile, liveness detection, self-spawn-without-consent, and `service install`.
3. **Read stdin.** Rate-limit percentage is the primary figure on subscription accounts; imputed
   dollars are secondary and always marked `≈`.

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
     (rate_limits!)                      ▼
                        statusline row · lum today · OS notification
```

---

## 2. Layers

Same discipline as v1, a third of the surface. Dependency direction is strictly inward.

```
domain/       pure — no fs, no net, no clock
  budget.ts       evaluate(spend, cfg) -> {fraction, state, crossed[]}
  pacing.ts       expected-vs-actual for time-of-day  [NEW in v2]
  window.ts       usageDayFor(ts, resetHour, tz)
  types.ts        UsageSnapshot, Config, Threshold
  ports.ts        UsageSourcePort, NotifierPort, StorePort, ClockPort

app/
  meter.ts        pull source -> evaluate -> latch -> emit
  latch.ts        once per threshold per usage-day, persisted

adapters/
  source/
    budi.http.ts        PRIMARY   GET 127.0.0.1:7878/analytics/*
    budi.cli.ts         fallback  budi stats --format json
    ccusage.shellout.ts zero-install path, Claude+Codex only
    tokentracker.ts     alternative collector
  stdin/
    claude-status.ts    parse the statusLine payload; rate_limits, cost, context
  notify/notifier.ts    osascript | notify-send | powershell | bell
  store/atomic-json.ts  latch + cache, tmp+fsync+rename
  render/{statusline,table}.ts

bin/
  lum.ts                CLI
  statusline.js         thin, node:fs only, always exit 0
```

**What v1 had that is now deleted:** `readers/`, `tail.ts`, `dedupe.ts`, `discovery.ts`,
`pricing/`, `prices.snapshot.json`, `reconciler.ts`, `daemon.ts`, `lockfile.ts`, watch adapters,
wake detection, self-spawn, `lum service install`. Roughly 60% of v1, and all of the part that was
reinventing shipped software.

---

## 3. The port that matters

```ts
type UsageWindow = { from: string; to: string };

type ToolSpend = {
  tool: string;          // "claude-code" | "codex" | "cursor" | "copilot" | …
  usd: number;
  imputed: boolean;      // subscription => not real marginal money
  tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
};

interface UsageSourcePort {
  id: string;                                   // "budi" | "ccusage" | "tokentracker"
  available(): Promise<boolean>;                // daemon up? binary on PATH?
  spendFor(window: UsageWindow): Promise<ToolSpend[]>;
  freshness(): Promise<{ lastUpdatedUtc: string | null }>;
}
```

One port, several collectors. This is the abstraction v1 built for ccusage and then stopped needing;
here it is load-bearing, because the collector is genuinely swappable and genuinely unstable.

> **The budi HTTP API is a local daemon's internal surface, not a published contract.** It will
> change without notice. Behind this port that is a one-adapter fix. Called from `app/` it is a
> rewrite. This is the single most important structural rule in v2.

**Degradation is a first-class state.** No collector available is normal, not exceptional:
`lum doctor` names which sources it looked for, and the statusline renders `lum — (no source)`
rather than a stale or invented number.

---

## 4. Config

```jsonc
{
  "dailyBudgetUsd": 10.0,          // advisory
  "resetHourLocal": 0,
  "thresholds": [0.8, 1.0],
  "source": "auto",                // auto | budi | ccusage | tokentracker
  "tools": ["*"],                  // or ["claude-code","cursor"] to scope the budget
  "primarySignal": "auto",         // auto | rate-limit | usd   [NEW in v2]
  "pacing": true,                  // compare spend against elapsed day  [NEW in v2]
  "notifications": { "enabled": true }
}
```

`primarySignal: "auto"` resolves to **rate-limit** when Claude Code's stdin carries `rate_limits`
(subscription), and to **usd** otherwise (API-key accounts, or Cursor/Copilot-only setups). The
brief's five original config keys all survive unchanged.

---

## 5. What we render

```
API-key account       today $3.20 / $10.00 (32%) ▓▓░░░
subscription          5h 23% · 7d 41% ▓▓░░░  ≈$3.20 today
pacing (ahead)        today $6.40 / $10.00 (64%) ▓▓▓░░ ↑ ahead of pace
amber ≥80%            today $8.40 / $10.00 (84%) ▓▓▓▓░
red ≥100%             today $11.90 / $10.00 (119%) ▓▓▓▓▓
no collector          lum — (no source)
```

Pacing is new in v2 and is the reason the readout is more useful than a bare percentage:
*"$4 of $10 and it's 11am"* means something different from *"$4 of $10 and it's 6pm"*. Both budi and
ccusage ship burn-rate; a budget tool without it is strictly worse than the trackers it sits on.

Colour semantics, the `≈` imputed marker, the 16-colour fallback, and the notification copy all
carry over unchanged from `DESIGN.md`.

---

## 6. Statusline contract

Unchanged from v1 except that it now reads stdin, and there is no daemon to self-spawn.

| Property | Guarantee |
|---|---|
| Exit code | Always 0 — every failure path prints a degraded line |
| stdout | Exactly one line |
| stdin | **Consumed** — `process.stdin.resume(); process.stdin.destroy();` then parse if present. Never block on the pipe. |
| Latency | < 30 ms; hard budget 150 ms with self-timeout |
| Imports | `node:fs` only; the cached snapshot is read, never computed |
| Network | Only `127.0.0.1` to the collector, and only from `lum`, never from `statusline.js` |

Claude Code debounces statusline updates at 300 ms and **cancels an in-flight script** when a new
update arrives, so a slow script degrades the line rather than hanging the UI. We still budget for
< 30 ms: `statusline.js` reads a small cache file that `lum` refreshes; it never calls the collector.

---

## 7. Phases

| Phase | Delivers | Exit criteria |
|---|---|---|
| **P0 — Spike** | Hit `127.0.0.1:7878/analytics/*`, print today's per-tool spend | Real numbers for ≥2 tools. **Go/no-go on the whole plan.** |
| **P1 — Core** | `domain/*`, `budi.http.ts`, `lum today` | Per-tool and total reconcile; degrades cleanly with daemon down |
| **P2 — Budget** | `budget.ts`, `pacing.ts`, `latch.ts`, notifier | 0.8 then 1.0 fire exactly once each; no re-fire across restart or dip-below |
| **P3 — Statusline** | `statusline.js`, stdin parsing, rate-limit primary | < 30 ms p95; exit 0 on every injected fault; `rate_limits` absent handled |
| **P4 — Portability** | `ccusage.shellout.ts`, `tokentracker.ts`, `lum doctor` | Works with zero collectors installed (degraded), and with each one |

P0 is a genuine gate. If budi's analytics endpoints turn out to be session-shaped rather than
day-shaped, P1 shifts to `budi stats --format json` — worth knowing before anything else is built.

---

## 8. ADRs

**ADR-v2-001 — Consume a collector; never parse logs.**
*Decision.* All usage enters through `UsageSourcePort`. We ship no log parser.
*Rationale.* budi/Token Tracker/ccusage already solve parsing for 5–34 tools. Every tool we would
add is a new format, a new location, and a permanent maintenance tax. Our value is policy.
*Rejected.* v1's own readers — a treadmill against projects with a large head start.
*Consequence.* Users need a collector installed. See Risk R1 — this is the main adoption cost.

**ADR-v2-002 — No daemon.**
*Decision.* `lum` is invoked; it does not reside in memory. The latch and cache are files.
*Rationale.* v1's daemon existed to own dedup (gone) and the latch (a file). Notifications only
matter right after a turn — when you are not typing, you are not spending — and that is exactly
when the statusline runs.
*Rejected.* A second resident daemon beside the collector's.
*Consequence.* Threshold crossings surface on the next statusline tick or `lum` invocation, not
instantly in the background. Accepted: worst case is a few seconds.

**ADR-v2-003 — Rate limits are the primary signal on subscriptions.**
*Decision.* When Claude Code's stdin carries `rate_limits`, show 5h/7d percentage first; dollars
become secondary and marked `≈`.
*Rationale.* On a subscription, imputed USD is money that does not exist. The docs confirm
`rate_limits` is present for Pro/Max after the first API response, each window independently
optional, with `// empty` the official handling.
*Rejected.* v1's "ignore stdin entirely" — it discarded the only number that binds the default user.
*Consequence.* The field is version-volatile (it regressed in v2.1.96,
[issue #45133](https://github.com/anthropics/claude-code/issues/45133)). Must degrade to USD
silently, never error.

**ADR-v2-004 — Privacy by construction, carried over from v1.**
Unchanged and still enforced by test: no content field ever reaches a record; no network primitive
outside the loopback collector call; canary-string test asserts no fixture content reaches any
output. v2 strengthens this — we no longer read transcripts at all.

---

## 9. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| **R1** | **Install friction doubles.** budi is a 13 MB Rust binary users must install first. The brief promised "setup is trivial". | **High — the main adoption threat** | Ship `ccusage.shellout.ts` as a zero-install path for Claude+Codex-only users; `lum doctor` explains what to install and why |
| **R2** | **budi is a solo project.** 936 commits but 0 external PRs, 13 issues all opened by the owner, issue activity quiet since May 2026. | High | `UsageSourcePort` with ≥2 working adapters before v1.0. Never depend on one collector. |
| **R3** | **The collector API is not a stable contract.** | Medium | Confined to one adapter file; contract test per adapter; `lum doctor` reports adapter health |
| **R4** | **Nobody has asked for this.** No budget/alert issue has ever been filed on budi. Unclaimed and unwanted look identical from outside. | **High — product risk, not technical** | Open an issue on budi describing the feature before building. Validate demand first. |
| **R5** | `rate_limits` absent or removed by a Claude Code release | Medium | Optional by construction; falls back to USD |
| **R6** | Collector and our figures disagree | Low | We do no arithmetic on tokens — we display the collector's totals. Divergence is theirs to fix. |

---

## 10. Prerequisites

| # | Prerequisite | Owner | Status |
|---|---|---|---|
| **PRE-A** | **Confirm the tool list.** Brief says Claude Code + Codex. Stated target market uses Claude + Codex + **Cursor** + more. Cursor is not in the brief and cannot be served by v1's design at all. | Human | **OPEN** |
| **PRE-B** | **Validate demand (R4).** File the budi issue; see whether anyone wants this. | Human | **OPEN** |
| **PRE-C** | **P0 spike** — does `/analytics/*` return day-shaped per-tool spend? | Builder | **OPEN — do this first** |
| **PRE-D** | **Rename the project.** [Token Tracker](https://github.com/xiufengsun/TokenTracker) is an established OSS project doing this exact thing; this repo is currently `token-tracker`. | Human | **OPEN** |
| ~~PRE-1~~ | ~~Scrubbed Claude log~~ | — | **OBSOLETE** — we no longer parse logs. The fixture and its findings are kept in `fixtures/` as evidence for whoever maintains a collector. |
| ~~PRE-10~~ | ~~ccusage constraint sign-off~~ | — | **RESOLVED BY v2** — we now reuse a whole collector, which honours the brief's reuse intent more completely than v1 did. |

---

## Appendix — what carries over from v1

The v1 document is archived, not deleted, because three things in it are worth keeping and were
verified against real data on 2026-08-24:

- **Dedup on `message.id` + `requestId`** — measured **2.41×** inflation without it (905.9M vs
  375.7M tokens on one real session). Now the collector's job, but the number is the reason to
  trust a collector that does it and distrust one that does not.
- **Cache-bucket direction** — Anthropic's `input_tokens` **excludes** cache reads (measured: max
  `input_tokens` = 2 against max `cache_read_input_tokens` = 992,185); OpenAI's includes them.
  Cache read was **97.4%** of all tokens in a 30-day sample — mispricing it as plain input inflates
  a month from ~$1,135 to ~$6,792.
- **Cache TTL** — real logs carried `cache_creation` on 100% of turns, and the split was **100%
  `ephemeral_1h` (2×)**, not the 5-minute tier v1's ADR-006 assumed. A useful acceptance test for
  any collector you trust.

These are now **collector-evaluation criteria** rather than implementation tasks. If a collector
gets them wrong, its numbers are wrong, and that is worth checking before adopting one.
