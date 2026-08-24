# Feature Brief — LocalUsageMeter

> **⚠ SCOPE CHANGED 2026-08-24 — read `ARCHITECTURE_PROPOSAL.md` (v2) first.**
> This brief describes building a usage *collector* for two CLIs. That layer turned out to be
> commoditised — budi, Token Tracker and ccusage already do it for 5–34 tools. The product is now
> the **budget and alert layer on top of an existing collector**, across every tool the user runs
> (Claude Code, Codex, **Cursor**, Copilot, …), for **other developers**, not the author.
> Sections below marked ~~struck~~ are superseded. The problem statement and the acceptance tests
> still hold.
_Seed for the Pathly pipeline (STORM → PLAN → DESIGN → BUILD → REVIEW → TEST). Feed this as the
feature brief and let PLAN/DESIGN refine it into the canonical USER_STORIES.md + IMPLEMENTATION_PLAN.md.
Self-contained — no dependency on any other repo._

## One-liner
A local, per-developer **budget guardrail** for AI coding tools: it reads today's spend from a
usage collector already on the machine, compares it to a configurable daily budget across **every**
tool the developer uses, and warns before the allowance is gone — no server, no proxy, no login.

~~A local, per-developer tool that reads Claude Code + Codex CLI session logs in near-real-time…~~
(superseded: we no longer read logs — see ADR-v2-001.)

## Problem / context
Provider consoles (Anthropic / OpenAI) aggregate usage server-side with 1–2 day latency, so a
developer cannot see today's spend in time to stay within a daily allowance. The local CLI session
logs, however, are written per-turn and carry the provider-reported `usage`. Reading them gives an
immediate, reasonably-accurate number.

## Goal & scope
- In scope: read local logs for Claude Code + Codex; compute today's tokens + USD per CLI/model;
  compare to a daily budget; display live (statusline first, then menu-bar / TUI); advisory warnings.
- Out of scope (v1): hard-blocking over budget; central multi-user aggregation; any network/backend.

## Personas
- **Multi-tool developer (primary, and NOT the author).** Uses several AI coding tools in one day —
  Claude Code, Codex CLI, Cursor, Copilot, and others — each with its own console, plan and limit,
  and no single number anywhere. Wants one allowance across all of them and a warning before it is
  spent. This persona is why the two-CLI scope in this brief is wrong.
- Eng manager (secondary, later): a team rollup — deferred entirely.

> The author's own machine is **not** representative: measured over 30 days it was 100.0% Claude
> Code and 0.001% Codex. Design decisions must come from the target user, not from local logs.

## Ground truth — now the COLLECTOR's responsibility

> Everything in this section is still true about the data. It is no longer **our** code to write.
> Use it instead as **acceptance criteria for choosing a collector**: a collector that gets these
> wrong produces wrong numbers, and that is worth testing before adopting one. All three were
> verified against a real log on 2026-08-24 — see `ARCHITECTURE_PROPOSAL.md` Appendix.

~~## Ground truth the build MUST honor~~
- Log locations & fields:
  - Claude Code: `~/.claude/projects/**/*.jsonl` — per assistant message `message.usage`:
    input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, model, ts.
  - Codex: `~/.codex/sessions/**` JSONL — turn.completed / token_count events:
    input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens.
