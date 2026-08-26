# Human Questions — local-usage-meter

_Raised by: architect · Stage: DESIGN (storm) · 2026-08-10_
_Reconstructed 2026-08-24 from the board escalation (`type=escalation`, still `status=pending`)._

> **Why this file exists.** `ARCHITECTURE_PROPOSAL.md` closes by pointing here, and four board
> tasks reference "closing ARCH_QUESTION N in HUMAN_QUESTIONS.md" — but the file was never
> written. Its content lived only inside a board message. Restored so the references resolve.

---

## v2 questions (2026-08-24) — these are the live ones

| # | Question | Why it matters | Status |
|---|---|---|---|
| **PRE-A** | **What is the exact tool list?** The brief says Claude Code + Codex. The stated market uses Claude + Codex + **Cursor** + more. | Decides the collector, and whether a zero-install `ccusage` path is even viable. Cursor cannot be served by the v1 design at all. | **OPEN — narrowed by the human to Claude Code + Codex + Cursor on 2026-08-25, and see [the Cursor finding](#pre-a--cursor-exposes-no-local-spend-data-evidence-2026-08-25) below.** |
| **PRE-B** | **Has anyone asked for this?** No budget/alert issue has ever been filed on budi. | Unclaimed and unwanted look identical from outside. File the issue; the response is cheap signal. | **ANSWERED 2026-08-25 from the public record** — see [below](#pre-b--demand-and-scope-answered-from-the-public-record-2026-08-25). No new issue filed, and the reason matters. |
| **PRE-C** | **Does `/analytics/*` return day-shaped per-tool spend?** | One `curl`. Go/no-go on the whole v2 plan before any code. **Spike executed 2026-08-25: technical answer is GO** — D1–D4 all PASS, and budi + ccusage reconcile to the cent. Evidence: [`../SPIKE_RESULT.md`](../SPIKE_RESULT.md). Per P0-4 the builder does not close this; a human must read the file. | **OPEN (evidence ready)** |
| **PRE-D** | **Rename the project.** [Token Tracker](https://github.com/xiufengsun/TokenTracker) is an established OSS project doing exactly this; the repo is `token-tracker`. | Two commits old — cheapest it will ever be to fix. | **ANSWERED 2026-08-25 — `local-usage-meter`.** Done: see [below](#pre-d--rename--answered-2026-08-25-local-usage-meter). |
| **PRE-E** | **Is doubled install friction acceptable?** Users must install a 13 MB Rust collector before our tool does anything. The brief promised "setup is trivial". | Main adoption threat (Risk R1). | **ANSWERED 2026-08-25 by the [collector decision](#collector-decision-2026-08-25--ccusage-primary-budi-second) — the friction is removed, not accepted.** |
| **PRE-F** | **Who writes the statusline's cache?** The statusline can only read; `lum` doesn't reside in memory. So nothing refreshes the meter unless the user types `lum` — the zero-config promise is broken. The only zero-config fix is a detached spawn, which is ARCH_QUESTION 4 again. Options A/B/C in `ARCHITECTURE_PROPOSAL.md` §6. | **Blocks the zero-config promise.** Planning assumes (B), the opt-in path. | **OPEN** |
| **OPEN-F** | **Should `thresholds` apply to the primary signal or to USD?** On a subscription the headline is rate-limit %, but alerts fire on imputed dollars — so the default user is warned about the wrong thing. | The product's entire wedge is the warning. Firing it on the wrong signal defeats the point. | **OPEN** |
| **PRE-G** | **Which timezone axis defines "today"?** budi's HTTP API buckets days by **UTC**; its own CLI and the user's wall clock use **local**. Measured on the spike machine (UTC+3): the same calendar date is **$16.37 (UTC) vs $31.13 (local) — 1.90×**. `/analytics/statusline`, the one endpoint that satisfies D1–D3 and supplies pacing for free, exposes **no** axis parameter. `resetHourLocal` in the config implies local was always intended. | **Blocks the correctness of the headline number**, hence the P1 adapter shape and P2 thresholds: a threshold evaluated on a UTC day fires at the wrong hour for every user not on UTC. Evidence: [`../SPIKE_RESULT.md`](../SPIKE_RESULT.md) §4, §7. | **ANSWERED 2026-08-25 — local.** See [the decision](#pre-g--timezone-axis--answered-2026-08-25-local) below. |

## PRE-A — Cursor exposes no local spend data (evidence, 2026-08-25)

_Measured on the spike machine after the human narrowed the tool set to **Claude Code + Codex +
Cursor, nothing more**. Evidence only — `PRE-A` is not closed here._

Cursor keeps local telemetry, but **not spend**. `~/.cursor/ai-tracking/ai-code-tracking.db`
(SQLite, installed by Cursor itself) has six tables — `ai_code_hashes`, `scored_commits`,
`conversation_summaries`, `tracked_file_content`, `ai_deleted_files`, `tracking_state` — and
**zero columns matching `token`, `cost`, `usd` or `price`**. What it does track is AI-*authored
code*: `linesAdded`, `composerLinesAdded`, `tabLinesAdded`, `v2AiPercentage`, plus per-hash
`model` and `conversationId`. On this machine both counting tables are empty and the file was last
written 2026-07-04, but that is incidental — **the absence of a cost column is schema-level, not
data-level.**

The other candidate store, `…/Application Support/Cursor/User/globalStorage/state.vscdb`, contains
no usage keys either: the only keys matching `token` are `cursorAuth/accessToken` and
`cursorAuth/refreshToken` — OAuth credentials, not token counts. Cursor's spend lives server-side,
behind that credential.

**Consequences for the narrowed scope:**

- **No local collector can supply Cursor spend, so this is not a budi-vs-ccusage question.** budi's
  advertised Cursor support is a watch root that yielded **0 sessions** in the spike (§8), and its
  Copilot Chat support imported **0 messages from 22 files** — advertised coverage is not delivered
  coverage. ccusage covers Claude + Codex by design. Both collectors deliver **exactly the same two
  tools** the narrowed scope needs; neither delivers the third.
- Serving Cursor at all requires either **(i)** authenticating to Cursor's server API with the
  credential above — which breaks the brief's *no server, no login, nothing sensitive* posture — or
  **(ii)** reporting Cursor in a different unit than dollars (AI-authored lines / requests), which
  breaks the single-number daily-allowance headline that is the product's wedge.
- **Measured while answering this (2026-08-25), and it upgrades `SPIKE_RESULT.md` §5's "ccusage D3
  PARTIAL":** `ccusage@20 daily --json --offline --by-agent` returns, per day, an `agents[]` array
  whose elements carry `agent` plus `modelBreakdowns[].cost`. Over 26 days on this machine the
  split is populated for **both** tools — `claude` on 23 days, `codex` on 3 (2026-07-11/12/13,
  $35.30 / $7.05 / $3.42) — and `sum(agents[].cost)` reconciles to `row.totalCost` to **7.1e-15**.
  So the per-tool field is real and populated for each tool in the narrowed scope; the only case
  still unobserved is a **single day containing two agents**, which is now a synthetic-fixture case
  for `P1-3`, not a live unknown. Treat ccusage D3 as proven in structure, unproven in same-day mix.
- Therefore the honest v1 claim is **"every tool that writes local usage data"**, with `lum doctor`
  naming Cursor explicitly as *detected but unpriceable — Cursor exposes no local spend data*.
  Stating the reason is worth more than silently omitting the tool.

---

## PRE-B — demand and scope, answered from the public record (2026-08-25)

**The premise moved.** The question was framed against budi, but ccusage is now the primary
collector — and ccusage's own issue record already answers both halves of `PRE-B` better than a new
post could.

**Demand: real, but thin, and not for this framing.**

- **ccusage#259** *"Real-Time Usage Alerts for Claude Models"* (2025-07-05) asks for precisely this
  product: *"configurable alerts (e.g. when reaching 80% of usage limits)"*, because *"unexpectedly
  high usage … often leads to exhausting the usage limit without warning."* **One thumbs-up, no
  discussion.**
- **ccusage#822** *"Add BurnRate to ccusage ecosystem"* (2026-01-24) asks for a burn-rate menu-bar GUI.
- **ccusage#1445** (2026-07-13) announces `claude-eats-tokens`, a companion PWA that **already pushes
  phone notifications at 25/50/75/90/95%** of the 5-hour window. The alerting layer for the
  Claude-only slice is shipped, by someone else, and it is explicitly positioned as a companion
  rather than a competitor to ccusage.
- **No issue anywhere asks for one daily dollar allowance spanning several tools.** The specific
  wedge is unclaimed — and also unrequested.
- **budi** still has no budget/alert issue at all, which was the original `PRE-B` observation.

**Scope: ccusage has explicitly declined this layer.** #259 and #822 were both closed **NOT_PLANNED**
by the maintainer on 2026-05-17 — *"Closing during repository triage: this is not actionable or not
planned for the current ccusage scope."* So the policy layer is unclaimed **by decision**, not by
oversight. That is the strongest available evidence that a consumer of ccusage will not be made
redundant by ccusage.

**Why no new issue was filed.** `CONTRIBUTING.md` in ccusage states: *"Issues and PRs from new
contributors are auto-closed by default"*, and the FAQ adds that a reply is not guaranteed. This
account is a new contributor there, so a new issue would be auto-closed within seconds — meaning
**silence would be a policy artifact, not a demand signal.** The instrument `PRE-B` intended to use
does not measure the thing it was meant to measure. The existing record does.

**Consequence.** Demand for *alerting* is demonstrated three times over. Demand for *this framing* is
demonstrated by nobody. Per the human's own trigger stated on 2026-08-25 — *"If PRE-B comes back
silent and you can't confirm the multi-tool coverage … drop budi, use ccusage with zero install,
cover Claude and Codex well, and skip the 'every tool' claim"* — **both conditions have now fired**:
Cursor coverage is disproven above, and `PRE-B` came back thin. The smaller version is the indicated
scope, and the collector decision below matches it.

---

## PRE-D — rename · ANSWERED 2026-08-25: `local-usage-meter`

Repo and directory are **`local-usage-meter`**. `local-usage-meter` is free on npm; **`lum` is not**
(taken by a `1.0.0-readme.0` placeholder), so keeping `lum` as the package name would have forced a
scope later. The **bin stays `lum`** and the config dir stays `~/.localusagemeter/` — neither
collides with TokenTracker, per `IMPLEMENTATION_PLAN.md` `P1-0`.

Applied: `README.md` title, `package.json` `name`, directory name. `"private": true` and the absent
publish step from `P1-0` still stand, so **nothing is claimed on npm yet** — reserve the name if that
matters. The surviving `tokentracker` strings in `src/domain/types.ts` and `P4-2` refer to the *other*
project as a candidate third adapter, not to this repo's name, and were deliberately left alone.

---

## Collector decision (2026-08-25) — ccusage primary, budi second

Decided by the human after the Cursor finding above. **`ccusage@20` becomes the primary adapter;
`budi.cli.ts` is kept as the second real adapter.** Rationale, in the order it actually decided the
question:

1. **Both collectors deliver the same two tools**, so coverage is not a differentiator under the
   narrowed scope — and neither can deliver Cursor at all.
2. **`PRE-G`'s answer favours ccusage structurally.** ccusage takes `-z <IANA>` natively (it matched
   budi's local axis to $0.0018 in `SPIKE_RESULT.md` §4); budi's HTTP surface cannot express a local
   day, so a local axis there means shelling out to its CLI.
3. **budi's cost is real:** 10.7 MiB, ad-hoc-signed unnotarised binary, background daemon, a
   mandatory `budi db import`, and Risk **R2** (25 stars, no push since 2026-05-26). ccusage needs
   nothing installed (`npx -y ccusage@20`), which removes `PRE-E` rather than accepting it.
4. **budi is demoted, not deleted.** `P1-3` exists to make collectors swappable, and `P1-5` was
   pulled forward precisely so the suite never runs against one real adapter plus a fake. Keeping
   `budi.cli.ts` preserves that and stays the fast path for anyone who already has budi.

**Costs of the decision, stated plainly:**

- **Latency:** ccusage is ~1.1–3.4 s per call against budi HTTP's 1.7 ms. Acceptable for `lum today`,
  impossible on the statusline. So `P1-6`'s snapshot store and "the statusline reads a cache" stop
  being optimizations and become load-bearing, which **promotes `PRE-F` to the next real blocker**:
  if nothing refreshes that cache, the meter is silently stale, and a stale budget guardrail is worse
  than none.
- **Pacing:** `/analytics/statusline` was going to hand `P2` pacing for free. On ccusage that has to
  be computed from the daily rows, so the `P2` re-scope noted in `SPIKE_RESULT.md` §10.5 is reversed.
- **`P1-4` changes file, not shape:** the primary adapter becomes `ccusage.cli.ts` rather than
  `budi.http.ts`, exactly as `IMPLEMENTATION_PLAN.md` §3's structural rule promised.

---

## PRE-G — timezone axis · ANSWERED 2026-08-25: local

> **The user's local wall clock defines "today": every day label, budget window and threshold is
> computed in the user's IANA timezone with `resetHourLocal`, and UTC is never inherited from a
> collector's API — it exists only as an explicitly requested, explicitly labelled axis.**

_Answered by the human in session on 2026-08-25 and written down here by the assistant. This is a
human answer recorded by an agent, not an agent-closed gate — `SPEC.md` §7 still holds for every
row above that still says OPEN._

What the sentence forces (consequences, not further decisions):

- **The axis belongs to the port, not to an adapter.** The window passed to
  `UsageSourcePort.spendFor` must carry the IANA tz and `resetHourLocal`, and each adapter must
  declare the axis it can actually honour. Per `SPIKE_RESULT.md` §4 the contract suite can assert
  cross-adapter equality *only* if it pins the axis — so this lands in **`P1-3`**, before the first
  real adapter exists, not in `P1-4`.
- **budi's HTTP surface cannot answer a local day.** `since`/`until` are date-shaped and bucket by
  UTC (§4, Trap 1); re-summing `/analytics/sessions` into local days is option (c), rejected as
  day-bucketing arithmetic under ADR-v2-001. The local day total therefore comes from option
  **(b)** — `budi stats --timezone <IANA> --since/--until`, ~10–30 ms, measured affordable (§6).
- **Cost of the answer, stated plainly:** this makes `budi.cli.ts` (`P1-5`) the primary *day-total*
  path and demotes `budi.http.ts` (`P1-4`) to the UTC / hot-path role, which is a reversal of
  `P0-4`'s "primary = `budi.http.ts`". It changes which adapter is primary; it changes nothing
  structural, which is the point of `IMPLEMENTATION_PLAN.md` §3.
- **`/analytics/statusline` remains usable only where the axis is disclosed** (P3's hot path at
  1.8–16 ms), until an upstream timezone parameter exists. Asked upstream — see `PRE-B` row.
- **`P2` thresholds need no separate decision**: they inherit the local axis once the port carries
  tz, which is what made this a blocker in the first place.

---

> **PRE-F and OPEN-F were raised by the architect and PO agents on 2026-08-24 and verified.** Both
> are defects in the v2 architecture, not in the agents' reading of it. Recording them *here* —
> not only in the artifact that raised them — is deliberate: this file is the register, and a gate
> that lives only in the document that noticed it is a gate nobody will see. That is precisely how
> this board lost track of ARCH_QUESTION 2.

---

## v1 questions — mostly obsolete

ARCH_QUESTION 2 (Codex sample log) and PRE-10 (ccusage constraint inversion) are **moot under v2**:
we parse nothing, so neither the Codex log semantics nor the ccusage reuse question binds us.
ARCH_QUESTION 4 (daemon self-spawn without consent) is **NOT resolved.** An earlier revision of
this file claimed it was "resolved by deletion — v2 has no daemon." That was wrong, and it is the
same error this board's record already contains once: declaring a gate closed when it had only
been moved. Deleting the daemon **relocated** the consent question to the statusline, where it
returns verbatim as **PRE-F** above. Someone still has to decide whether a process may appear on a
user's machine unasked.
ARCH_QUESTIONs 1 and 3 (accountMode, threshold wording) still stand as written.

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
