# SPEC — LocalUsageMeter budget layer, built on a collector API

_Feature: `lum-budget-layer` · Created 2026-08-24 · Rigor: standard_
_Design record: [`../local-usage-meter/`](../local-usage-meter/) — architecture v2, user stories, implementation plan, design system_

---

## 1. What this is

A local budget guardrail for developers who use several AI coding tools in one day. It reads
today's spend from a **usage collector already installed on the machine**, compares it to a
configurable allowance across every tool, and warns *before* the allowance is gone.

**We do not collect usage. We govern it.**

## 2. Why it can be small

The collection layer is commoditised. [budi](https://github.com/siropkin/budi) (MIT) tails
transcripts for Claude Code, Cursor, Codex and Copilot with no proxy;
[Token Tracker](https://github.com/xiufengsun/TokenTracker) covers 34 tools;
[ccusage](https://github.com/ryoppippi/ccusage) covers Claude and Codex. All three answer
*"what did I spend?"*

**None of them answers *"am I about to blow my allowance?"*** No budget/alert issue has ever
been filed on budi. That gap is the entire product.

Because we consume a collector rather than reimplementing one, every accuracy trap the v1 design
spent 300 lines on — cross-file duplicate `message.id` (measured 2.41× inflation), cumulative
Codex totals, cache-bucket direction (cache read is 97.4% of tokens in a real 30-day sample),
`usage.iterations[]`, cache TTL tiers — is the collector's problem, already solved, for more tools
than we would ever support.

## 3. Integration contract

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

Everything enters through one port:

```ts
type ToolSpend = {
  tool: string;          // "claude-code" | "codex" | "cursor" | "copilot" | …
  usd: number;
  imputed: boolean;      // subscription => not real marginal money
  tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
};

interface UsageSourcePort {
  id: string;                                   // "budi" | "ccusage" | "tokentracker"
  available(): Promise<boolean>;
  spendFor(window: { from: string; to: string }): Promise<ToolSpend[]>;
  freshness(): Promise<{ lastUpdatedUtc: string | null }>;
}
```

**No license obligation.** We call a local service over loopback; we copy, modify and distribute
none of its code. budi is MIT (`Copyright (c) 2026 Ivan Seredkin`) — relevant only if we ever
vendor it, which this spec does not.

**The budi HTTP API is a local daemon's internal surface, not a published contract.** It will
change without notice. Behind the port that is a one-adapter fix; called from `app/` it is a
rewrite. This is the single most important structural rule in the build.

## 4. Scope

**In:** one cross-tool total vs a configurable allowance · threshold warnings, exactly once per
threshold per usage-day, surviving restart · rate-limit % as the headline on subscription accounts
· pacing (spend vs elapsed day) · per-tool breakdown · honest degradation when no collector is
present · statusline integration · a second collector adapter.

**Out:** collecting or parsing usage of any kind · hard-blocking spend · any server, backend or
shared database · any network call beyond loopback · billing-exact accuracy.

## 5. Size

30 tasks: **18 S, 12 M, zero L.** ~1,400 LOC production, ~1,200 LOC test.
Wedge (P0+P1+P2) ≈ 2–3 weeks solo; all of P0–P4 ≈ 5–6 weeks. P0 alone is a day.

## 6. Phases

| Phase | Delivers | Exit criteria |
|---|---|---|
| **P0** | Spike the collector API | Day-shaped per-tool spend for ≥2 tools. **Go/no-go gate.** |
| **P1** | domain, port, contract suite, two adapters, `lum today` | Per-tool and total reconcile; degrades cleanly with the daemon down |
| **P2** | budget, pacing, latch, notifier | 0.8 then 1.0 fire exactly once; no re-fire on restart or dip-below |
| **P3** | statusline, stdin parsing, rate-limit primary | <30 ms p95; exit 0 on every fault; `rate_limits` absent handled silently |
| **P4** | third adapter, `lum doctor` | Works with zero collectors (degraded) and with each one |

## 7. Blocking decisions — **all open, all human**

**No agent may close any of these.** This board's predecessor lost a human gate to an agent that
declared it resolved; that must not repeat.

| # | Decision | Blocks |
|---|---|---|
| **PRE-A** | Exact tool list. Brief said Claude Code + Codex; the market also uses Cursor. | Collector choice, adapter scope |
| **PRE-B** | Has anyone asked for this? No budget/alert issue exists on budi. | Whether to build at all |
| **PRE-C** | Does `/analytics/*` return day-shaped per-tool spend? | **P0 — everything** |
| **PRE-D** | Rename. "Token Tracker" is an established OSS project of that name. | Publishing |
| **PRE-E** | Is doubled install friction acceptable? (13 MB Rust collector first) | Adoption; Risk R1 |
| **PRE-F** | **Who writes the statusline's cache?** The statusline can only read; `lum` doesn't reside in memory. Nothing refreshes the meter unless the user types `lum` — the zero-config promise is broken. The only zero-config fix is a detached spawn, which is the unanswered consent question. | Whether this is zero-config or opt-in |
| **OPEN-F** | Do `thresholds` apply to the primary signal or to USD? On a subscription the headline is rate-limit % but alerts fire on imputed dollars — the default user is warned about the wrong thing. | The product's core wedge |

Planning assumes: PRE-A = {Claude Code, Codex, Cursor}; PRE-F = option B (opt-in `lum refresh`);
OPEN-F = USD only. **Each is an assumption, not a decision.**

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | Install friction doubles — users need the collector first | ccusage adapter as a zero-install path for Claude+Codex users; `lum doctor` explains what to install |
| **R2** | budi is a solo project — 936 commits, **0 external PRs**, issues quiet since May 2026 | Contract suite in P1, two real adapters by P1-5. Never depend on one collector. |
| **R3** | Collector API is unstable | One adapter file; contract test per adapter |
| **R4** | **Nobody has asked for this** | PRE-B before building |
| **R5** | `rate_limits` absent or removed by a Claude Code release | Optional by construction; falls back to USD |

## 9. Definition of done

1. One number across every configured tool, correct against the collector's own totals.
2. A warning fires before the allowance is gone — once, at the right moment, never from data we
   are unsure of.
3. Unknown never renders as `$0.00`.
4. The statusline never breaks the user's prompt and never exits non-zero.
5. Nothing leaves the machine.
6. Two collectors are provably interchangeable via one contract suite.
