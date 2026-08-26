# User Stories — LocalUsageMeter

_Stage: PLAN · Rigor: standard · Date: 2026-08-24_
_Authority: [`ARCHITECTURE_PROPOSAL.md`](ARCHITECTURE_PROPOSAL.md) **v2** · [`PO_NOTES.md`](PO_NOTES.md) · [`../../../local-usage-meter-BRIEF.md`](../../../local-usage-meter-BRIEF.md) (scope-changed) · [`RESEARCH.md`](RESEARCH.md) §5_
_Supersedes: the six seed stories in the brief §"User stories", which were written for the v1 collector._

> **This is the budget layer, not a collector.** Usage arrives already normalised, deduped and
> priced through `UsageSourcePort` from budi / Token Tracker / ccusage (ADR-v2-001). No story here
> may be satisfied by parsing a log file. If a story reads like "count tokens correctly", it is a
> **collector-selection criterion**, not our acceptance test — see §Non-stories.

---

## The persona

**Mira — multi-tool developer, and not the author of this tool.**
In a single working day she runs Claude Code (Max subscription), Codex CLI (API key), and Cursor.
Three consoles, three plans, three limits, and no single number anywhere. She does not want a
usage report at the end of the month; she wants to know at 11:00 whether she is going to run out
before 18:00. Her Claude quota is measured in rate-limit percentage, her Codex quota in dollars,
and she has to hold both in her head today.

_Secondary, deferred entirely: engineering manager wanting a team rollup. See §Non-stories._

**Vocabulary used below**
- **usage-day** — the window from `resetHourLocal` to `resetHourLocal` in the local timezone. Not necessarily midnight.
- **allowance** — `dailyBudgetUsd`. Advisory. The tool never blocks.
- **collector** — the third-party process that already tails transcripts (budi, Token Tracker, ccusage).
- **imputed** — a USD figure on a subscription account: money that does not actually change hands. Always rendered `≈`.

---

## Priority summary

| ID | Story | MoSCoW | Phase | Contingent on |
|---|---|---|---|---|
| US-01 | One total across every tool vs my allowance | **Must** | P1 | PRE-A, PRE-C |
| US-02 | Warned *before* the allowance is gone, once per threshold per day | **Must** | P2 | OPEN-F |
| US-03 | Rate-limit % is the headline on a subscription | **Must** | P3 | — |
| US-04 | Pacing — spend against elapsed day | **Should** | P2 | — |
| US-05 | Per-tool breakdown — which tool is eating the budget | **Must** | P1 | PRE-A, PRE-C |
| US-06 | Honest readout when there is no collector | **Must** | P1 / P3 / P4 | PRE-E |
| US-07 | Fully offline; nothing leaves the machine | **Must** | P1 (test-enforced across all) | — |
| US-08 | Scope the allowance to a subset of tools | **Should** | P2 | PRE-A |
| US-09 | The statusline never hangs or breaks my terminal | **Must** | P3 | — |
| US-10 | Swap collectors; a zero-install path exists | **Should** | P4 | PRE-E |
| US-11 | `lum doctor` tells me what to install and why | **Should** | P4 | PRE-E |
| US-12 | The daily view survives a rename of the tool | **Could** | P4 | PRE-D |

---

## US-01 — One total across every tool, against one allowance

> **Must** · Phase **P1** · **ASSUMES PRE-A resolves to {Claude Code, Codex, Cursor}** and
> **ASSUMES PRE-C confirms `/analytics/*` returns day-shaped, per-tool spend.**

**As** a developer running several AI coding tools in one day,
**I want** a single number for everything I have spent today against one configurable allowance,
**so that** I do not have to open three consoles and add them up myself.

**Given** a collector is running and reporting usage for Claude Code, Codex and Cursor,
**and** `dailyBudgetUsd` is `10.00` and `resetHourLocal` is `0`,
**when** I run `lum today`,
**then** the output shows one total that is the arithmetic sum of the per-tool figures the
collector reported for the current usage-day, rendered `today $3.20 / $10.00 (32%) ▓▓░░░`.

