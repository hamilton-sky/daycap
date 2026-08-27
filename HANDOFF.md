# HANDOFF — local-usage-meter (`lum`)

**State as of 2026-08-27.** `main` @ `00d0dfb`. 532 tests passing, 10 skipped, CI green on macOS,
Linux and Windows. PRs #7-#10 are merged. Four `feat/*` branches survive on the remote and none of
them are live work: three are squash-merged, and `feat/p5-multi-tool-parity` forked before #9 and is
BEHIND main — it holds `.prompts/` and nothing else worth keeping.

Read this first, then `pathly/features/local-usage-meter/BUILD_PLAN_v3.md` for the design rationale.

---

## 1. What this is

A **local budget guardrail** for AI coding tools. It shells out to an existing usage collector
(`ccusage`), owns the budget/threshold/alerting policy, and warns — now also **blocks** — before
the daily allowance is gone.

It does **not** parse logs. `ADR-v2-001`: consume a collector, never read a transcript. That rule is
enforced by a CI gate, not by discipline.

**Positioning, corrected 2026-08-27:** the differentiator is **zero setup**, not uniqueness. LiteLLM
can do this too, with a proxy, a Postgres DB and re-pointed credentials. See
`COMPETITIVE_ANALYSIS.md` — read it before writing any marketing copy.

---

## 2. It works. Try it in 30 seconds

```bash
pnpm install && pnpm verify        # typecheck, lint, build, 483 tests
npm i -g ccusage@20                # the collector (if not already present)
node dist/lum.js today             # a real number from your own transcripts
node dist/lum.js doctor            # why the number is what it is
```

Six commands: `today`, `doctor`, `refresh`, `install [--write] [--guard] [--codex]`,
`--version`, `--help`.

---

## 3. Architecture, and why each piece is shaped that way

```
src/domain/          PURE. No fs, no net, no clock. Enforced by biome + test/gates/imports.
  types.ts           UsageWindow (half-open, carries tz), ToolSpend (usd is NULLABLE), Config
  window.ts          the usage-day boundary. 100% branch coverage, DST-verified
  budget.ts          evaluate(Signal, cfg) — takes a SIGNAL, not a USD number (see §6, OPEN-F)
  config.ts          parsing; never throws; honours v1 key aliases
  errors.ts          typed failure channels, so nothing matches on stack strings
  ports.ts           UsageSourcePort + granularity

src/adapters/
  source/ccusage.shellout.ts   ONE spawn. Per-tool split from modelBreakdowns[].modelName
  source/timeout.ts            withTimeout — rejects, never resolves []
  store/atomic.ts              tmp -> fsync -> rename, with a Windows retry
  render/table.ts              `lum today`
  render/doctor.ts             `lum doctor`
  notify/notifier.ts           argv arrays, shell:false, scrub() enforces ADR-v2-004

src/app/
  meter.ts           pull source -> snapshot. Integer cents. Degraded snapshots are NOT cached
  latch.ts           L1-L9. The correctness centrepiece
  alert.ts           L7: persist the latch, THEN notify
  install.ts         the settings.json block, and the Codex hooks.json block (P5-2)

src/bin/
  lum.ts             CLI + the single composition root shared by today/refresh
  statusline.js      HOT PATH. node:fs/os/path/url only. Always exit 0
  guard.js           HOT PATH. PreToolUse enforcement, Claude Code AND Codex. Fails OPEN
```

### The hot path is a hard constraint, not a preference

`statusline.js` and `guard.js` may import **only** `node:fs`, `node:os`, `node:path`, `node:url`,
and may spawn nothing. `test/gates/imports.test.ts` fails the build otherwise.

For `guard.js` this is a **safety** property, not a performance one: a timed-out hook does **not**
block ("you shouldn't count on a stalled hook to act as a gate"), so **a slow guard is an absent
guard**. Our collector read is ~90 ms warm and ~1 s cold — either would silently stop enforcing.

