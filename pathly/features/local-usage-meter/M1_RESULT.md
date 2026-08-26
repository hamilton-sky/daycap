# M-1 — measuring the real ccusage binary

**Run 2026-08-26**, `ccusage@20.0.20` installed globally, macOS arm64, Node 26.6.0, against a live
corpus of **371 Claude Code transcripts / 261 MB** plus a `~/.codex/sessions` tree.

Absolute spend figures are deliberately omitted — this repo is public. Every claim below is a
ratio, a reconciliation, or a schema fact, all reproducible with the commands shown.

---

## 1. Latency — the spike's number was wrong, and so was the correction

| What | Measured |
|---|---|
| `ccusage --version` (fixed overhead: Node launcher + native spawn) | **30–40 ms** |
| `ccusage daily --json --offline` — **first run, cold page cache** | **~980 ms** |
| same, warm — 1 day, 25 days, or all-time | **90–110 ms** |

Three corrections, in order:

1. **`SPIKE_RESULT.md`'s "1.2 s warm / 2.6–3.4 s cold" measured `npx -y ccusage@20`**, which pays
   registry resolution and a Node spawn before the collector runs. Not ccusage.
2. **The prediction that a resolved binary would be "~20 ms" was also wrong.** It accounted for
   process startup and ignored the data work.
3. The truth is both: **fixed overhead really is ~35 ms**, and the rest is reading 261 MB. The
   first read is cold-page-cache bound at ~1 s; every subsequent read is ~90 ms.

**`--since`/`--until` do not prune the scan.** 1 day, 25 days and all-time all cost ~90 ms warm —
ccusage reads the whole corpus regardless and filters after. The range is still required for
*correctness* (a 1-day query returns 1 row, a 25-day query returns 19), just never for speed.

**ccusage keeps no on-disk cache of its own** (no `~/.cache/ccusage`, `~/.ccusage`, or
`~/Library/Caches/ccusage`). The cold/warm gap is entirely the OS page cache, so it recurs after a
reboot or under memory pressure — and it **grows with the transcript corpus**, which only ever
gets bigger.

### Consequences

- **`timeoutMs` default should be ~3000, not 300 and not 1500.** A 300 ms budget kills every cold
  start. 1500 ms is marginal today on 261 MB and will not survive corpus growth.
- **The snapshot cache stays load-bearing, so `PRE-F` keeps its urgency** — but for a different
  reason than the plan gave. Not "every call costs 1.2 s"; rather "the warm call is affordable and
  the cold call is not, and you cannot choose which one a statusline tick gets."
- A `Stop`-hook refresh (~90 ms warm, ~1 s cold, in the background, once per turn) is comfortably
  within budget. A per-tick synchronous call is not.

---

## 2. Schema — two field names in the plan are wrong

`ccusage daily --json` returns `{ daily[], totals }`, and a row is:

```
period            "2026-08-24"     ← NOT `date`
totalCost         <float>          ← NOT `costUSD` / `cost` / `total_cost`
agent             "all"
metadata          { agents: ["claude", "codex"] }
modelsUsed        [ "claude-opus-5", "gpt-5.6-terra", ... ]
modelBreakdowns   [ { modelName, cost, inputTokens, outputTokens,
                      cacheCreationTokens, cacheReadTokens }, ... ]
inputTokens / outputTokens / cacheCreationTokens / cacheReadTokens / totalTokens
```

`BUILD_PLAN_v3.md` §3.4 assumed `date` and an alias chain starting `totalCost ?? total_cost ??
costUSD ?? cost`. The cost chain works by luck; **the date key must be `period`**.

### `ccusage codex daily` is a different schema, not a variant

```
date              "2026-08-05"     ← `date` here, `period` there
costUSD           <float>          ← `costUSD` here, `totalCost` there
models            { "<model>": {...} }   ← dict, vs `modelBreakdowns[]` list
```

Same tool, same major version, **incompatible row shapes between subcommands**. This is
ccusage issue #831 observed directly. Defensive, alias-tolerant parsing is not paranoia here.

---

## 3. `--by-agent` does not split. It never returned anything but `all`.

Across all 20 days: **every row has `agent: "all"`**, while `metadata.agents` correctly reports
`claude` on 20 days and `codex` on 5.

`SPIKE_RESULT.md`'s claim — *"`--by-agent` returns per-day `agents[]` with per-agent cost,
populated for both tools, reconciling to 7.1e-15"* — **is not reproducible on 20.0.20**. There is
no `agents[]` array carrying cost. `metadata.agents` names the contributors without apportioning
between them.

---

## 4. The important one: `ccusage daily` ALREADY includes Codex

The planned adapter design was two parallel spawns — `daily` and `codex daily` — summed.
**That double-counts.**

Proof, day 2026-08-05: the main `daily` row's `modelsUsed` contains `gpt-5.6-terra`, and its
`modelBreakdowns` entry for that model is **byte-identical** to what `ccusage codex daily` reports
for the same day. Same on all five days where `metadata.agents` includes codex.

The inflation equals the entire codex total. Small on a claude-heavy machine (well under 1% here),
**unbounded on a codex-heavy one** — and it lands squarely on the headline number the whole
product exists to show.

### The correct design: one spawn, split by model family

```
ccusage daily --json --offline --since <d> --until <d>
  → per-day totalCost                      (the total; no second command)
  → modelBreakdowns[].{modelName, cost}    (the per-tool split)
```

Attribute `modelName` → tool inside the adapter's own alias map (`claude-*` → `claude-code`,
`gpt-*`/`o1-*`/`o3-*` → `codex`), which is exactly where revised **C6** says per-adapter maps
belong — not a shared registry, so `P1-1`'s no-per-tool-branch-in-`src/` rule holds.

Verified across the whole corpus:

- `sum(modelBreakdowns[].cost) == totalCost` on **all 20 days**, to < 1e-9.
- The gpt-family share of each day equals `ccusage codex daily` for that day, to < 1e-9, on
  **all 5** codex days.

So the split is exact, it needs one spawn instead of two, and it cannot double-count.

**Drop `ccusage codex daily` from the adapter entirely.** Its only remaining use is as an
independent cross-check in the nightly drift canary.

---

## 5. What this changes in BUILD_PLAN_v3

| §  | Was | Now |
|---|---|---|
| 3.2 | two spawns, `Promise.allSettled`, summed | **one spawn**; codex comes from `modelBreakdowns` |
| 3.4 | `date` key, `--by-agent` for the split | `period` key; `--by-agent` is useless; split via `modelBreakdowns` |
| 4.1 | resolve binary to avoid ~1.2 s | still resolve it, but the win is ~35 ms overhead — the corpus read dominates |
| C11 | `timeoutMs` 300–1500 | **3000**, sized for a cold page cache on a growing corpus |
