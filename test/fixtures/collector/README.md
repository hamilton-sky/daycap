# Collector contract fixtures

Frozen by `P0-5` on 2026-08-25 from the live probes recorded in
[`SPIKE_RESULT.md`](../../../pathly/features/local-usage-meter/SPIKE_RESULT.md).
These are the stub corpus every `UsageSourcePort` adapter is tested against in `P1`.

**Provenance.** Real responses from **budi 8.5.11** (HTTP daemon + CLI) and **ccusage 20.0.20** on
macOS 26.6.2, local tz `Asia/Jerusalem` (UTC+3), over 21,000 real messages.

**Scrubbing.** Built by **whitelist** — each object is constructed from a permitted field list, never
by filtering the original — the same method as `fixtures/claude-session-scrubbed.jsonl`. Verified to
contain **81 distinct string values**, all of which are dates, ISO timestamps, provider ids, model
names, synthetic session ids, or `[scrubbed]`. Zero filesystem paths, zero repository or project
names, zero session titles, zero prose.

Dropped outright: `sessions[].title`, `sessions[].repo_ids`, `sessions[].git_branches`,
`sessions[].id` (replaced with `session-00N`), and `filter-options.projects` / `.branches`.

## Files

| Fixture | Source call | Why it is kept |
|---|---|---|
| `budi-http/statusline.json` | `GET /analytics/statusline` | Satisfies D1+D2+D3 in one call, and carries the pacing fields (`cycle_elapsed_percent`, `window_burn_rate`) that may make `pacing.ts` a read instead of a computation. |
| `budi-http/providers-closed-past-day.json` | `GET /analytics/providers?since=D&until=D+1` | The happy path: per-tool USD for one settled day. |
| `budi-http/providers-empty-exclusive-until.json` | `GET /analytics/providers?since=D&until=D` | **Trap 2.** The natural spelling of "just today" returns `[]`. Must render *unknown*, never `$0.00`. |
| `budi-http/providers-all-time.json` | `GET /analytics/providers` (unranged) | **Trap 1.** What an ignored/typo'd range param returns — a `200` with all-time totals. On the spike machine that is $912.87 reported as "today". |
| `budi-http/activity-daily.json` | `GET /analytics/activity` | Rows already keyed by calendar date (`label`) — the D1 "or" branch. |
| `budi-http/rate-limit-windows.json` | `GET /analytics/rate-limit-windows` | budi's *derived* 5-hour blocks. **Not** provider-reported `rate_limits`; see `OPEN-F`. |
| `budi-http/{cost,summary,models,surfaces,billing-blocks,sessions,filter-options}.json` | respective routes | Shape coverage for `lum doctor` and the `P4` breakdown views. |
| `budi-cli/stats-today.json` | `budi stats -p today --format json` | Note `window_start: 2026-08-24T21:00:00+00:00` = **local** midnight. Costs are rounded to **whole cents**. |
| `budi-cli/stats-daily-7d.json` | `budi stats daily -p 7d --format json` | Day-keyed `buckets[]`, local axis. |
| `ccusage/daily.json` | `ccusage daily --json --offline` | Rows keyed `period`; `agent: "all"` — cost **not** split per tool by default. |
| `ccusage/daily-by-agent.json` | `… --by-agent --since D` | The flag the ccusage adapter must pass for D3. **Caveat: no day on the spike machine mixed two agents, so per-tool splitting is unverified.** |

## Three range conventions. Do not assume.

| Surface | Single day `D` is spelled | `until` |
|---|---|---|
| budi **HTTP** | `?since=D&until=D+1` | **exclusive** |
| budi **CLI** | `--since D --until D` | **inclusive** |
| **ccusage** | `--since D --until D` | **inclusive** |

## Two axes. Pin one in every test.

The same calendar date differs by **1.90×** depending on the timezone axis (see `SPIKE_RESULT.md` §4):

| Axis | 2026-08-24 |
|---|---|
| **UTC** — budi HTTP, `ccusage -z UTC` | **$16.3686** (both, exact) |
| **local** — budi CLI, `ccusage -z Asia/Jerusalem` | **$31.1300** / **$31.1282** (delta is CLI cent-rounding) |

Cross-adapter equality assertions are valid **only** once the axis is pinned. Which axis the product
uses is **`PRE-G`**, an open human decision.

## Regenerating

These are frozen artifacts, not generated at test time — a test that hits `127.0.0.1:7878` is not a
unit test. To refresh after a collector upgrade, re-run `P0-1`…`P0-5` and re-verify the scrub with
the exhaustive string dump in `SPIKE_RESULT.md` §9. **Never** commit `spike/` — it holds unscrubbed
repository names and session titles, and is git-ignored for that reason.