---

## 4. Invariants. Break these and the product is worse than nothing

1. **Unknown never renders as `$0.00`.** Not in `today`, the statusline, or `doctor`. A
   collector-*confirmed* zero may say zero; "we don't know" may not. `ToolSpend.usd` is nullable
   precisely so this stays expressible.
2. **The latch fires at most once per threshold per usage-day.** L1–L9 in `src/app/latch.ts`, all
   nine mutation-verified. A dip never re-arms; only a day change does.
3. **Only trusted data fires or blocks.** Stale / timed-out / source-down / unpriced → no
   notification, no latch advance, no denial. A missed alert costs money; a wrong one costs trust.
4. **Persist the latch, then notify** (L7). The reverse order re-alerts on every invocation forever.
5. **Every surface exits 0.** `statusline.js` and `lum today` always. Only `doctor` may exit 1, and
   only when *nothing* is usable.
6. **The guard fails open.** Every fault path allows. It is also off twice over: `--guard` at install
   *and* `guard.enabled` in config.
7. **Never parse a transcript.** `~/.claude/projects`, `.jsonl`, `.codex/sessions`, `.cursor` are
   forbidden in `src/`. `~/.claude/settings.json` and `~/.codex/hooks.json` are the two narrow
   exceptions, both for the installer, and only `src/bin/lum.ts` may name either directory. The
   distinction is CONFIG the user owns versus DATA a collector owns — not "which vendor".

---

## 5. Multi-tool status — read this before claiming coverage

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| `lum today` / `doctor` / notifications | ✅ | ✅ **verified on real data** | ❌ *named, never priced* |
| statusline | ✅ | ❌ **never** — see below | ❌ |
| guard (enforcement) | ✅ | ✅ *weaker guarantee* — see below | ❌ |

**The two guard ticks are not the same tick.** Claude Code documents that a hook deny applies even
in `bypassPermissions`; OpenAI explicitly declines to make that promise, calling hooks "a useful
guardrail, not a complete enforcement boundary". Do not flatten them into one claim in a README.

- **Codex works** for the numbers. Verified 2026-08-27 on a real mixed day: `claude-code $180.60`
  and `codex $1.37`, split from `modelBreakdowns[].modelName`. One spawn — `ccusage daily` already
  includes Codex, so spawning `ccusage codex daily` as well would **double-count**.
