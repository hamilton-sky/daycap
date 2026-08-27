# `lum`

A local **budget guardrail** for AI coding tools. It reads today's spend from a usage collector
already on your machine, compares it against a daily allowance across every tool you use, warns you
before the allowance is gone — and can **block** tool calls once it is.

No server, no proxy, no login, no daemon of its own. Nothing leaves the machine.

> **Naming.** The CLI is `lum`. The repo is still `token-tracker` and the product name is not
> settled — see [Open decisions](#open-decisions). Don't write marketing copy against either yet.

---

## Try it in 30 seconds

```bash
pnpm install && pnpm verify      # typecheck, lint, build, 636 tests
npm i -g ccusage@20              # the collector, if you don't have it
node dist/lum.js today           # a real number from your own transcripts
node dist/lum.js doctor          # why the number is what it is
```

## What you get

```
lum — 2026-08-27

  claude-code     $215.78
  codex             $1.37
  ───────────────────────
  TOTAL           $217.15  (imputed)

  ███████████████░░░░░░░░░░░░░░░  49% of $20.00
```

One line in your Claude Code statusline, which is the surface that actually changes behaviour:

```
today $3.20 / $10.00 (32%) ▓▓░░░          API-key account, under 80%
5h 23% · 7d 41% ▓▓░░░  ≈$3.20 today       subscription — rate limit first
today $6.40 / $10.00 (64%) ▓▓▓░░ ↑        ahead of pace for the time of day
today $8.40 / $10.00 (84%) ▓▓▓▓░          crossed 80%   (amber + notification)
today $11.90 / $10.00 (119%) ▓▓▓▓▓        over budget   (red + notification)
lum — (no source)                          no collector installed
```

On a subscription the headline is **rate-limit percentage, not dollars** — imputed USD is money that
does not exist, and Claude Code hands the real constraint to the statusline on stdin.

## Install

```bash
lum install            # prints the Claude Code settings block, changes nothing
lum install --write    # applies it, after backing up settings.json
lum install --write --guard    # also installs the PreToolUse enforcement hook
lum install --write --codex    # Codex instead (~/.codex/hooks.json) — hooks only
```

`--write` never clobbers: it backs up `settings.json` first, and re-running is idempotent.

Config lives at `~/.localusagemeter/config.json`. Every key is optional; a malformed file still
renders, and `lum doctor` prints the reason rather than failing silently.

```json
{
  "dailyBudgetUsd": 20,
  "resetHourLocal": 0,
  "thresholds": [0.8, 1.0],
  "source": "auto",
  "notifications": { "enabled": true },
  "guard": { "enabled": false, "denyAt": 1.0, "allowTools": ["Read"] }
}
```

### Sources

```json
{ "source": "auto" }
{ "source": "ccusage" }
{ "source": "jsonfile", "sourceFile": "/Users/you/usage.json" }
```

`auto` walks **jsonfile, then ccusage** — jsonfile is only a candidate when you have set a path,
which is a deliberate act, where `ccusage` on `PATH` may be there because something else installed
it. With no path set, `auto` is ccusage.

**Naming a source turns the fallback off.** If you write `"source": "ccusage"` and ccusage cannot be
reached, `lum` reports that and stops — it does not quietly read the other one. Silently falling back
from the source you chose is how a tool reports the wrong numbers without telling you. `doctor` will
say which other source *would* have worked, so a broken install and a wrong config key are
distinguishable.

**`jsonfile` is the escape hatch.** If your tool has no collector, produce this yourself — a cron
job, a shell one-liner, an export from something nobody has adapted — and `lum` counts it:

```json
{
  "schema": 1,
  "generatedAtUtc": "2026-08-27T09:00:00.000Z",
  "entries": [
    { "at": "2026-08-27T09:00:00.000Z", "tool": "my-own-tool", "usd": 7.50 },
    { "at": "2026-08-27T10:00:00.000Z", "tool": "claude-code", "usd": 2.25, "imputed": true }
  ]
}
```

`usd: null` means "activity I could not price". It is not zero and never renders as `$0.00`.

## Tool coverage — read this before assuming

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| `today` / `doctor` / notifications | ✅ | ✅ | ❌ named, never priced |
| statusline | ✅ | ❌ not possible | ❌ |
| guard (blocking) | ✅ | ✅ *weaker guarantee* | ❌ |

- **Codex has no statusline and cannot.** `tui.status_line` takes a closed list of Codex's own
  built-in items — no command contract, no stdin JSON. That is schema-level, a ceiling not a gap.
- **Cursor exposes no local spend data at all.** Its tracking DB has no token, cost or price column,
  so no collector can price it from disk — ever. `lum doctor` names it as detected-but-unpriceable
  rather than silently omitting it, because a total that quietly excludes your heaviest tool is
  worse than one that says what it is missing.
- **The two guard ticks are not the same tick.** Claude Code documents that a hook `deny` applies
  even under `--dangerously-skip-permissions`. OpenAI explicitly declines to make that promise,
  calling hooks "a useful guardrail, not a complete enforcement boundary". Don't flatten them.

## The guard

Off by default, twice over: it needs `--guard` at install **and** `guard.enabled` in config.

It reads a cached snapshot with `node:fs` and never calls the collector, because a hook that times
out does **not** block — so a slow guard is an absent guard. It denies only on a fresh (<2 min),
healthy, trusted snapshot, and **fails open on every fault**. The denial message says how to get
unstuck.

**It is not unbypassable, and the docs will not pretend otherwise.** `disableAllHooks`, `--bare`,
and simply removing the hook all turn it off. What it does give you is a real stop at the moment you
would otherwise blow the budget, rather than a number you had already stopped reading.

## Design

We never parse a log. A collector already on the machine does that, for more tools than we ever
would, and `lum` owns the budget policy on top.

```
  Claude Code ─┐
  Codex CLI   ─┼──►  ccusage  ──►  normalised, priced usage ──┐
  your own    ─┘     (or your own JSON file)                  │
                                                             ▼
                     ┌───────────────────────────────────────────────┐
                     │  lum  —  budget policy only                   │
                     │  select source → evaluate → latch → notify    │
                     └───────────────────┬───────────────────────────┘
     Claude Code stdin ──────────────────┤  rate_limits, cost, context_window
                                         ▼
        statusline row · lum today · OS notification · PreToolUse deny
```

Node ≥ 20.11, TypeScript, ESM-only, **zero runtime dependencies**. `domain/` is pure — no fs, no clock,
no network — enforced by lint *and* by tests that grep the build output.

### Invariants

Break these and the tool is worse than nothing:

1. **Unknown never renders as `$0.00`.** A collector-*confirmed* zero may say zero; "we don't know"
   may not. `ToolSpend.usd` is nullable so this stays expressible.
2. **The latch fires at most once per threshold per usage-day.** A dip never re-arms it; only a day
   change does.
3. **Only trusted data fires or blocks.** Stale, timed-out, source-down or unpriced → no
   notification, no latch advance, no denial. A missed alert costs money; a wrong one costs trust.
4. **Persist the latch, then notify.** The reverse order re-alerts forever.
5. **Every surface exits 0.** Only `doctor` may exit 1, and only when nothing is usable.
6. **The guard fails open.**
7. **Never parse a transcript.** Enforced by a CI gate, not by discipline.

## Honest positioning

The differentiator is **zero setup**, not uniqueness. LiteLLM can do budget enforcement too — with a
proxy, a Postgres database, and re-pointed credentials. The existing local trackers all answer *"what
did I spend?"*; this answers *"am I about to blow my allowance?"* — and installs with one command
and no credentials.

## Open decisions

Two, both needing a human, both blocking release:

| # | Decision | State |
|---|---|---|
| **PRE-B** | **Has anyone asked for this?** | Open. Unclaimed and unwanted look identical from outside. |
| **PRE-D** | **What is it called?** [Token Tracker](https://github.com/xiufengsun/TokenTracker) is an established project doing the collection half. | Open. CLI `lum` is settled; repo and product name are not. |

Settled since: **MIT** (`LICENSE`), and Node's floor is `>=20.11`, verified by a `node20-compat`
CI job rather than asserted.

## Non-goals

- **Collecting usage.** We consume a collector; we never parse a transcript (ADR-v2-001).
- Central multi-user aggregation — no server, no backend, no shared database.
- Any network call at all from shipped code.
- Billing-exact accuracy — "reasonable, today, in time to act" is the bar.

## Privacy

Nothing leaves the machine. The only paths any shipped code touches are the collector's own CLI, the
user's config, and — on an explicit `--write` — `~/.claude/settings.json` or `~/.codex/hooks.json`.
Transcript directories are forbidden in `src/` by a test. `doctor` abbreviates your home directory to
`~` because its output is written to be pasted into issues. A canary test asserts no fixture content
reaches stdout, the snapshot, the latch, or a notification's argv.

## Development

```bash
pnpm verify        # typecheck + lint + build + test  (636 passing, 12 skipped)
pnpm test:watch
pnpm coverage
```

Conventions that made this codebase work, in [`HANDOFF.md`](HANDOFF.md) §8 — the short version:
mutation-test anything load-bearing, every skip carries a written reason, never loosen a gate without
writing down why in the same commit, and comments explain *why*, especially where the code looks
wrong.

## License

[MIT](LICENSE). Unconstrained by anything we ship — see
[`LICENSE_SCAN.md`](pathly/features/local-usage-meter/LICENSE_SCAN.md): the published artifact
carries no third-party code at all.
