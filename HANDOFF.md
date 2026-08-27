# HANDOFF — local-usage-meter (`lum`)

**State as of 2026-08-27.** `main` @ `dbda28a`. 483 tests passing, 10 skipped, CI green on macOS,
Linux and Windows. Everything is merged; there are no open PRs and no unmerged branches.

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

Six commands: `today`, `doctor`, `refresh`, `install [--write] [--guard]`, `--version`, `--help`.

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
  install.ts         the settings.json block

src/bin/
  lum.ts             CLI + the single composition root shared by today/refresh
  statusline.js      HOT PATH. node:fs/os/path/url only. Always exit 0
  guard.js           HOT PATH. PreToolUse enforcement. Fails OPEN on every fault
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
   forbidden in `src/`. `~/.claude/settings.json` is the one narrow exception, for the installer.

---

## 5. Multi-tool status — read this before claiming coverage

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| `lum today` / `doctor` / notifications | ✅ | ✅ **verified on real data** | ❌ |
| statusline | ✅ | ❌ | ❌ |
| guard (enforcement) | ✅ | ❌ | ❌ |

- **Codex works** for the numbers. Verified 2026-08-27 on a real mixed day: `claude-code $180.60`
  and `codex $1.37`, split from `modelBreakdowns[].modelName`. One spawn — `ccusage daily` already
  includes Codex, so spawning `ccusage codex daily` as well would **double-count**.
- **Codex has no statusline and no guard** because both are Claude Code hook mechanisms. Whether
  Codex has any equivalent is `P5-1`, unresearched.
- **Cursor exposes no local spend data at all** — schema-level, not empty-on-this-machine. It can
  never be priced from disk. `P5-3` makes `doctor` say so out loud instead of silently omitting it.

---

## 6. Open decisions — these need a human, not an agent

| Gate | Question | Current default | Reversibility |
|---|---|---|---|
| **PRE-B** | Is there demand? | unanswered — **blocks release** | — |
| **PRE-D** | What is it called? | `local-usage-meter` locally; the GitHub repo is still `token-tracker` | rename is a settings change only the owner can make |
| **OPEN-F** | Thresholds on USD or rate-limit %? | `usd` | **high** — `budget.ts` takes a `Signal`, so it is a constant, not a rewrite |
| **ARCH-Q1** | `accountMode` default | recommend `"auto"` over `"subscription"` | high |
| **ARCH-Q3** | Threshold wording | three wordings shipped (usd+api, usd+subscription, rate-limit) | high |

Two facts about the guard are **unconfirmed** and are `P5-4` / `P5-5`:
does `deny` survive `--dangerously-skip-permissions`, and what is the exact `permissionDecision`
enum? `guard.js` emits `deny` and fails open if that is wrong — the safe direction — but shipping
against a guessed enum is not.

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

- **`p5-multi-tool-parity`** (new, 2026-08-27) — `P5-1` … `P5-5`. Start with `P5-1`; `P5-2` depends
  on it. `P5-3`, `P5-4`, `P5-5` are independent and can go in any order.
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
