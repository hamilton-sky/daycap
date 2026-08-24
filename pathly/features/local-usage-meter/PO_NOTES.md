# PO Notes — local-usage-meter

_Last updated: 2026-08-24 — reconciled with ARCHITECTURE_PROPOSAL.md, RESEARCH.md, DESIGN.md_

> **SCOPE CHANGED 2026-08-24 — see `ARCHITECTURE_PROPOSAL.md` v2.** The product is now the
> budget/alert layer on top of an existing usage collector, across every tool the developer runs.
> The persona is a multi-tool developer who is **not** the author. Constraint #1 below is resolved
> by that change: we now reuse an entire collector rather than a pricing table.

> **Constraint #1 has been inverted since this was written.** RESEARCH.md §1 found ccusage ≥ v20
> is a compiled Rust binary with no importable JS exports, so the design now parses JSONL itself
> and prices from a vendored LiteLLM table. See constraint #1 below and PRE-10 in
> ARCHITECTURE_PROPOSAL.md §10 — it needs a human sign-off that has not been given.

## Who Is This For

**Primary — Multi-tool developer (not the author):** Uses several AI coding tools in the same day —
Claude Code, Codex CLI, **Cursor**, Copilot, others — each with its own console, plan, and limit.
Wants **one** allowance across all of them and a warning before it is gone, without opening any
console and without waiting 1–2 days for server-side aggregation.

> Cursor is **not** in the original brief and cannot be served by the v1 design at all. Confirming
> the exact tool list is prerequisite **PRE-A** — it is the decision the rest of the scope hangs on.

**Secondary (deferred) — Engineering manager:** Wants a per-developer daily rollup on a team
dashboard. This persona is explicitly out of scope for v1 and has no bearing on the initial build.

## Definition of Success

A developer can see their spend against their allowance — **across every AI tool they use** —
within a few seconds of finishing a turn, and is warned *before* the allowance is gone. Computed
entirely on-machine from a local collector, with no account and no internet.

On a subscription account the headline figure is **rate-limit percentage** (`5h 23% · 7d 41%`), not
imputed dollars: imputed USD is money that does not exist, and Claude Code hands the real constraint
to the statusline on stdin (ADR-v2-003).

Specific acceptance signals (from the brief, all required for v1):
1. After one Claude Code turn, today's USD value updates within a few seconds without opening the console.
2. A tool-heavy session's token count equals the log `usage` fields (tools not double-counted).
3. Codex sessions are counted and priced from their token fields.
4. Crossing 80% then 100% of the daily budget triggers amber then red display plus a notification.
5. The tool works fully offline (no account, no network) and still shows today's number.

## Out of Scope

The following are explicitly excluded from v1 and must not creep into the build:

- **Hard-blocking over budget** — advisory only; the tool is a passive log reader and cannot intercept
  the CLI.
- **Central multi-user aggregation** — no server, no backend, no shared database.
- **Any network call for the live number** — must use only local log files (fs-watch / short poll);
  polling the provider console for the live number is prohibited.
- **Billing-exact accuracy** — "reasonable accuracy" (occasional log undercount) is acceptable;
  optional daily reconciliation against the console is a stretch goal only.
- **The eng-manager dashboard / rollup shipper** — deferred to a future phase entirely.

## Constraints

1. ~~**Reuse ccusage (MIT)** for parsing both Claude Code and Codex logs and for token pricing —
   either shell out to it (JSON output) or embed it. Re-implementing tokenization is prohibited.~~
   **SUPERSEDED — awaiting human sign-off (PRE-10).** ccusage ≥ v20 ships as a platform-specific
   Rust binary with no JS/TS library exports (RESEARCH.md §1), so neither the embed nor a
   library-level reuse is buildable. The design now: parses both CLIs with its own readers, prices
   from a vendored LiteLLM `prices.snapshot.json` (the same table ccusage derives from), and shells
   out to the binary only for a 5-minute drift check that is **skipped entirely when the binary is
   absent**. The spirit of the constraint — never re-implement tokenization — is intact: we read
   provider-reported `usage` fields and never count tokens ourselves. The letter is not. This was
   decided by the research and evaluator agents, not by the human who set it.
2. **Four token classes must be priced separately:** uncached input (1×), cache write (1.25×/2×),
   cache read (0.1×), output incl. reasoning (output rate). Collapsing cache buckets is the top
   accuracy bug.
3. **Log locations are fixed ground truth:**
   - Claude Code: `~/.claude/projects/**/*.jsonl` — field `message.usage` (input_tokens,
     output_tokens, cache_creation_input_tokens, cache_read_input_tokens, model, ts).
   - Codex: `~/.codex/sessions/**` JSONL — turn.completed / token_count events
     (input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens).
4. **Nothing leaves the machine** — no prompt/response bodies, no metadata transmitted anywhere.
5. **Subscription accounts** — no marginal cost, so show an imputed USD at API rates, clearly labeled
   as imputed. API-key accounts show real marginal USD.
6. **Config location:** `~/.localusagemeter/config.json` with keys `dailyBudgetUsd`, `resetHourLocal`,
   `thresholds`, `clis`, `imputeCostForSubscription`.
7. **Rigor level: standard** — plan + design + build + review + test. Not a throwaway; the review
   and test phases are required.
8. **Verification asset needed:** at least one real (scrubbed) sample log file must be provided to
   BUILD/TEST so parsing is validated against the actual format, not assumptions.

## Open Questions

_Resolution status as of 2026-08-24. Full detail in `feedback/HUMAN_QUESTIONS.md`._

1. **Sample log file** — **STILL OPEN, and it is the only thing the human was ever asked for.**
   Answered "defer to build" on 2026-08-10; build never started, so it was never supplied. Tracked
   as PRE-1. Until it lands, VERIFY-01 is unconfirmed and acceptance signals 2 and 3 cannot be
   called met. Everything in §3.1 of the architecture — the normalization the entire cost figure
   rests on — is inferred from documentation.
2. **ccusage embedding vs shell-out** — **CLOSED by RESEARCH.md §1: neither.** The embed is
   impossible (Rust binary); the shell-out survives only as an optional reconcile. See constraint
   #1 above and PRE-10.
3. **Statusline script format** — **CLOSED.** RESEARCH.md §3 documents the full stdin schema,
   the ≤300 ms refresh cadence, ANSI support, and the timeout. The design deliberately ignores
   stdin (so a schema change cannot break it) but must call `process.stdin.resume();
   process.stdin.destroy();` at startup to avoid any risk of blocking on the pipe.

### Still requiring a human, not an agent

4. **Daemon self-spawn without explicit consent** — never answered; baked into task `70cd6278`.
5. **PRE-10** — sign-off on the constraint #1 inversion above.
