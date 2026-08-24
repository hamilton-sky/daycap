# Human Questions — local-usage-meter

_Raised by: architect · Stage: DESIGN (storm) · 2026-08-10_
_Reconstructed 2026-08-24 from the board escalation (`type=escalation`, still `status=pending`)._

> **Why this file exists.** `ARCHITECTURE_PROPOSAL.md` closes by pointing here, and four board
> tasks reference "closing ARCH_QUESTION N in HUMAN_QUESTIONS.md" — but the file was never
> written. Its content lived only inside a board message. Restored so the references resolve.

---

## Status at a glance

| # | Question | Decided by | Human acknowledged? |
|---|---|---|---|
| 1 | accountMode — how does the tool know subscription vs API key? | evaluator (Option A) | **No** |
| 2 | Codex sample log at BUILD start | evaluator (Option B) | **No** — see the reversal below |
| 3 | Do thresholds fire on subscription accounts? | evaluator (A+C hybrid) | **No** |
| 4 | Daemon self-spawn without explicit consent | *nobody* | **No — never answered** |
| 5 | ccusage constraint inversion (PRE-10) | evaluator + research | **No** |

The only human input on this board is one reply — *"Use `Defer to build`. Keep it simple."* — to a
different question (whether to supply the Claude log before planning). Everything below was
settled agent-to-agent.

---

## ARCH_QUESTION 1 — accountMode  ·  ratified Option A

How should the tool know whether a CLI is on a subscription plan (imputed USD) or an API key
(real marginal cost)? `imputeCostForSubscription` says *whether* to impute but not *which* kind
of account the developer has.

- **(A)** optional per-CLI `accountMode: { claude: "subscription"|"api", … }`, default
  `"subscription"` — **chosen**. Over-labelling as imputed is harmless; claiming real spend that
  does not exist is misleading.
- (B) always label every figure `≈`. Rejected: API-key users see a hedge on an exact number.
- (C) auto-detect via `ANTHROPIC_API_KEY` / credential files. Rejected: cuts against the
  nothing-sensitive posture and is fragile (an env var can be set without being the auth path).

## ARCH_QUESTION 2 — Codex sample log  ·  Option B, over the evaluator's own objection

Will a scrubbed Codex session log (≥3 `token_count` events) be supplied at BUILD start?

- (A) both Claude and Codex samples at BUILD start.
- **(B)** Claude only; Codex built against synthetic fixtures from the documented shape —
  **adopted**, with defensive normalization and a `PROVISIONAL` marker in `lum doctor`.
- (C) Claude only; Codex slips to a follow-up phase.

**Read this before relying on Codex numbers.** At 15:00 the evaluator posted a board warning:
Option B "is not recommended", the two Codex behaviours (cumulative `total_token_usage`;
whether `input_tokens` includes `cached_input_tokens`) are "undecidable without a real
multi-event session file", and an explicit human answer was required before BUILD. At 17:20 the
same role adopted Option B. The architect's own impact note for (B) was: *"Codex figures ship
unverified and acceptance signal 3 can only be tested against our own assumptions."*

That is where the project stands. Option B is defensible engineering — the normalization is
unconditional and correct per the documented schema — but **acceptance signal 3 is not met and
cannot be called met** until `lum verify-codex` runs against a real log.

## ARCH_QUESTION 3 — subscription thresholds  ·  ratified A+C hybrid

Fire amber/red on subscription accounts where the USD is imputed?

- **(A+C)** fire at the same fractions for every account type, but substitute "usage allowance"
  for "budget" in the notification wording — **chosen**. One string interpolation in
  `notify/notifier.ts`; no change to the budget domain function.
- (B) thresholds only for real marginal spend. Rejected: makes the tool inert for the most
  common Claude Code setup.

## ARCH_QUESTION 4 — daemon self-spawn  ·  UNANSWERED

The statusline self-spawns the daemon when it finds a stale snapshot (throttled, detached,
fire-and-forget) — zero-configuration, but **a background process appears on the developer's
machine without explicit consent**. The alternative is requiring `lum service install`
(launchd / systemd --user).

The architect flagged this for human override and proceeded on self-spawn. It was never
answered, and it is baked into task `70cd6278`. This is a product/consent decision, not an
architecture one — it should not ship on an agent's default.

## ARCH_QUESTION 5 — the ccusage constraint inversion (PRE-10)

PO constraint #1 required reusing ccusage to parse both CLIs and to price, and prohibited
re-implementing. RESEARCH.md §1 found ccusage ≥ v20 is a Rust binary with no JS exports, so the
design now parses JSONL itself and prices from a vendored LiteLLM table; ccusage survives only
as an optional 5-minute cross-check that is skipped when the binary is absent.

The engineering is right. But a hard constraint set by the human was inverted by agents, and
one consequence is easy to miss: **when ccusage is not installed there is no cross-check at
all**, and the Appendix C parity test cannot run. Needs a one-line sign-off.