**Acceptance criteria**
- The total equals the sum of `ToolSpend[].usd` for the window — we perform no token arithmetic of our own (ADR-v2-001, Risk R6).
- Changing `dailyBudgetUsd` in config changes the denominator and the percentage on the next invocation, with no restart and no daemon (ADR-v2-002).
- `resetHourLocal: 4` makes a turn at 03:00 count against the *previous* usage-day; a turn at 05:00 counts against the current one. Covered by a `usageDayFor()` unit test with a fixed clock.
- The window is computed in the local timezone, and a DST transition day still yields exactly one usage-day boundary.
- A tool that reports zero for the day appears as `$0.00`, not omitted — absence and zero are different.

---

## US-02 — Warned before the allowance is gone, exactly once

> **Must** · Phase **P2** · **Contingent on OPEN-F** (see §Open decisions) — the AC below is
> written against the **USD fraction**, because that is the only signal `budget.ts` evaluates in
> ARCHITECTURE_PROPOSAL §2. Whether a threshold also fires on rate-limit percentage is **not
> decided here**.

**As** a developer,
**I want** a notification the first time I cross 80% and again the first time I cross 100%,
**so that** I can slow down while there is still allowance left, instead of finding out afterwards.

**Given** `thresholds: [0.8, 1.0]` and an allowance of `$10.00`,
**when** today's total first reaches `$8.00`,
**then** the display turns amber **and** exactly one OS notification fires, titled `AI Spend: Amber`,
body `$8.00 of $10.00 used (80% of daily budget)`.

**Given** the 80% notification has already fired today,
**when** spend dips to `$7.60` and rises again to `$8.40`,
**then** **no** second 80% notification fires.

**Given** the 80% notification has already fired today,
**when** the machine reboots, or `lum` is invoked fifty more times,
**then** **no** second 80% notification fires — the latch is a persisted file, not process state (ADR-v2-002).

**Given** the usage-day rolls over at `resetHourLocal`,
**when** spend crosses 80% again on the new day,
**then** the notification fires once more.

**Acceptance criteria**
- Latch key is `(usage-day, threshold)`. Persisted via atomic tmp+fsync+rename so a kill mid-write cannot corrupt it or lose a fired flag.
- A single jump from `$2.00` to `$12.00` fires **both** 0.8 and 1.0 in one evaluation, in ascending order, one notification each.
- Notification copy substitutes "usage allowance" for "budget" on subscription accounts (ARCH_QUESTION 3, decided A+C — **never human-acknowledged**, see §Open decisions).
- `notifications.enabled: false` suppresses the OS notification but still changes the colour and still sets the latch.
- Notifier failure (no `osascript`, no `notify-send`, headless) degrades to a terminal bell and never throws; `lum` still exits 0.
- The warning is **advisory**. Nothing is blocked, throttled or intercepted, at any threshold, ever.

---

## US-03 — On a subscription, the headline is my rate limit, not invented dollars

> **Must** · Phase **P3** · ADR-v2-003.

**As** a Claude Max subscriber,
**I want** my 5-hour and 7-day rate-limit percentages as the primary figure,
**so that** I am looking at the constraint that actually binds me, instead of a dollar amount I
will never be charged.

**Given** Claude Code pipes a statusLine payload containing `rate_limits.five_hour.used_percentage`
and `rate_limits.seven_day.used_percentage`,
**and** `primarySignal` is `"auto"`,
**when** the statusline renders,
**then** it shows `5h 23% · 7d 41% ▓▓░░░  ≈$3.20 today` — percentages first, dollars secondary and
prefixed `≈`.

**Given** the payload carries `rate_limits` with only `five_hour` present,
**when** the statusline renders,
**then** the 5h figure shows and the 7d segment is omitted — each window is independently optional.