- **Codex has a guard as of `P5-2`.** `P5-1` found that Codex CLI has a `PreToolUse` hook whose deny
  payload is byte-identical to Claude Code's, so `src/bin/guard.js` serves both hosts with one
  `decide()` and no second binary. `lum install --codex [--guard]` writes `~/.codex/hooks.json`.
  Three things differ and are handled in code, each commented where it lives: `apply_patch` vs
  `Edit`/`Write` naming, a **600-second** default hook timeout (against Claude Code's 60), and a
  hook **trust** gate — Codex runs no non-managed hook until the user opens `/hooks` and trusts it,
  and it pins that trust to the hook's hash, so editing the file disarms it again.
- **Codex has no statusline, and cannot.** `tui.status_line` takes a closed list of Codex's own
  built-in item identifiers — there is no command contract and no stdin JSON, so no third party can
  render into that footer. This is schema-level, like Cursor's spend data: a ceiling, not a gap.
  `lum doctor` now says so on its `surfaces` row rather than leaving it to be discovered.
- **Cursor exposes no local spend data at all** — schema-level, not empty-on-this-machine. It can
  never be priced from disk. `P5-3` closed this: `doctor` now prints an `unpriced` row when Cursor
  is present rather than silently omitting it. Detection is existence-only, keyed on the tool NAME
  via `domain/surfaces.ts` so the literal `.cursor` still never appears in `src/` — and the import
  gate was narrowed in the same commit to stop that derivation becoming a way around it.

Everything above is sourced in `pathly/features/local-usage-meter/P5_RESEARCH.md`.

---

## 6. Open decisions — these need a human, not an agent

| Gate | Question | Current default | Reversibility |
|---|---|---|---|
| **PRE-B** | Is there demand? | unanswered — **blocks release** | — |
| **PRE-D** | What is it called? | `local-usage-meter` locally; the GitHub repo is still `token-tracker` | rename is a settings change only the owner can make |
| **OPEN-F** | Thresholds on USD or rate-limit %? | `usd` | **high** — `budget.ts` takes a `Signal`, so it is a constant, not a rewrite |
| **ARCH-Q1** | `accountMode` default | recommend `"auto"` over `"subscription"` | high |
| **ARCH-Q3** | Threshold wording | three wordings shipped (usd+api, usd+subscription, rate-limit) | high |

Both facts about the guard that were **unconfirmed** here are now closed by `P5-4` / `P5-5`,
and both came back in the guard's favour: `deny` **does** survive `--dangerously-skip-permissions`
(hooks are step 1 of the permission flow; bypass is applied at step 4), and the enum is exactly
`allow` / `deny` / `ask` / `defer`. `guard.js` was already emitting the right shape, so nothing
changed. What the README must NOT say is "cannot be bypassed" — `disableAllHooks`, `--bare` and
removing the hook all still turn it off. See `P5_RESEARCH.md`.

---

## 7. What's left, and how to pick it up

The pathly board is the source of truth. **`BOARD.json` is a mirror — do not edit it.** The real
store is SQLite at `~/.pathly/pathly.db`, served by `pathly-fsm-http` on `127.0.0.1:8765`.

```bash
curl -s "http://127.0.0.1:8765/comms/tasks?feature=lum-budget-layer" | python3 -m json.tool | head -40
```

Useful endpoints (all `POST`, JSON body):

| Endpoint | Use |
|---|---|
| `/comms/tasks?feature=<f>` (GET) | list tasks with `task_status` and `depends_on` |
| `/comms/tasks/status` | `{task_ids[], status: done\|failed, reason, actor}` |
| `/comms/post` | create a task: `{feature, from, type, text, goal_id, depends_on[]}` |
| `/comms/attach` | attach a doc: `{message_id, artifact_path, artifact_type, title, summary}` |
| `/comms/delete` | retract: `{message_id, force}` |

**A task is buildable when `task_status == "pending"` and every id in `depends_on` is `done`.**
That is the drain order — no separate scheduler needed.

### Remaining goals

- **`p5-multi-tool-parity`** — **complete.** `P5-1` … `P5-5` all closed 2026-08-27. Nothing left
  in this goal; the next unblocked work is `P1-5` below.
- **`P1-5`** — a second real adapter (`jsonfile.ts`). Makes collector-swappability real rather than
  claimed; it is the escape hatch for any collector we have not adapted.
- **`P4-3`** — source selection (`source: auto|ccusage|jsonfile`). Depends on `P1-5`.
- **`P4-2`** — `tokentracker.ts`. **Cut** from v1 (BUILD_PLAN_v3 §6) but still `pending` on the board
  because `P4-3` depends on it; retract it *and* fix that edge together, or leave both.
- **`P4-6`** — release. **Human-blocked** on `PRE-B` and `PRE-D`.

---

## 8. Conventions that made this codebase work

- **Mutation-test anything load-bearing.** Break the rule deliberately; confirm the suite catches
  it. This found real holes four separate times — including two in the *tests*, not the code.
- **A skip needs a written reason.** `SourceHarness.skips` types it as a required string.
- **The gates are not bureaucracy.** The import gate caught the installer touching `.claude` and
  forced the data-vs-config distinction into the open. Do not loosen one without writing down why.
- **Comments explain *why*, especially when the code looks wrong.** The `-1 ms` in the ccusage
  window conversion, `withTimeout` rejecting instead of resolving `[]`, degraded snapshots not being
  cached — every one of those looks like a bug until you read the reason.
