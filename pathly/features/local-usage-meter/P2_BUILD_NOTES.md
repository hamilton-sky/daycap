# P2 build notes — the guardrail actually warns

**Landed 2026-08-26** on `feat/p1-4-ccusage-adapter` (`d513219`, `f59c111`).
309 tests passing, 8 skipped with written reasons.

Until P2, `lum` reported what you spent. It now warns you before the allowance is gone — which is
the entire wedge, and the thing ccusage explicitly declined to build (issues #259 and #822, both
closed NOT_PLANNED).

---

## What shipped

| Task | File | Status |
|---|---|---|
| `P2-1` | `src/domain/budget.ts` | done |
| `P2-3` | `src/app/latch.ts` | done — the correctness centrepiece |
| `P2-4` | `src/adapters/notify/notifier.ts` | done |
| `P2-5` | `src/app/alert.ts` + `src/bin/lum.ts` | done |
| `P2-2` | pacing | **cut from v1** (BUILD_PLAN_v3 §6) |

---

## Decisions worth reversing deliberately

### `budget.ts` takes a `Signal`, not a USD number

`OPEN-F` — do thresholds fire on imputed dollars or on a real rate-limit percentage? — is still
unanswered. Parameterising the signal makes that answer a **default** (~20 lines) instead of a
rewrite of every caller. Both branches exist; flip the constant whenever you decide.

The asymmetry that makes this necessary: a real `rate_limits.used_percentage` reaches only the
**statusline's stdin**, only on a Pro/Max account, only after the first response of a session — and
is structurally unavailable to `lum today`. The two surfaces genuinely know different things.

### `BudgetState` gained `unknown`, against the task's literal wording

`P2-1` says a missing budget yields `state: 'ok'`. It yields `unknown` instead.

With no budget configured there is nothing to be *under*. Reporting `ok` asserts a safety we cannot
vouch for — the identical error to rendering an unknown total as `$0.00`, which DoD #3 forbids.
`unknown` renders as an absence; `ok` would render as reassurance.

### The alert names its window

`ARCH-Q3` ratified two wordings. A third is required now that a crossing can come from a rate
limit, because *"AI Spend: Amber — $8.00 of $10.00"* fired by a 7-day limit is the wrong-number
problem in new clothes.

```
usd + api           -> "…of $10.00 daily budget"
usd + subscription  -> "…of $10.00 daily usage allowance"
rate-limit          -> "Claude 7-day limit at 80% — resets Thu 14:00"
```

---

## The latch — how each rule is proven

L1–L9 are pure, and every one is **mutation-verified**: the rule was deliberately broken and the
suite had to catch it.

| Rule broken | Tests that failed |
|---|---|
| L2 — fire even if already fired | **10** |
| L4 — a dip clears the fired entry | **5** |
| L9 — fire from untrusted data | **3** |
| L3 — merge across days instead of replace | 1 |
| L6 — a corrupt latch does not fail quiet | 1 |
| L1 — `>` instead of `>=` | 1 |

Latch tracks are **per-signal** (`usd|0.8`, `rate-limit:7d|0.8`), so a 7-day crossing and a USD
crossing cannot cancel or double-fire each other.

**The property** holds across every generator the acceptance criteria name — monotone rise, a
fifty-crossing sawtooth, exact boundaries, a single `0 → 1.2` jump, the float edge
`0.7999999999999999` — plus 500 seeded random walks. Hand-rolled rather than `fast-check`: a
dependency for a guarantee a seeded PRNG already gives deterministically was not worth it.

### L7 is an ordering, and orderings rot silently

**Persist the latch, then notify.** A notifier crash costs one alert; the reverse order costs an
alert on *every* invocation, forever — which is how a budget tool teaches its user to mute it. If
the latch write fails, `alert.ts` does not notify at all.

---

## Verified as five separate processes

`P2-3` acceptance #2 rules out in-process re-invocation, and it is right to: the point is that the
latch survives in the **file**, not in a module-level variable a second call would happen to see.

```
$9  -> 0.90  fires 0.8
$9  -> 0.90  fires nothing   (restart, identical spend)
$5  -> 0.50  fires nothing   (dip)
$9  -> 0.90  fires nothing   (L4: a dip never re-arms)
$12 -> 1.20  fires 1.0       (and only 1.0)
```

Exactly two notifications, in order. A truncated `latch.json` silences the rest of the day (L6). A
no-collector read fires nothing and leaves the crossing live for the next trusted run (L9).

`test/integration/latch-restart.test.ts`. `LUM_CCUSAGE_BIN` was added as an explicit resolution
tier to make this testable — and it is a real escape hatch for a non-standard install, not just
test scaffolding.

---

## The notifier

argv arrays with `shell: false` everywhere. Notification text derives from collector output, and
the moment it reaches a shell a tool id becomes an injection vector.

`scrub()` strips path separators, quotes, and control characters, and caps length — enforced in the
notifier rather than trusted from callers, because the caller is the easy place to regress
(ADR-v2-004). A missing binary is a no-op that falls back to a terminal bell. It **cannot throw
into the caller**: a notifier fault must not cost the user the number it was reporting.

---

## Windows: two real bugs, not noise

The Windows CI leg failed on PR #2. BUILD_PLAN_v3 predicted Windows would be where the pain lands
and recommended making the leg non-blocking. That turned out to be the wrong call — all three
failures were genuine.

1. **No `.gitattributes`.** Git checks the tree out CRLF on Windows; biome emits LF; all 37 files
   reported as misformatted, each a whole-file diff whose only difference was an invisible carriage
   return. Fixed with `* text=auto eol=lf` — the formatter was right.
2. **`rename` is not atomic-over-open-file on Windows.** It fails `EPERM` while another handle
   holds the target. The concurrent-writers test hit it exactly. This is what `P1-6`'s "Windows
   rename covered" was pointing at. Retry with capped exponential backoff; each attempt is still
   all-or-nothing, so atomicity is preserved.
3. **Bare Windows paths are not valid ESM specifiers.** `D:\...` fails with
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`; two tests needed `pathToFileURL`.

**Recommendation reversed: keep the Windows leg blocking.** It found three real defects in one run.

---

## Still open

- `OPEN-F` — the default is `usd`; the rate-limit branch is built and waiting.
- `ARCH-Q1` / `ARCH-Q3` — ratified agent-to-agent, still unacknowledged by a human.
- Pacing (`P2-2`) is cut, not deleted from the design. ~1.5 days to recover, zero migration.