**Given** the payload carries no `rate_limits` key at all (API-key account, or the field regressed
as it did in Claude Code v2.1.96, issue #45133),
**when** the statusline renders,
**then** it silently falls back to the USD form `today $3.20 / $10.00 (32%)`. No error, no warning,
no empty segment, exit 0.

**Acceptance criteria**
- `primarySignal: "auto"` → rate-limit when `rate_limits` is present, USD otherwise. `"usd"` and `"rate-limit"` force the choice; forcing `"rate-limit"` with no `rate_limits` available degrades to USD rather than rendering blank.
- Every imputed dollar figure carries the `≈` prefix, in both statusline and `lum today`. An API-key figure never does.
- Malformed stdin — truncated JSON, empty string, non-JSON bytes, 1 MB of garbage — produces the USD fallback line and exit 0. Fixture-driven.
- A Cursor/Copilot-only user, who has no Claude Code statusline at all, is unaffected: USD path throughout.

---

## US-04 — Pacing: am I ahead of the day?

> **Should** · Phase **P2**.

**As** a developer,
**I want** to know whether my spend is ahead of or behind the elapsed part of the usage-day,
**so that** `$4 of $10 at 11:00` reads differently from `$4 of $10 at 18:00` — which is the whole
point of a budget tool rather than a spend tracker.

**Given** `pacing: true`, an allowance of `$10.00`, a usage-day starting at 00:00,
**and** the current time is 12:00 (50% elapsed) with `$6.40` spent (64%),
**when** the display renders,
**then** it shows `today $6.40 / $10.00 (64%) ▓▓▓░░ ↑ ahead of pace`.

**Given** the same allowance at 18:00 (75% elapsed) with `$6.40` spent (64%),
**when** the display renders,
**then** no pacing marker appears, or a "behind pace" marker — the user is on track.

**Acceptance criteria**
- Pacing is `spendFraction` vs `elapsedFraction` of the usage-day, computed in `domain/pacing.ts` against an injected `ClockPort` — pure, no `Date.now()` inside the domain.
- A deadband prevents flapping: the marker does not toggle on every tick when the two fractions are within a small epsilon of each other.
- Early in the usage-day (first few minutes) the marker is suppressed — one turn at 00:03 is not "1400% ahead of pace".
- `pacing: false` removes the marker entirely and changes nothing else about the line.
- Pacing is advisory and never triggers a notification. Thresholds notify; pacing informs.

---

## US-05 — Which tool is eating the budget

> **Must** · Phase **P1** · **ASSUMES PRE-A resolves to {Claude Code, Codex, Cursor}** and
> **ASSUMES PRE-C confirms per-tool granularity is available from the collector.**

**As** a developer over budget at 14:00,
**I want** the total broken down by tool,
**so that** I can decide what to stop doing — a total with no attribution tells me I have a problem
but not what to do about it.

**Given** the collector reports Claude Code `$2.80`, Cursor `$1.90` and Codex `$0.40` today,
**when** I run `lum today`,
**then** each tool is listed with its USD, its share of the total, and its imputed flag, sorted
descending by spend, above the total row.

**Acceptance criteria**
- Rows sum to the headline total from US-01; a rounding test asserts the displayed rows and the displayed total agree to the cent.
- A tool on a subscription shows `≈` on its own row even when other rows are exact — the flag is per `ToolSpend`, not per report.
- Tool identifiers come from the collector unchanged. We do not maintain a display-name mapping, and an unrecognised tool id renders as-is rather than being dropped.
- Per-tool detail is a `lum today` / TUI concern. The statusline stays a single line and does **not** grow a breakdown.

---

## US-06 — Tell me the truth when there is no collector

> **Must** · Phases **P1** (degraded path), **P3** (statusline), **P4** (`doctor`) ·
> **Contingent on PRE-E** — whether requiring a collector install at all is acceptable is a human call.

**As** a developer who has not installed a collector yet, or whose collector daemon just died,
**I want** the tool to say so plainly,
**so that** I never make a spending decision on a number that is stale or invented.

**Given** no collector is installed or reachable,
**when** the statusline renders,
**then** it prints exactly `lum — (no source)` and exits 0. It does **not** print a number.

**Given** the collector daemon was running and is stopped mid-day,
**when** I run `lum today`,
**then** the output states which sources were probed (`budi` HTTP, `budi` CLI, `ccusage`,
`tokentracker`) and that none answered, and exits with a non-zero code **only** from `lum today` —
never from `statusline.js`.

**Acceptance criteria**
- No-source is a first-class rendered state, not an exception path or a crash (ARCHITECTURE §3).
- Connection refused, connection hang, HTTP 500, and a 200 with an unparseable body all resolve to the same honest degraded state within the latency budget — a hung socket must time out, not stall the line.
- No fabricated, extrapolated or last-known-good figure is ever presented as current.
- Freshness is exposed: `freshness().lastUpdatedUtc` is surfaced in `lum today` so the user can see how old the collector's own data is.
- **Design gap flagged, not resolved:** the case *collector is healthy but our cache file is old because `lum` has not been invoked recently* is specified nowhere. `ARCHITECTURE_PROPOSAL.md` §3 says render `(no source)`; `DESIGN.md` §"Format templates" still carries the v1 `⋯` last-known-value marker. See §Contradictions.

---

## US-07 — Fully local, fully offline, nothing leaves the machine

> **Must** · Phase **P1**, enforced by test across every phase · ADR-v2-004.

**As** a developer working under a policy that forbids sending code telemetry anywhere,
**I want** a guarantee that this tool has no account, no backend and no outbound traffic,
**so that** I can install it without asking anyone.

**Given** the machine has no internet connection,
**when** I run `lum today` with a local collector running,
**then** today's figure computes and renders normally.

**Given** the tool is running at all,
**when** its network activity is inspected,
**then** the only socket it ever opens is to `127.0.0.1` (the collector), and only from `lum` —
never from `statusline.js` (ARCHITECTURE §6).

**Acceptance criteria**
- No login, no API key of ours, no account, no telemetry, no crash reporting, no update check.
- Test asserts no network primitive is reachable in the built bundle outside the single loopback adapter — a grep-the-bundle test, not a promise.
- Canary test: a fixture containing a unique string is processed end-to-end; the canary appears in **no** output, no cache file, no latch file, no log line. Carried over from v1 and now easier to satisfy, since we never read a transcript.
- We store no prompt or response content because we never receive any — `ToolSpend` has no content field, by type.
- **Note the tension:** `PO_NOTES.md` §Out of Scope reads "Any network call for the live number" is prohibited. v2's primary path is an HTTP call to `127.0.0.1:7878`. Loopback is not egress, and the privacy intent is intact, but the wording of the constraint is violated. See §Contradictions.

---

## US-08 — Scope the allowance to the tools I actually pay for

> **Should** · Phase **P2** · **ASSUMES PRE-A resolves to {Claude Code, Codex, Cursor}** — this
> story is meaningless if the tool list is fixed at two.

**As** a developer whose employer pays for Copilot but who pays for Codex personally,
**I want** to point the allowance at a subset of tools,
**so that** my personal budget is not distorted by spend that is not mine.

**Given** `tools: ["claude-code","codex"]`,
**when** the collector also reports Cursor and Copilot spend,
**then** the headline total, the percentage and the thresholds all consider **only** Claude Code and
Codex; excluded tools are omitted from the breakdown, and the fact that filtering is active is visible.

**Acceptance criteria**
- `tools: ["*"]` (default) includes everything the collector reports, including tools that did not exist when the config was written.
- A configured tool the collector never reports is not an error — it contributes `$0.00`.
- Filtering happens once, before evaluation, so pacing, thresholds and breakdown all agree on the same filtered set.

---

## US-09 — The statusline never hangs, never breaks, never nags

> **Must** · Phase **P3**.

**As** a developer,
**I want** the statusline script to be incapable of degrading my terminal,
**so that** a budget tool never becomes the reason my editor feels slow.

**Given** any state whatsoever — missing cache, corrupt cache, unreadable config, no stdin, garbage
stdin, no collector, full disk —
**when** Claude Code invokes `statusline.js`,
**then** it prints exactly one line to stdout and exits 0.

**Acceptance criteria**
- p95 latency < 30 ms; hard self-timeout at 150 ms, after which it prints the degraded line and exits 0.
- Imports `node:fs` only. It reads a cache file; it never calls the collector, never opens a socket, never spawns a process.
- stdin is consumed and discarded immediately (`process.stdin.resume(); process.stdin.destroy();`) before any output, so it cannot deadlock on a pipe that is never written (RESEARCH §3, item B3).
- Fault-injection suite: each of the states above is a test case asserting exit 0 and exactly one line.
- `NO_COLOR` and `--no-color` suppress all escape sequences; every state marker (`≈`, `(no source)`, the pacing arrow) carries meaning without colour.

---

## US-10 — I can change collectors, and there is a path with no extra install

> **Should** · Phase **P4** · **Contingent on PRE-E** (is doubled install friction acceptable) ·
> Mitigates Risk R1 and Risk R2.

**As** a developer who does not want to install a 13 MB Rust daemon just to see a budget,
**I want** the tool to work with whichever collector I already have — or with none beyond `npx`,
**so that** my choice of collector is not a lock-in and not a blocker.

**Given** `source: "auto"`,
**when** `lum` starts,
**then** it probes sources in a documented order, uses the first that answers `available() === true`,
and names the one it chose.

**Given** only ccusage is present,
**when** `lum today` runs,
**then** it reports Claude Code and Codex spend via the shell-out adapter, and states plainly that
Cursor and Copilot are not covered by this source — a partial total must never be presented as complete.

**Acceptance criteria**
- At least **two** working adapters before v1.0 (Risk R2 — budi is a solo project with zero external PRs).
- One shared contract test runs against every adapter; a new adapter is a new file plus a passing contract test, with no change in `app/` or `domain/` (ARCHITECTURE §3, "the single most important structural rule in v2").
- A breaking change in budi's unpublished `/analytics/*` shape is repairable inside `adapters/source/budi.http.ts` alone — asserted by an architecture test that fails if anything outside `adapters/` references a collector-specific type.
- `source: "budi"` pinned explicitly disables auto-probing and fails loudly rather than silently falling back to a different, differently-scoped source.

---

## US-11 — Tell me exactly what to install and why

> **Should** · Phase **P4** · **Contingent on PRE-E**.

**As** a developer for whom the tool just printed `(no source)`,
**I want** one command that explains what is missing and what to do,
**so that** the first-run experience is a fixable state rather than a dead end.

**Given** no collector is installed,
**when** I run `lum doctor`,
**then** it lists each source it looked for, where it looked, the result, and one concrete next
step per source, in ≤ 80 columns, plain text by default.

**Acceptance criteria**
- Names the actual probe: the HTTP endpoint tried, the binary looked for on `PATH`.
- Reports config validity (`dailyBudgetUsd`, `resetHourLocal`, `thresholds`, `tools`, `primarySignal`) and flags unknown keys instead of ignoring them.
- Reports whether `rate_limits` has ever been observed on stdin, so a subscriber understands which signal they are on.
- Contains **no** v1 relics: no daemon pid row, no "session files indexed" row, no Codex `provisional` row. `DESIGN.md` §4's sample output is stale — see §Contradictions.
- Reports adapter health and the freshness timestamp of the chosen source (Risk R3).

---

## US-12 — The install name is not someone else's project

> **Could** · Phase **P4** · **PRE-D ANSWERED 2026-08-25 — the name is `local-usage-meter`.**
> Chosen by the human; recorded in `feedback/HUMAN_QUESTIONS.md`. This story is unblocked.

**As** a developer searching for this tool,
**I want** its name not to collide with the established Token Tracker OSS project,
**so that** I install the thing I meant to install.

**Acceptance criteria (whatever the chosen name turns out to be)**
- Binary name, config directory, package name and repository name agree.
- A migration path exists for anyone who installed under the old name, or an explicit decision is recorded that none is needed because there are no users yet.
- ~~Blocked until PRE-D is answered by a human.~~ **Answered 2026-08-25.** Status of the two criteria
  above:
  - **Names agree on the product, not literally.** Repo `local-usage-meter`, package
    `local-usage-meter`, bin **`lum`** (abbreviation), config dir **`~/.localusagemeter/`**
    (unhyphenated). That was already `P1-0`'s assumption and neither collides with Token Tracker, but
    if this AC means *string-identical*, it is not met and never was — decide whether to relax the
    wording or unify the two odd ones.
  - **No migration path is needed, and this is that explicit decision:** the repo was two commits old
    at rename time, nothing was ever published to npm (`"private": true`, no publish step), and there
    are no users. `local-usage-meter` is unclaimed on npm; **`lum` is taken** by a `1.0.0-readme.0`
    placeholder, so a future publish needs either this name or a scope.

---

## Non-stories — explicitly not built

| Item | Why |
|---|---|
| **Hard-blocking over budget** | Advisory only. We observe a collector; we are not in the request path and could not block if we wanted to. |
| **Central multi-user aggregation / eng-manager rollup** | No server, no backend, no shared database. Deferred entirely. |
| **Any log parsing, dedup, price table, tail, or reconciler** | ADR-v2-001. This is the collector's job for 5–34 tools. |
| **A resident daemon of our own** | ADR-v2-002. The latch is a file. A second daemon beside the collector's brings a lockfile, liveness detection, self-spawn-without-consent and `service install` — and ARCH_QUESTION 4 (self-spawn without consent) was never answered by anyone. Deleting the daemon deletes the question. |
| **Billing-exact accuracy** | We display the collector's totals and do no arithmetic on tokens. Divergence from the provider console is the collector's to fix (Risk R6). |
| **"A tool-heavy session's tokens equal the log `usage` fields"** and **"Codex sessions are priced from their token fields"** | Brief acceptance tests 2 and 3, and `PO_NOTES.md` success signals 2 and 3. Under v2 these are **collector-selection criteria**, not our acceptance tests — we cannot pass or fail them. Use `fixtures/claude-session-scrubbed.jsonl` (2.41× inflation without dedup; cache read = 97.4% of tokens) to vet a collector before adopting it. |

---

## Phase map — ARCHITECTURE_PROPOSAL.md §7

| Phase | Delivers | Stories |
|---|---|---|
| **P0 — Spike** | Real per-tool day-shaped numbers from `127.0.0.1:7878/analytics/*` | **No user story.** A go/no-go gate (PRE-C) on US-01 and US-05. If it fails, P1 shifts to `budi stats --format json` and US-01's AC is unchanged. |
| **P1 — Core** | `domain/*`, `budi.http.ts`, `lum today` | US-01, US-05, US-06 (degraded path), US-07 |
| **P2 — Budget** | `budget.ts`, `pacing.ts`, `latch.ts`, notifier | US-02, US-04, US-08 |
| **P3 — Statusline** | `statusline.js`, stdin parsing, rate-limit primary | US-03, US-06 (statusline rendering), US-09 |
| **P4 — Portability** | `ccusage.shellout.ts`, `tokentracker.ts`, `lum doctor` | US-06 (`doctor`), US-10, US-11, US-12 |

---

## Open decisions — human-owned, not resolved here

**None of the items below has been decided by this document. Every story that touches one is
written under a stated assumption, and the assumption is marked in the story itself.**

| # | Decision | Owner | Status | Stories that move if it changes |
|---|---|---|---|---|
| **PRE-A** | Exact tool list. Brief says Claude Code + Codex; the persona uses Cursor too. | Human | **OPEN** | **US-01, US-05, US-08.** All three are written **ASSUMING PRE-A resolves to {Claude Code, Codex, Cursor}**. If it resolves to the brief's two tools, US-08 becomes pointless, US-05 shrinks to two rows, and the zero-install ccusage path in US-10 becomes sufficient rather than a fallback — which would materially reduce PRE-E's weight. |
| **PRE-B** | Has anyone actually asked for this? No budget/alert issue has ever been filed on budi (Risk R4). | Human | **OPEN** | **All of them.** These stories describe a product whose demand is unvalidated. This is a gate on building, not on any individual story. |
| **PRE-C** | Does `/analytics/*` return day-shaped per-tool spend? | Builder (one `curl`) | **OPEN — do first** | **US-01, US-05.** If the API is session-shaped rather than day-shaped, the acceptance criteria stand but the adapter changes; if per-tool attribution is unavailable, **US-05 is not buildable on that source**. |
| **PRE-D** | Rename the project away from `token-tracker`. | Human | **ANSWERED 2026-08-25 — `local-usage-meter`** (bin `lum` unchanged); see `feedback/HUMAN_QUESTIONS.md`. | **US-12** is unblocked. |
| **PRE-E** | Is doubled install friction acceptable? The brief promised "setup is trivial"; v2 requires a 13 MB collector first (Risk R1). | Human | **OPEN** | **US-06, US-10, US-11.** All three exist to soften a cost that a human may decide is unacceptable. If PRE-E resolves to "no", the ccusage zero-install path in US-10 is promoted from **Should** to **Must** and the whole plan narrows toward Claude+Codex — which collides with PRE-A. |
| **OPEN-F** | **New, raised by this document.** ADR-v2-003 makes rate-limit percentage the primary signal on subscriptions, but `thresholds` are evaluated only against the USD fraction (§2). **Does a threshold fire when 7-day rate-limit usage crosses 80%?** For Mira on Max, the rate limit is the binding constraint — a budget tool that only alerts on imputed dollars will not alert her at all on the thing that actually stops her working. | Human | **OPEN** | **US-02**, whose AC is deliberately written against the USD fraction only. **Not decided here.** Should be added to `feedback/HUMAN_QUESTIONS.md`. |
| **ARCH-Q3** | Subscription threshold wording ("usage allowance" vs "budget"), decided A+C by the evaluator agent. **Never human-acknowledged.** | Human | **Decided agent-to-agent; unratified** | US-02 notification copy. Recorded, not re-decided. |

---

## Contradictions found between the source documents

Recorded, not resolved. Each needs an owner.

1. **`PO_NOTES.md` carries two mutually exclusive banners.** The 2026-08-24 v2 banner says the
   product now sits on an existing collector; the banner directly beneath it says "the design now
   parses JSONL itself and prices from a vendored LiteLLM table". The second is v1 and contradicts
   ADR-v2-001. `PO_NOTES.md` constraints **#1, #2 and #3** (ccusage reuse, four token classes priced
   separately, fixed log locations as ground truth) are all v1 collector constraints still stated as
   binding on us. Under v2 they are collector-selection criteria. **`PO_NOTES.md` needs a v2 pass.**