- Reuse the ccusage project (MIT, https://github.com/ryoppippi/ccusage) for parsing BOTH CLIs and
  for token pricing — either shell out to it (JSON output) or embed it. Do NOT re-implement tokenization.
- Reported `usage` ALREADY includes tool-call tokens (tool defs = input, tool_use = output,
  tool_result = input) → no special tool handling; never separately tokenize tools (double-counts).
- Price 4 token classes separately: uncached input (1×), cache write (1.25×/2×), cache read (0.1×),
  output incl. reasoning (output rate). Collapsing cache into one bucket is the top accuracy bug.
- Real-time via fs-watch / short poll on the log dirs — never poll the provider console for the live number.
- Budget is ADVISORY (a passive reader can't block the CLI). Subscription accounts have no marginal $
  → show an IMPUTED $ at API rates, clearly labeled. API-key accounts → real marginal $.
- Accuracy is "reasonable", not billing-exact (occasional log undercount) — acceptable; optionally
  reconcile once/day vs the console and show a small "±".

## User stories (seed for USER_STORIES.md)
1. As a developer, I want today's total AI cost vs my daily budget in my Claude Code statusline, so I
   stay within my allowance without leaving the terminal.
   - Given a configured dailyBudgetUsd, when I finish a Claude Code turn, then within a few seconds the
     statusline shows `today $X / $BUDGET (P%)`.
2. As a developer, I want Codex usage in the same total, so my daily number reflects all my AI CLI work.
   - Given Codex sessions under ~/.codex, when today's total is computed, then Codex tokens are priced
     from tokens (Codex reports no $) and added.
3. As a developer, I want a visible warning as I approach my budget, so I can slow down before overspending.
   - Given usage crosses 80% then 100% of the daily budget, when the display refreshes, then it turns
     amber then red and emits a notification.
4. As a developer, I want the tool to run fully offline with no account, so setup is trivial and nothing
   leaves my machine.
   - Given no network, when I run the tool, then today's number still computes from local logs.
5. As a developer, I want a live breakdown by CLI and model, so I understand what drives my spend.
6. (stretch) As an eng manager, I want each developer's daily rollup shipped to a central dashboard
   (metadata only — tokens/cost/model/identity, NEVER prompt/response bodies), so I can see team usage.

## Implementation plan — SUPERSEDED

The six phases here built a collector. See `ARCHITECTURE_PROPOSAL.md` §7 for the v2 phases
(P0 spike → P1 core → P2 budget → P3 statusline → P4 portability). P0 is a genuine go/no-go gate:
one `curl` against the collector's API decides whether the rest of the plan is buildable.

~~Phase 1 Core reader + pricing · Phase 2 Live loop · Phase 3 Statusline · Phase 4 Budget +
thresholds · Phase 5 Breakdown UI · Phase 6 tray/reconcile/shipper~~

## Design notes (for DESIGN phase)
- Primary surface = Claude Code statusline (zero extra window): `today $3.20 / $10.00 (32%) ▓▓▓░░`.
- Secondary = menu-bar / tray (always visible, color-coded) and a `--live` terminal dashboard.
- Color semantics: <80% green, 80% amber, 100% red. Label imputed cost clearly for subscription users.

## Config
`~/.localusagemeter/config.json` →
{ "dailyBudgetUsd": 10.0, "resetHourLocal": 0, "thresholds": [0.8, 1.0],
  "clis": ["claude","codex"], "imputeCostForSubscription": true }

## Acceptance tests (for TEST phase — Given/When/Then)
- After one Claude Code turn, today's $ updates within a few seconds WITHOUT opening the console.
- A tool-heavy session's counted tokens equal the log `usage` (tools included, not doubled).
- A Codex session is counted and priced from tokens.
- Crossing 80% / 100% of the daily budget shows amber / red + a notification.
- Runs fully offline (no account, no network) and still shows today's number.

## Non-goals (v1)
- Hard-blocking over budget (would need a proxy chokepoint).
- Central multi-user aggregation (separate stretch).
- Billing-exact numbers (reasonable accuracy is sufficient).

## Suggested rigor
`standard` (plan + design + build + review + test) — it's a real product surface and the review/test
phases matter. Use `lite` only for a throwaway first cut.

## Verification asset — SUPPLIED, now advisory

`pathly/features/local-usage-meter/fixtures/claude-session-scrubbed.jsonl` (88 lines, 30 unique
turns, 58 natural duplicates, whitelist-scrubbed). It no longer gates our build — we parse nothing —
but it is a good **collector conformance fixture**: a collector that reports the wrong total for
this file has the dedup or cache-bucket bug.
