# token-tracker

Planning-stage repo for **LocalUsageMeter** — a local, per-developer tool that reads Claude Code
and Codex CLI session logs in near-real-time and shows today's token usage and cost against a
configurable daily budget. No server, no proxy, no login, no network.

> **Status: designed, not built.** There is no `src/` yet. This repo currently holds a feature
> brief and the design artifacts produced by a [Pathly](https://github.com/hamilton-sky/pathly-adapters)
> agent pipeline run on 2026-08-10. All 14 planned tasks are still pending. See
> [Where this stands](#where-this-stands).

---

## Why

Provider consoles (Anthropic / OpenAI) aggregate usage server-side with 1–2 day latency, so you
can't see today's spend in time to stay inside a daily allowance. The local CLI session logs are
written per-turn and carry the provider-reported `usage` block — reading them gives an immediate,
reasonably accurate number.

The intended primary surface is one line in your Claude Code statusline:

```
today $3.20 / $10.00 (32%) ▓▓░░░          under 80%          (green)
today $8.40 / $10.00 (84%) ▓▓▓▓░          crossed 80%        (amber + notification)
today $11.90 / $10.00 (119%) ▓▓▓▓▓        over budget        (red + notification)
today ≈$3.20 / $10.00 (32%) ▓▓░░░         subscription — imputed at API list rates
today $3.20 / $10.00 (32%) ▓▓░░░ ⋯        snapshot >60s old, showing last known value
lum —                                      cold start, no data yet
```

Plus `lum --live` (full-screen breakdown by CLI and model), `lum today` (one-shot table), and
`lum doctor` (watch mode, snapshot age, pricing version, unknown models, parse errors, drift).

## Design in one diagram

One writer, many dumb readers. The daemon owns all parsing, pricing and state; every UI reads one
small atomic file. The statusline never touches a log.

```
  ~/.claude/projects/**/*.jsonl ──fs──┐
                                      ├─►  lum daemon  (single writer, pid-locked)
  ~/.codex/sessions/**          ──fs──┘    tail → normalize → dedupe → price
                                                   → fold → latch → snapshot
                                                          │
                                          atomic rename   ▼
                                    ~/.localusagemeter/state/today.json   (<2 KB)
                                                          │
                      ┌───────────────────────────────────┼──────────────────┐
                      ▼                                   ▼                  ▼
              bin/statusline.js                    lum --live TUI      notifier latch
              node:fs only, ~1ms read              redraw on change    once per threshold
              always exit 0                                            per usage-day
```

Node ≥ 20.11 (target 22 LTS), TypeScript, ESM-only. Four layers with strictly inward dependencies:
`domain/` (pure — no fs, no clock, no network, enforced by lint *and* a test that greps the build
output), `app/` (orchestration behind ports), `adapters/` (all I/O and third-party contact),
`bin/` (composition root).

### The two traps it's built around

These are what actually break tools in this category:

- **Double-counting.** Claude Code writes the same assistant message into several `.jsonl` files on
  resume/compact/branch. Without a dedup key on `message.id` + `requestId`, today's total inflates
  2–3×.
- **Cache-bucket direction.** Anthropic's `input_tokens` *excludes* cache reads; OpenAI's
  *includes* them. OpenAI's `output_tokens` *includes* reasoning tokens. Getting a sign wrong
  shifts cost by up to ~10× on the affected bucket. One normalization boundary, six stored fields,
  four priced classes (uncached 1×, cache write 1.25×/2×, cache read 0.1×, output).

## Repo layout

```
local-usage-meter-BRIEF.md              the human-written seed for the pipeline
pathly/features/local-usage-meter/
  PO_NOTES.md                           personas, success criteria, constraints, open questions
  ARCHITECTURE_PROPOSAL.md              the design — 10 sections, 9 ADRs, risks, prerequisites
  RESEARCH.md                           external findings (ccusage, chokidar, statusLine contract)
  DESIGN.md                             palette, statusline format, TUI layout, notification copy
  artifacts/BOARD_EVAL.md               execution-readiness review and phase ordering
  feedback/HUMAN_QUESTIONS.md           the five decisions that need a human, and their status
  BOARD.json / EVENTS.jsonl / STATE.json   Pathly board + event log for the run (generated)
```

Start with the brief, then `ARCHITECTURE_PROPOSAL.md` §0 (position statement) and §3 (data model).
`feedback/HUMAN_QUESTIONS.md` is the shortest path to understanding what is *not* settled.

## Where this stands

The pipeline ran PO → architecture → research → design → planning and stopped. It produced ~1,650
lines of markdown, four goals, fourteen tasks, and no code. `STATE.json` says `DONE`; that means
planning finished, not that anything shipped.

**Two gates are open and need a human, not an agent:**

| Gate | What it is | Why it matters |
|---|---|---|
| **PRE-1** | One real, scrubbed `~/.claude/projects/<proj>/<session>.jsonl` | Every accuracy claim in the design is inferred from documentation. Nobody has looked at a real log line. VERIFY-01/02 cannot be confirmed without it, so acceptance signals 2 and 3 are unverifiable. |
| **PRE-10** | Sign-off on the constraint-#1 inversion | The brief required reusing [ccusage](https://github.com/ryoppippi/ccusage) to parse both CLIs and to price. Research found ccusage ≥ v20 is a compiled Rust binary with no JS exports, so the design now parses and prices itself, using ccusage only as an optional drift check. Right call, forced by evidence — but decided by agents, not by the human who set the constraint. |

Two further decisions were made by agents over an unacknowledged human escalation: the Codex
sample-log gate (adopted "build to spec, mark provisional" after the evaluator had warned against
exactly that) and the daemon that self-spawns without explicit consent. Both are documented in
`feedback/HUMAN_QUESTIONS.md`. **Codex figures should not be trusted until `lum verify-codex` runs
against a real Codex log.**

## Planned phases

| Phase | Delivers | Exit criteria |
|---|---|---|
| **P1** | Domain types, JSONL readers, tail, pricing, `lum today` | Prints `today $X / $BUDGET (P%)`; dedup + Codex-cumulative + reasoning-subset tests green |
| **P2** | Watch, store, daemon, reconciler, snapshot | Appending a turn updates the snapshot in <1s; `kill -9` mid-write leaves a valid snapshot |
| **P3** | `bin/statusline.js`, liveness, `lum install-statusline` | <30ms p95; exit 0 on every injected fault; works end-to-end in real Claude Code |
| **P4** | Budget eval, threshold latch, notifier, colours | Crossing 0.8 then 1.0 fires exactly one notification each, no repeats across restart |
| **P5** | `lum --live`, `lum today` table, `lum doctor`, service install | Per-CLI and per-model figures reconcile exactly to the total |
| **P6** | *(stretch)* tray, daily reconciliation, rollup shipper | Out of v1 scope |

Critical path is P1 → P2 → P3. P4 and P5 both hang off P2 and can run in parallel once the
`Snapshot` shape is frozen at the P2/P3 boundary.

## Non-goals (v1)

- Hard-blocking when over budget — a passive log reader cannot intercept the CLI. Advisory only.
- Central multi-user aggregation — no server, no backend, no shared database.
- Any network call for the live number — local logs only.
- Billing-exact accuracy — "reasonable" is the bar; occasional log undercount is acceptable.

## Privacy

Nothing leaves the machine. Parsers whitelist fields rather than spreading parsed objects, so no
prompt or response content ever reaches a record. No network primitive (`fetch`, `node:http`,
`node:net`, `undici`) may appear in shipped source — enforced by a lint rule *and* a
build-artifact grep test, with a canary-string test asserting no fixture content appears in any
written file.

## License

Not yet chosen. ccusage, whose pricing table this design vendors, is MIT.