2. **Config key drift.** `ARCHITECTURE_PROPOSAL.md` §4 states "the brief's five original config keys
   all survive unchanged", but the brief and `PO_NOTES.md` #6 specify `clis` and
   `imputeCostForSubscription`, while §4 shows `tools` and `primarySignal`. Two of five keys were
   renamed or replaced. Either the claim or the schema is wrong; the schema is almost certainly the
   one to keep, and the claim should be corrected.

3. **"No network call for the live number" vs a loopback HTTP primary path.** `PO_NOTES.md`
   §Out of Scope prohibits network calls for the live number and mandates local log files. v2's
   primary source is `GET 127.0.0.1:7878`. The privacy intent survives; the literal constraint does
   not. Flagged in US-07.

4. **Stale-vs-no-source is specified two ways.** `ARCHITECTURE_PROPOSAL.md` §3 says render
   `lum — (no source)` "rather than a stale or invented number". `DESIGN.md` §"Format templates"
   still lists `stale > 60 s → last known value + ⋯` and `no daemon → (paused)`, and §"Design
   Principles" #1 explicitly argues *for* showing the last known value. `DESIGN.md`'s own banner
   says the architecture wins, but the body was never updated. **A third case is specified
   nowhere:** collector healthy, our cache old because `lum` has not run. Flagged in US-06.

5. **`DESIGN.md` §4 `lum doctor` sample output is v1.** It shows a daemon pid, "4 session files
   indexed", and a Codex `provisional` marker — three things that cannot exist in v2. Flagged in US-11.

6. **Brief promises "setup is trivial"** (seed story 4) while v2 requires installing a 13 MB Rust
   collector first (Risk R1). This is exactly PRE-E, and it is a promise to the user, not just an
   engineering cost.

7. **Acceptance signals 2 and 3 can no longer be met by us.** `PO_NOTES.md` §Definition of Success
   lists all five brief signals as "required for v1", but two of them test log-parsing behaviour we
   have deleted. Under v2 they must be restated as collector-conformance checks or dropped. Listed
   in §Non-stories.
