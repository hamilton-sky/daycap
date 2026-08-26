# P3 build notes — the statusline, and the answer to PRE-F

**Merged 2026-08-26**, PR #4 (`8c4239d`). 418 tests passing, 10 skipped.

The last surface. `statusline.js` implements DESIGN §1, §5 and §7 in full; `lum install` writes the
hook that keeps it from going stale.

---

## What shipped

| Task | Where | Status |
|---|---|---|
| `P3-1` thin reader, always exit 0, consumes stdin | `src/bin/statusline.js` | done |
| `P3-2` stdin parsing + rate-limit echo file | same | done |
| `P3-3` render, §1/§5/§7 forms, 256→16→none | same | done |
| `P3-4` latency budget, three layers | `test/gates/statusline-latency.test.ts` | done |
| `P3-5` + `P3-6` installer and refresh trigger | `src/app/install.ts`, `lum install` | done |

`P3-5` was absorbed into `P3-6`: one installer writes both the `statusLine` and the `hooks` block,
because asking a user to run two install commands to get one working feature is how a feature ends
up half-installed.

---

## Why the renderer lives inside statusline.js

The plan put it in `adapters/render/statusline.ts`. It is in `src/bin/statusline.js` instead —
because of a constraint I imposed in P1-9: the import gate limits that file to `node:fs`,
`node:os`, `node:path` and `node:url`.

That gate is right. The file runs on **every prompt render**, and a thin cache reader that grew a
dependency graph would have stopped being one. Plain JS, unbundled, no transpile on the hot path.

---

## The rendering decisions that carry weight

### An absent rate-limit window is dropped, separator and all

`5h 23% · 7d —%` invents a number where there is none. Each window is independently optional;
when one is missing, its segment *and* the ` · ` go.

### The higher window drives the shared bar

The 5-hour and 7-day limits are **independent caps** — crossing either one blocks you. Picking a
fixed window would hide the other's red state behind a green bar exactly when it matters most.
Each window still keeps its own colour, so the pair stays self-describing.

### States 2 and 3 are different renders, not one "stale" bucket

A collector a few seconds behind (state 2) is still trustworthy — the number is old by seconds,
not wrong. A collector that has **gone away** (state 3) gives a number of unknown age. Showing
both with the same soft `⋯` would overstate confidence in the second, so state 3 mutes harder and
adds the literal words `(source down)` — **text, not just colour weight, because the difference
must survive `NO_COLOR`.**

States 2 and 3 mute the *entire* numeric field, not just the suffix: colouring a value we are
unsure of with a threshold colour overstates it. The marker is appended **outside** the colour
reset so it never inherits the threshold colour.

### Unknown still never renders as `$0.00`

Now across five unknown-shaped states. A collector-**confirmed** zero still renders in full
threshold green with no marker — those are different facts and the tests keep them apart.

---

## PRE-F, answered — and ARCH_QUESTION 4, dissolved

`lum install` writes a `Stop` hook into the user's **own** `settings.json`.

That block *is* explicit consent. It needs no resident process. It fires exactly when spend
changes. So it does not *answer* ARCH_QUESTION 4 ("may a background process appear unasked?") — it
**dissolves** it, because there is no longer any benefit to buy with that consent cost.

**`Stop` and `SessionStart` only. Never `PostToolUse`** — it fires many times per turn, and a
collector spawn per tool call is ccusage issue #455 (statusline spawns accumulating until OOM)
reproduced inside our own tool.

The merge never rewrites a key it does not own, keeps the user's own hooks in the same event,
is idempotent, and backs up before writing. Verified against a real settings file carrying an
unrelated `Stop` hook: ours was appended, theirs untouched.

---

## The gate caught my own installer, and that was the point

`lum install` writes `~/.claude/settings.json`. The P1-9 import gate failed the build on it.

That was the **right** outcome. *"Never touch `.claude`"* was the wrong rule, stated too broadly:

- Reading `~/.claude/projects` **is** parsing. Forbidden, permanently. That is ADR-v2-001.
- Writing `~/.claude/settings.json` on an explicit `--write` is the installer doing its job.

The gate now forbids the **data** and allows that one **config** path, with a test asserting the
allowance stays narrow — only `lum.ts` may name it, and never alongside a transcript directory.

Without the gate, that distinction would have been loosened quietly under deadline instead of
written down.

---

## Latency, as three layers

A single `< 30 ms` was always unmeetable: Node's own cold start is ~40 ms before a line of our code
runs. Asserting it would mean a permanently red build, or a threshold quietly raised until it
stopped meaning anything.

| Layer | Budget | What it measures |
|---|---|---|
| A | < 5 ms p95 | our render path, 200 renders in-process |
| B | < 30 ms p95 | marginal cost over a bare `node` boot — **the honest reading** |
| C | < 150 ms p95 | absolute wall clock, interpreter included |

**Layer B is the one that catches a regression:** it subtracts the interpreter, so the number is
about our code rather than the machine CI happens to run on.

The first version of this gate **timed out at vitest's 5 s default on macOS and Windows** — it was
measuring correctly, but spawning 2×60 processes takes longer than the budget the test itself had
been given. Ubuntu was fast enough to hide it. Now 30 samples with an explicit ceiling.

---

## Still open after P3

- `P4-4` — `lum doctor`, the last real feature.
- `P4-3` — source selection, once a second real adapter exists.
- `P4-6` — release readiness. **The only human-blocked task**: it needs `PRE-B` (demand) and
  `PRE-D` (the name).
- `OPEN-F` — the default is `usd`; the rate-limit branch is built and waiting on a constant.
- `ARCH-Q1` / `ARCH-Q3` — ratified agent-to-agent, still unacknowledged by a human.
