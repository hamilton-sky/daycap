# Architecture Proposal — LocalUsageMeter

_Stage: DESIGN (storm) · Rigor: standard · Date: 2026-08-10_
_Updated: 2026-08-10 — ratified decisions from evaluator injected_
_Sources of truth: `pathly/features/local-usage-meter/PO_NOTES.md`, `local-usage-meter-BRIEF.md`_

---

## Decision resolution status

| ARCH_QUESTION | Status | Resolution |
|---|---|---|
| **Q1 — accountMode** | ✅ RATIFIED | **Option A** — optional per-CLI `accountMode` field, default `"subscription"`. Numbers labelled `≈` until developer explicitly sets `"api"`. No schema change needed — `accountMode` is already in §3.5 Config. |
| **Q2 — Codex sample log at BUILD start** | ⚠️ AGENT-DECIDED, HUMAN GATE STILL OPEN | **Option B with defensive normalization + provisional marking.** Both token-counting behaviours (cumulative vs delta, `input_tokens` includes cached) are handled unconditionally in the reader normalization layer per the documented Codex event schema. `lum doctor` shows `Codex: PROVISIONAL` until user runs `lum verify-codex` with a real log. **Caveat:** the evaluator warned at 15:00 that Option B "is not recommended" and needed an explicit human answer, then adopted Option B itself at 17:20. The board escalation is still `status=pending`, unacknowledged. Phase 1 may proceed; acceptance signal 3 cannot be called met until a real log is seen. |
| **Q3 — subscription thresholds** | ✅ RATIFIED | **A+C hybrid** — thresholds fire at the same fractions for all account types, but wording substitutes "usage allowance" for "budget" on subscription accounts (e.g., "80% of daily usage allowance"). This is a one-string-interpolation change in `notify/notifier.ts`; the budget domain function and fraction computation are unchanged. |
| **ccusage Rust binary** | ✅ RESOLVED | **Shell-out primary, bundled pricing.** ccusage ≥ v20 is a compiled Rust binary; no JS library exports exist. ADR-001 updated: `pricing.bundled.ts` is the primary PricingPort adapter; `baseline.shellout.ts` is the primary BaselineLoaderPort adapter. The JS library embed path is removed. See §4 below. |

> **BUILD gate: PARTIALLY LIFTED.** Q1 and Q3 are ratified. Q2 and the ccusage inversion were
> decided by agents over an open human escalation that no human has acknowledged. Phase 1
> (`a0b2098a`, scaffold) can start — nothing in it depends on either. Acceptance signals 2 and 3
> stay UNVERIFIED until PRE-1 lands. See §10 (PRE-1, PRE-10).

---

## 0. Position statement (read this first)

Three decisions carry most of the architecture. Everything else follows from them.

1. **Own the parse and the price; keep ccusage behind a port as a cross-check** — not an embed.
   RESEARCH.md §1 established that ccusage ≥ v20 is a compiled Rust binary with no importable JS
   exports, so the embed this section originally specified is not buildable. Pricing comes from a
   vendored LiteLLM snapshot (`pricing.bundled.ts`); the 5-minute reconcile shells out to the
   binary when it happens to be installed (`baseline.shellout.ts`) and is skipped when it is not.
   The port stays because it keeps the app layer ignorant of which adapter won. See §1.2 and
   ADR-001.

   > **This inverts PO constraint #1**, which required reusing ccusage to parse both CLIs and to
   > price. On the primary path we now do neither. The change was forced by research and ratified
   > by the evaluator, not by the human who set the constraint — it needs a one-line sign-off
   > before P1 ships, and it is listed as PRE-10 in §10.
2. **Split writer from readers.** One background daemon owns all parsing and writes a tiny atomic
   snapshot; the statusline script, the TUI, and the notifier are dumb readers. The statusline must
   never parse a log file.
3. **Incremental byte-offset tailing on the hot path, full ccusage recompute as the correctness
   anchor.** Tail gives sub-second latency; the periodic full recompute stops drift and gives us a
   free automated parity assertion.

The single largest accuracy risk in this product is **not** pricing — it is **counting the same turn
twice** (Claude duplicates assistant messages across session files; Codex `total_token_usage` is
cumulative) and **misassigning cache buckets** (Anthropic `input_tokens` *excludes* cache reads;
OpenAI `input_tokens` *includes* them). Section 3 and ADR-006 address this head-on.

```
                    ┌──────────────────────────────────┐
   ~/.claude ──fs──►│  lum daemon  (single writer)     │
   ~/.codex  ──fs──►│  tail → normalize → dedupe →     │
                    │  price → aggregate → snapshot    │
                    └───────────────┬──────────────────┘
                     atomic write   │
                                    ▼
                    ~/.localusagemeter/state/today.json  (< 2 KB)
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      [statusline.js]        [lum --live TUI]      [notifier latch]
       read+print, <30ms      redraw on change      threshold crossing
```

---

## 1. Technology stack decision

### 1.1 Runtime

**Node.js ≥ 20.11 (target 22 LTS), TypeScript 5.x, ESM-only.**

Justification:
- Node is what the statusline hook and the ecosystem already assume; it is not chosen to enable a
  ccusage embed, which §1.2 establishes is impossible. (This bullet previously argued the embed
  case — it no longer applies, but the conclusion is unchanged for the reasons below.)
- The Claude Code statusLine hook invokes an arbitrary shell command; Node is already on the machine
  of anyone running Claude Code or Codex CLI (both ship as npm packages).
- Node ≥ 20.11 gives `import.meta.dirname`, stable `node:test`-free `parseArgs` in `node:util`, and
  recursive `fs.watch` on Linux.

Rejected: Bun (fast start, but adds an install prerequisite and its `fs.watch` parity is a risk),
Deno (npm interop friction), Python/Go (no longer disqualified by ccusage reuse now that the embed is gone, but they buy nothing here and cost the ecosystem fit above).

### 1.2 ccusage integration strategy

**Shell-out primary, bundled LiteLLM pricing.** ccusage ≥ v20 is a platform-specific Rust binary
(no JS/TS library exports). The original embed strategy is not implementable. Updated approach:
- **Pricing:** `pricing.bundled.ts` reads `src/pricing/prices.snapshot.json` (vendored at scaffold
  time from the LiteLLM price table). No runtime dependency on the ccusage binary for pricing.
- **Reconcile baseline:** `baseline.shellout.ts` spawns `ccusage daily --json --offline` every 5
  minutes for the drift-check total. Gracefully skipped if binary not on PATH.
- **Hot path:** zero ccusage involvement — all JSONL parsing is our own readers, all pricing from
  the bundled JSON file.

Full rationale in §4 (updated) and ADR-001 (updated).

### 1.3 Dependency budget

Deliberately small. Every dependency on the statusline path is a latency tax.

| Dependency | Purpose | Layer | Notes |
|---|---|---|---|
| `zod` | config + log-line schema validation | adapter | Runtime dep. |
| `chokidar@4` | cross-platform fs watching | adapter | Pinned to v4 to match ADR-007 and §5.2. v5 exists (ESM-only, smaller) and is a fine later bump, but the v4 directory-watch + `ignored`-callback pattern in §5.2 is the one RESEARCH.md §2 actually verified. One version, stated once. Closes RESEARCH B5. |
| `picocolors` | ANSI colour | adapter (render) | ~2 KB, no deps. |
| **dev/scaffold:** `ccusage` binary | Generate `prices.snapshot.json` at scaffold time | — | Rust binary, not a runtime import. One-time use. |
| **dev:** `vitest`, `tsdown`, `typescript`, `biome` | test/build/lint | — | |

> `ccusage` and `@ccusage/codex` are **not** runtime npm dependencies. The ccusage binary is used
> once at scaffold time to produce `prices.snapshot.json`, which is then vendored. `@ccusage/codex`
> is deprecated and removed entirely.

**Zero runtime deps on the statusline path.** `bin/statusline.js` imports only `node:fs`.

Explicitly rejected deps: `ink` (React runtime for a one-screen dashboard — see ADR-007),
`node-notifier` (unmaintained, bundles binaries — ADR-008), `@parcel/watcher` (native postinstall
binary breaks "setup is trivial"), any SQLite driver (ADR-005), any HTTP client (constraint #4 —
the package must be greppable-clean of network primitives).

---

## 2. Module / layer structure

Dependency direction is strictly inward. `domain` imports nothing local. Each outward layer may
import only the layers above it in this diagram.

```
╔══════════════════════════════════════════════════════════╗
║  domain/            pure functions + types + PORTS       ║
║  no fs, no net, no clock, no ccusage import              ║
╚══════════════════════════════════════════════════════════╝
                          ▲ implements ports
╔══════════════════════════════════════════════════════════╗
║  app/               orchestration, use-cases             ║
║  LedgerService · WatchOrchestrator · Reconciler ·        ║
║  ThresholdLatch · SnapshotWriter                         ║
╚══════════════════════════════════════════════════════════╝
                          ▲ injected
╔══════════════════════════════════════════════════════════╗
║  adapters/          all I/O and all 3rd-party contact    ║
║  ccusage/ · readers/ · watch/ · store/ · config/ ·       ║
║  notify/ · render/                                       ║
╚══════════════════════════════════════════════════════════╝
                          ▲ wires
╔══════════════════════════════════════════════════════════╗
║  bin/               entrypoints (composition root)       ║
║  lum.ts · daemon.ts · statusline.js                      ║
╚══════════════════════════════════════════════════════════╝
```

### 2.1 Proposed tree

```
src/
  domain/
    types.ts            TurnRecord, DailyLedger, Snapshot, Config, Cli
    tokens.ts           TokenCounts algebra (add, zero, fromClaude, fromCodex)
    pricing.ts          priceTurn(tokens, ModelRate) -> CostBreakdown   [pure]
    budget.ts           evaluate(totalUsd, cfg) -> {fraction, state, crossed[]}
    day-window.ts       usageDayFor(tsUtc, resetHour, tz) + window bounds
    dedupe.ts           turnKey(...) + SeenSet interface
    ports.ts            PricingPort BaselineLoaderPort WatchPort StorePort
                        NotifierPort ClockPort LoggerPort
  app/
    ledger-service.ts   apply(TurnRecord[]) -> DailyLedger  (fold + latch)
    watch-orchestrator.ts  debounce, coalesce, drive readers, wake detect
    reconciler.ts       full ccusage recompute -> diff vs ledger -> repair
    snapshot-writer.ts  DailyLedger -> Snapshot -> StorePort.atomicWrite
    daemon.ts           lifecycle, lockfile, signal handling
  adapters/
    ccusage/
      pricing.bundled.ts     PricingPort PRIMARY — reads src/pricing/prices.snapshot.json
      pricing.shellout.ts    PricingPort FALLBACK — ccusage pricing --json (if binary present)
      baseline.shellout.ts   BaselineLoaderPort PRIMARY — ccusage daily --json --offline
                             (optional: skipped gracefully if binary not on PATH)
    readers/
      discovery.ts        resolve + glob candidate files, mtime prefilter
      tail.ts             byte-offset incremental line reader (rotation-safe)
      claude-jsonl.ts     line -> TurnRecord | null   (schema-validated)
      codex-jsonl.ts      line -> TurnRecord | null   (schema-validated)
    watch/
      chokidar.watch.ts   WatchPort primary
      poll.watch.ts       WatchPort fallback + always-on safety net
    store/
      atomic-json.ts      write tmp + fsync + rename
      lockfile.ts         single-daemon guarantee, stale-pid reap
      paths.ts            ~/.localusagemeter layout
    config/
      schema.ts           zod schema w/ defaults, unknown keys -> warn
      load.ts             read, validate, watch-for-change
    notify/
      notifier.ts         osascript | notify-send | powershell | bell
    render/
      statusline.ts       Snapshot -> single line (+ANSI)
      live.ts             Snapshot -> full-screen ANSI dashboard
      table.ts            Snapshot -> breakdown table for `lum today`
  pricing/
    prices.snapshot.json  vendored offline price table + version stamp
bin/
  lum.ts                  CLI multiplexer
  statusline.js           standalone, zero-import fast path
test/
  fixtures/claude/*.jsonl
  fixtures/codex/*.jsonl
  golden/*.json
```

### 2.2 Ports (the seams that matter)

```ts
interface PricingPort {
  rateFor(model: string, cli: Cli): ModelRate | null;   // null => unknown model
  snapshotVersion: string;
}
interface BaselineLoaderPort {                          // ccusage lives behind this
  loadWindow(from: Date, to: Date, clis: Cli[]): Promise<TurnRecord[]>;
}
interface WatchPort {
  start(dirs: string[], onChange: (paths: string[]) => void): Disposable;
  mode: 'fs' | 'poll';
}
interface StorePort {
  readLedger(day: string): DailyLedger | null;
  writeLedger(l: DailyLedger): void;      // atomic
  writeSnapshot(s: Snapshot): void;       // atomic
}
```

Rule enforced by lint (`biome` import rules) + a unit test that greps the built `domain/` output:
**`domain/` must contain no `node:` or 3rd-party import.**

---

## 3. Data model

### 3.1 `TokenCounts` — six fields, not four

The PO requires four *priced* classes. We carry **six stored fields** because two of them are needed
to price the four classes correctly and to avoid double counting.

```ts
type Cli = 'claude' | 'codex';

type TokenCounts = {
  inputUncached:  number;  // PRICED 1x    — cache-read tokens already removed
  cacheWrite5m:   number;  // PRICED 1.25x — ephemeral 5-minute cache creation
  cacheWrite1h:   number;  // PRICED 2x    — ephemeral 1-hour cache creation
  cacheRead:      number;  // PRICED 0.1x
  output:         number;  // PRICED output rate — INCLUDES reasoning tokens
  reasoning:      number;  // NOT PRICED separately — subset of `output`, display only
};
```

Normalization rules (these are the accuracy contract):

| Source field | Rule |
|---|---|
| Claude `message.usage.input_tokens` | → `inputUncached` **as-is**. Anthropic already excludes cache reads. Do **not** subtract. |
| Claude `cache_creation_input_tokens` | → `cacheWrite5m` **unless** `message.usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` is present, in which case use that split. |
| Claude `cache_read_input_tokens` | → `cacheRead` |
| Claude `output_tokens` | → `output` (reasoning already inside) |
| Codex `input_tokens` | → `inputUncached = input_tokens − cached_input_tokens`. **OpenAI counts cached inside input.** Clamp at 0. |
| Codex `cached_input_tokens` | → `cacheRead` |
| Codex cache write | → **0**. OpenAI automatic caching has no write charge. |
| Codex `output_tokens` | → `output` |
| Codex `reasoning_output_tokens` | → `reasoning` only. **Never added to `output`** — it is a subset. |

> Both "already includes" claims are the classic double-count traps. They are flagged as
> `VERIFY-01` / `VERIFY-02` in §10 and must be asserted against the real sample logs before Phase 1
> is accepted, with a golden-file test pinning the expected totals.

### 3.2 `TurnRecord`

The atomic unit. Immutable. Carries **no prompt or response content, ever** — the parser whitelists
fields rather than spreading the parsed object.

```ts
type TurnRecord = {
  key:        string;   // dedup identity, see below
  cli:        Cli;
  model:      string;   // normalized, e.g. "claude-sonnet-4-5-20250929", "gpt-5-codex"
  tsUtc:      string;   // ISO 8601 Z
  usageDay:   string;   // "YYYY-MM-DD" in reset-hour-shifted local space
  tokens:     TokenCounts;
  cost:       CostBreakdown;
  imputed:    boolean;  // true => subscription account, cost is at API list rates
  pricing:    'computed' | 'unknown-model';
  source:     { file: string; offset: number };   // local paths only, never exported
};

type CostBreakdown = {
  inputUncachedUsd: number;
  cacheWriteUsd:    number;
  cacheReadUsd:     number;
  outputUsd:        number;
  totalUsd:         number;
};
```

**Dedup key.**
- Claude: `claude:${message.id}:${requestId ?? ''}` — Claude Code writes the same assistant message
  into multiple `.jsonl` files on resume / compact / branch. Without this the total inflates,
  sometimes 2–3×. This is the same strategy ccusage uses.
- Codex: `codex:${sessionId}:${turnIndex}` derived from event ordering, because `token_count` events
  carry a **cumulative** `total_token_usage`. We consume `last_token_usage` (per-turn delta); if only
  totals are present we diff against the previous total for that session. Never sum totals.
- Fallback when identity fields are missing: `sha1(file + byteOffset)` — safe because the tail reader
  never re-reads the same offset unless the file was truncated, and truncation resets the seen-set
  scan anyway.

### 3.3 `DailyLedger` (daemon-owned, full fidelity)

Written to `~/.localusagemeter/ledgers/<usageDay>.json`. 35-day rolling retention.

```ts
type Bucket = { tokens: TokenCounts; cost: CostBreakdown; turns: number };

type DailyLedger = {
  schemaVersion: 1;
  usageDay:      string;          // "2026-08-10"
  window:        { startUtc: string; endUtc: string; resetHourLocal: number; tz: string };
  totals:        Bucket;
  byCli:         Partial<Record<Cli, Bucket>>;
  byModel:       Record<string, Bucket & { cli: Cli }>;
  money:         { realUsd: number; imputedUsd: number; totalUsd: number };
  budget:        { dailyBudgetUsd: number; fraction: number;
                   state: 'green' | 'amber' | 'red' };
  thresholdsFired: number[];      // latched, survives restart -> no duplicate alerts
  cursors:       Record<string, { ino: number; size: number;
                                  offset: number; mtimeMs: number }>;
  health:        { unknownModels: string[]; parseErrors: number;
                   watchMode: 'fs' | 'poll'; lastReconcileUtc: string | null;
                   lastReconcileDriftUsd: number | null };
  pricingSnapshotVersion: string;
  lastUpdatedUtc: string;
};
```

Seen-key set lives **beside** the ledger in `ledgers/<usageDay>.seen.json` (a plain string array,
~80 KB on a heavy day) so the ledger stays small and the snapshot stays tiny.

### 3.4 `Snapshot` (reader-facing, hot path)

The only file the statusline touches. Kept under 2 KB so a sync read is ~1 ms.

```ts
type Snapshot = {
  schemaVersion: 1;
  usageDay:      string;
  totalUsd:      number;
  imputedUsd:    number;      // >0 => display must label the number as imputed
  budgetUsd:     number;
  fraction:      number;      // totalUsd / budgetUsd
  state:         'green' | 'amber' | 'red';
  byCli:         { claude?: number; codex?: number };
  topModels:     Array<{ model: string; usd: number }>;  // max 3
  updatedAtUtc:  string;
  daemon:        { pid: number | null; watchMode: 'fs' | 'poll' };
  degraded?:     'stale' | 'no-daemon' | 'unknown-model' | 'parse-errors';
};
```

### 3.5 `Config`

`~/.localusagemeter/config.json`. **The five PO-specified keys are the entire required surface**;
everything else is optional with a default, so the exact config literal from the brief validates
unchanged. Unknown keys produce a warning to stderr, never a failure.

```ts
type Config = {
  // --- required by PO_NOTES constraint #6 ---
  dailyBudgetUsd: number;              // default 10.0,  > 0
  resetHourLocal: number;              // default 0,     int 0..23
  thresholds: number[];                // default [0.8, 1.0], ascending, > 0
  clis: Cli[];                         // default ["claude","codex"]
  imputeCostForSubscription: boolean;  // default true

  // --- optional, defaulted ---
  accountMode?: { claude?: 'subscription' | 'api'; codex?: 'subscription' | 'api' };
                                       // default: both 'subscription'  (see ARCH_QUESTION 1)
  timezone?: string;                   // default: system tz (IANA)
  paths?: { claude?: string[]; codex?: string[] };
                                       // default ["~/.claude/projects"], ["~/.codex/sessions"]
  watch?: { mode?: 'auto'|'fs'|'poll'; debounceMs?: number;    // 250
            maxWaitMs?: number;        // 1000
            safetyPollMs?: number };   // 5000
  reconcile?: { intervalMs?: number };  // 300000 (5 min) full ccusage recompute
  display?: { barWidth?: number;       // 5
              color?: boolean;         // auto from NO_COLOR / TTY
              format?: string };       // template override
  notifications?: { enabled?: boolean; command?: string };  // true
  pricing?: { source?: 'bundled'|'ccusage'; file?: string };  // 'ccusage' w/ bundled fallback
};
```

---

## 4. ccusage integration

> **Updated 2026-08-10:** ccusage v20 is a Rust binary. The original embed strategy is removed.
> See ADR-001 (updated) and RESEARCH.md §1 for full context.

### 4.1 Decision: bundled LiteLLM pricing + shell-out reconcile; port abstraction unchanged

```
      ┌──────────────── app/ (knows only ports) ─────────────────┐
      │   PricingPort              BaselineLoaderPort            │
      └──────┬───────────────────────────┬───────────────────────┘
             │                           │
   ┌─────────▼─────────┐      ┌──────────▼──────────┐
   │ pricing.bundled   │      │ baseline.shellout   │
   │ prices.snapshot   │      │ `ccusage daily       │
   │ .json (PRIMARY)   │      │  --json --offline`  │
   └─────────┬─────────┘      │  (PRIMARY, optional)│
             │ fallback        └──────────┬──────────┘
   ┌─────────▼─────────┐                 │ not found
   │ pricing.shellout  │           skip reconcile;
   │ (if binary avail) │           lum doctor reports
   └───────────────────┘
```

**Why bundled pricing.** ccusage v20 has no importable JS pricing module. The LiteLLM price table
it uses internally is publicly available JSON that we vendor at scaffold time. This gives us the
same prices ccusage uses, with no binary dependency on the hot path.

**Why shell-out for reconcile.** The reconcile runs every 5 minutes — not on the hot path.
Process spawn cost (~150–500 ms) is fully acceptable at this cadence. Shell-out also means we
depend only on the stable JSON output interface, not on internal binary APIs.

**Why a port anyway.** The port keeps the adapter swap invisible to the app layer. If ccusage
changes its JSON schema, only `baseline.shellout.ts` changes. If a better pricing source emerges,
only `pricing.bundled.ts` changes. The domain and app layers remain untouched.

### 4.2 How pricing parity is maintained

Three mechanisms, in order of strength:

1. **Single pricing authority.** All four token classes are priced from one `ModelRate` object
   read from the vendored `prices.snapshot.json` (the same LiteLLM table ccusage derives from).
   `domain/pricing.ts` only does arithmetic; it never hardcodes a rate.
2. **Parity test (CI, blocking).** For each fixture, assert
   `|Σ ourTurnCost − ccusageDailyTotal| ≤ max($0.01, 0.5%)`. There is only one loader now
   (`baseline.shellout.ts`), and it needs the ccusage binary — so this test is **conditional**:
   it runs in CI only where ccusage is installed, and is reported as SKIPPED, never as passing,
   where it is not. A ccusage upgrade that changes numbers fails CI loudly on the machines that
   have it.
3. **Runtime drift check.** The Reconciler compares the incrementally-built ledger against a full
   ccusage recompute every 5 minutes, records `lastReconcileDriftUsd`, and **repairs** the ledger from
   the full recompute when drift exceeds tolerance. Drift > 1% sets `degraded` in the snapshot so the
   statusline can show a `~` marker rather than lie silently.

**Offline mandate.** ccusage's pricing fetcher normally pulls the price table over the network. That
would violate constraint #4 and acceptance signal 5. We therefore:
- always run the pricing adapter in **offline mode** (ccusage's cached/offline path), and
- vendor `src/pricing/prices.snapshot.json` with a version stamp as an unconditional fallback, and
- add a **network-free test**: the offline suite runs with outbound sockets stubbed to throw;
  any accidental fetch fails the build.

### 4.3 Edge cases

| Case | Handling |
|---|---|
| **Codex reports no `$`** | Expected — Codex only emits token counts. We always price from tokens (`costMode: calculate`), so Codex and Claude go through the identical code path. No special case beyond the field normalization in §3.1. |
| **Subscription account (no marginal cost)** | Price at API list rates, set `imputed: true`, accumulate into `money.imputedUsd`. Every rendered figure with `imputedUsd > 0` is prefixed `≈` and the `lum today` breakdown prints `imputed at API list rates — not billed`. Acceptance signal 4's amber/red still applies (the budget is a *usage* budget in that mode). |
| **Mixed account** (Claude API key + Codex subscription) | `accountMode` is per-CLI. Snapshot exposes `realUsd` and `imputedUsd` separately; the statusline shows the combined total with `≈` if any part is imputed. |
| **`imputeCostForSubscription: false`** | Subscription CLIs contribute **tokens only**; their USD is 0 and the display switches to a token-based readout for that CLI. Budget is then evaluated on real USD only. |
| **Claude line carries a pre-computed `costUSD`** | Ignored. We always compute (ADR-004) so Claude and Codex are commensurable and offline-deterministic. Divergence between reported and computed is logged at debug level only. |
| **Unknown model id** (new model, stale price table) | Cost contribution 0, model name pushed to `health.unknownModels`, snapshot `degraded: 'unknown-model'`, statusline appends `?`. **Never silently price at zero without a visible marker** — a silent undercount is worse than a visible gap. |
| **ccusage version bump changes a rate** | Parity test fails in CI → deliberate review → `prices.snapshot.json` regenerated in the same PR. |

---

## 5. Real-time update strategy

### 5.1 Pipeline

```
 fs event (chokidar)  ──┐
 safety poll (5 s)    ──┼──► coalesce set<path>
 wake detect          ──┘         │
                                  ▼  debounce 250 ms, maxWait 1000 ms
                          ┌──────────────────┐
                          │ for each path:   │
                          │  stat → cursor   │
                          │  read [off..EOF] │   ← only new bytes
                          │  split on \n     │
                          │  keep remainder  │
                          └────────┬─────────┘
                                   ▼
                        parse → normalize → dedupe
                                   ▼
                        price → fold into ledger
                                   ▼
                 evaluate budget → latch thresholds → notify
                                   ▼
                   atomic write ledger + snapshot (~1 ms)
```

Worst-case observed latency: `debounce 250 ms + parse of a few KB + write` ≈ **well under 1 second**,
against a "few seconds" requirement. Budget headroom is deliberate — fs events on macOS FSEvents can
themselves lag ~100–200 ms.

### 5.2 Watching

**Primary: `chokidar@4`** with `ignoreInitial: true`, watching the two configured roots
non-recursively-globbed (chokidar 4 dropped glob support — we watch directories and filter by
`.jsonl` in the handler). Rationale in ADR-007.

**Always-on safety-net poll (default 5 s), not just a fallback.** Native watching genuinely misses
events: network/virtualised filesystems, macOS after sleep/wake, containers with bind mounts, and
inotify watch exhaustion (`ENOSPC`) on Linux with large `~/.claude` trees. The poll does a cheap
`readdir` + `stat` mtime comparison over candidate files (pre-filtered to files whose mtime is within
the current usage window plus a 6 h grace) and enqueues any file whose `size`/`mtimeMs` differs from
its cursor. Cost is a few dozen `stat` calls — negligible.

`watch.mode: 'auto'` picks fs-watch and demotes to `poll` (1 s interval) permanently if chokidar
errors, `ENOSPC` is seen, or the safety poll catches ≥3 changes the watcher missed. The demotion is
surfaced in `snapshot.daemon.watchMode` so `lum doctor` can explain a sluggish statusline.

### 5.3 Incremental read (tail), rotation-safe

Per-file cursor `{ ino, size, offset, mtimeMs }`.

```
stat(file)
 ├─ ino !== cursor.ino     → file replaced   → offset = 0 (dedupe absorbs re-reads)
 ├─ size <  cursor.offset  → truncated       → offset = 0
 ├─ size === cursor.offset → no-op           → skip
 └─ else                   → read(offset .. size)
                             split on '\n'
                             LAST element without trailing '\n' is a PARTIAL line
                               → buffer it, do NOT advance offset past last '\n'
```

Two properties this buys us:
- **O(new bytes)**, not O(tree). A 400 MB `~/.claude/projects` tree costs nothing per tick.
- **Partial-write safety.** Claude Code appends a line non-atomically; reading mid-line would throw a
  JSON parse error and (worse) skip the turn. Never advancing past the last newline makes the reader
  exactly-once for complete lines.

Discovery of *new* files is cheap because we only `readdir` on watch events plus the safety poll, and
we mtime-prefilter to the current window.

### 5.4 Cold start and day rollover

- **Daemon start:** load persisted ledger for the current `usageDay` if fresh; then run a full
  Reconciler pass (ccusage over the window) to establish the authoritative baseline and rebuild
  cursors at current EOF. Snapshot is published before the reconcile completes, marked
  `degraded: 'stale'`, so the statusline is useful within ~50 ms of daemon start.
- **Day rollover** at `resetHourLocal` (a scheduled timer, recomputed each day so DST shifts are
  honoured): finalize and persist the old ledger, reset thresholds latch, start a new ledger. A turn
  whose timestamp lands in the previous window after rollover is still attributed to the previous
  day's ledger (late writes happen) — the current snapshot is unaffected.
- **Wake detection:** if a 1 s heartbeat timer fires more than 3 s late, assume sleep/suspend →
  force a full rescan + reconcile.

### 5.5 Debounce

Trailing debounce **250 ms**, hard `maxWait` **1000 ms** so a long streaming burst still refreshes
about once a second. Events for multiple files coalesce into one flush and one snapshot write. The
snapshot write is a single atomic rename — readers never observe a torn file.

---

## 6. Statusline integration

### 6.1 How the hook works

Claude Code's `statusLine` is configured in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.localusagemeter/statusline.js",
    "padding": 0
  }
}
```

Claude Code invokes the command on UI refresh (rate-limited to roughly a few hundred ms), pipes a
JSON context object on **stdin** (session id, transcript path, cwd, model info, and in recent
versions a session cost block), and renders the **first line of stdout** as the statusline. ANSI SGR
colour codes are honoured. Non-zero exit or a hang degrades the statusline (stderr goes to the Claude
Code log).

> `VERIFY-03`: the precise stdin field names and the refresh cadence must be confirmed against the
> installed Claude Code version during Phase 3 (PO open question #3). Our design deliberately does
> **not depend on any stdin field** — see below — so a schema change cannot break us.

### 6.2 Our contract

| Property | Guarantee |
|---|---|
| Exit code | **Always 0.** Every failure path prints a valid degraded line instead. |
| stdout | Exactly one line, `\n`-terminated. |
| stderr | Diagnostics only; never affects the rendered line. |
| stdin | **Ignored.** Read is not attempted, so the process cannot block waiting on a pipe that is never written. All data comes from the snapshot. |
| Latency | Target < 30 ms; internal hard budget 150 ms with a self-timeout that prints the degraded line. |
| Imports | `node:fs` only. No ccusage, no zod, no colour library (ANSI codes inlined). |
| Network | None, structurally — the file contains no network primitive. |

Pseudo-implementation (the whole hot path):

```js
#!/usr/bin/env node
// ~/.localusagemeter/statusline.js  — thin reader, never parses a log
try {
  const s = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const age = (Date.now() - Date.parse(s.updatedAtUtc)) / 1000;
  process.stdout.write(render(s, age) + '\n');
} catch {
  process.stdout.write('lum —\n');          // never break the user's statusline
}
process.exit(0);
```

### 6.3 Rendered output

```
green  (<80%)   today $3.20 / $10.00 (32%) ▓▓░░░
amber  (>=80%)  today $8.40 / $10.00 (84%) ▓▓▓▓░        (yellow)
red    (>=100%) today $11.90 / $10.00 (119%) ▓▓▓▓▓       (red)
imputed         today ≈$3.20 / $10.00 (32%) ▓▓░░░
stale > 60 s    today $3.20 / $10.00 (32%) ▓▓░░░ ⋯
no daemon       today $3.20 / $10.00 (32%) ▓▓░░░ (paused)
unknown model   today $3.20 / $10.00 (32%) ▓▓░░░ ?
cold / no data  lum —
```

Colour is emitted unless `NO_COLOR` is set or `display.color === false`.

### 6.4 Daemon liveness from a stateless hook

The statusline is the most common trigger, but it must not become the compute path. Resolution:

```
statusline.js
  ├─ snapshot fresh (< 60 s)          → print, exit          (99% of calls)
  ├─ snapshot stale or missing
  │    └─ daemon.lock pid alive?      → print with '⋯'
  │         └─ no  → spawn detached `lum watch --daemon`, print '(starting)'
  └─ spawn throttled: at most 1 attempt / 30 s via a marker file mtime
```

The spawn is `detached: true, stdio: 'ignore', unref()` so the hook returns immediately (< 5 ms
overhead) and never inherits Claude Code's lifetime. `lum service install` (launchd on macOS,
systemd --user on Linux) is offered as the tidier alternative in Phase 5. This makes the whole
product zero-configuration: install the statusline, and the meter starts itself.

---

## 7. Phase sequencing

```
 PRE ── sample logs supplied (§10 gate)
  │
  ├─► P1 Core reader + pricing ──┬─► P2 Live loop ──┬─► P3 Statusline
  │   domain/ + readers/ +       │   watch/ store/  │   bin/statusline.js
  │   ccusage adapters           │   daemon         │   liveness/spawn
  │                              │                  │
  │                              └──────────┬───────┴─► P4 Budget + alerts
  │                                         │            thresholds, latch,
  │                                         │            notifier, colours
  │                                         │                  │
  │                                         └──────────────────┴─► P5 Breakdown UI
  │                                                                 --live TUI,
  │                                                                 lum today table
  └────────────────────────────────────────────────────────────────► P6 (stretch)
                                                                      tray, reconcile,
                                                                      rollup shipper
```

| Phase | Builds | Depends on | Exit criteria |
|---|---|---|---|
| **P1 — Core reader + pricing** | `domain/*`, `readers/claude-jsonl`, `readers/codex-jsonl`, `readers/tail`, `ccusage/pricing`, `ccusage/baseline`, `lum today` one-shot | sample logs | `lum today` prints `today $X / $BUDGET (P%)`; parity test vs ccusage green; dedup + Codex-cumulative + reasoning-subset tests green (acceptance signals 2, 3) |
| **P2 — Live loop** | `watch/*`, `store/*`, `app/daemon`, Reconciler, ledger + snapshot persistence | P1 | Appending a turn to a fixture file updates the snapshot in < 1 s; kill -9 during write leaves a valid snapshot; drift check reports 0 (acceptance signal 1) |
| **P3 — Statusline** | `bin/statusline.js`, `render/statusline`, liveness/self-spawn, `lum install-statusline` | P2 (needs snapshot) | < 30 ms p95; exit 0 on every injected fault (missing/corrupt/stale snapshot, no daemon); manual end-to-end in real Claude Code |
| **P4 — Budget + thresholds** | `domain/budget`, `ThresholdLatch`, `notify/*`, config schema completion, amber/red | P2 for the latch; P3 for the visible colour | Crossing 0.8 then 1.0 flips colour and fires exactly one notification each, no repeats across daemon restart (acceptance signal 4) |
| **P5 — Breakdown UI** | `render/live` (`lum --live`), `render/table`, per-CLI/per-model, `lum doctor`, `lum service install` | P2; reads the same snapshot as P3 | Live dashboard redraws on snapshot change; per-CLI and per-model figures reconcile to the total exactly |
| **P6 — Stretch** | tray/menu-bar, once-daily console reconciliation with `±`, rollup shipper (metadata only) | P5 | Out of v1 scope. **The shipper stays behind an explicit opt-in flag and must not be wired into the daemon in v1** (constraint #4). |

**Critical path: PRE → P1 → P2 → P3.** That chain alone satisfies acceptance signals 1, 2, 3 and 5.
P4 and P5 both hang off P2 and can be built in parallel by different agents once the snapshot shape
is frozen at the end of P2 — **freeze `Snapshot` at the P2/P3 boundary** and treat it as the internal
API contract.

Offline verification (acceptance signal 5) is not a phase — it is a **CI gate applied from P1
onward** (network-stubbed test suite).

---

## 8. Key decisions and trade-offs (ADRs)

### ADR-001 — Shell-out to ccusage Rust binary for reconcile; bundled LiteLLM JSON for pricing

> **Updated 2026-08-10:** Original decision (embed ccusage as JS library) is not implementable.
> ccusage ≥ v20 is a compiled Rust binary with no JS subpath exports. See RESEARCH.md §1.

- **Decision.** Use `pricing.bundled.ts` (reads vendored `src/pricing/prices.snapshot.json`) as the
  primary `PricingPort` adapter. Use `baseline.shellout.ts` (spawns `ccusage daily --json --offline`)
  as the primary `BaselineLoaderPort` adapter. The reconcile baseline is gracefully optional —
  skipped if ccusage binary is not on PATH. `@ccusage/codex` is removed (deprecated). The port
  abstraction (`PricingPort`, `BaselineLoaderPort`) is unchanged.
- **Rationale.** ccusage v20 ships as platform-specific Rust binaries (`@ccusage/ccusage-darwin-arm64`
  etc.) with only a thin JS CLI launcher. No `import`-able exports exist. The hot path (tail reader)
  never needed ccusage at all — it parses JSONL directly. The reconcile runs every 5 minutes and
  tolerates the ~150–500 ms spawn cost. Pricing from the bundled LiteLLM JSON is offline,
  deterministic, and already designed as the fallback — it becomes the primary.
- **Adapter hierarchy:**
  ```
  PricingPort
    PRIMARY:  pricing.bundled.ts     (reads prices.snapshot.json — no binary needed)
    FALLBACK: pricing.shellout.ts    (ccusage pricing --json, if binary available)

  BaselineLoaderPort
    PRIMARY:  baseline.shellout.ts   (ccusage daily --json --offline — optional)
    FALLBACK: null / skip reconcile  (lum doctor reports "no reconcile baseline")
  ```
- **Rejected.** *Vendoring ccusage Rust source* — requires a Rust toolchain on install.
  *Re-implementing JSONL parsing from scratch* — prohibited by constraint #1 (and we do implement
  our own tail reader, but we use ccusage as the correctness cross-check via shell-out).
- **Consequences.** `prices.snapshot.json` must be vendored at scaffold time (one-time, dev action).
  If ccusage is not installed, reconcile is skipped and lum doctor says so. `VERIFY-04` simplifies
  to: confirm `ccusage daily --json --offline` output schema and version.

### ADR-002 — One writer daemon + atomic snapshot; all UIs are dumb readers
- **Decision.** A single `lum` daemon owns parsing, pricing, aggregation, persistence and
  notifications. Statusline, TUI, `lum today` and the notifier read `state/today.json`. Single-writer
  is enforced by a pid lockfile.
- **Rationale.** Claude Code calls the statusline hook every few hundred ms; doing any parsing there
  would burn CPU continuously and blow the latency budget. It also gives us one place for the dedup
  set, the threshold latch and cursor state — all of which are inherently stateful and cannot be
  reconstructed correctly by concurrent processes.
- **Rejected.** *Compute-in-statusline* (stateless, simplest to install — but O(tree) per keystroke
  refresh, no way to latch a notification exactly once, and no dedup memory). *IPC via unix socket*
  (lower latency but adds a connection lifecycle, a protocol, and a hang risk on the hook path; a
  2 KB file read is already ~1 ms). *Multi-writer with file locking* (lock contention on the hot path,
  and cross-platform advisory locking is a swamp).
- **Consequences.** We must handle daemon liveness, stale locks, and self-start (§6.4). Snapshot
  freshness becomes a first-class displayed concept.

### ADR-003 — Incremental byte-offset tail on the hot path; periodic full ccusage recompute as anchor
- **Decision.** Deltas come from our own rotation-safe tail reader over new bytes. Every 5 minutes
  (and at start, day rollover, and wake) the Reconciler runs the full ccusage load over the current
  window and repairs the ledger if drift exceeds tolerance.
- **Rationale.** Full re-parse per event is O(entire log tree) — seconds on a mature `~/.claude`,
  which fails the "few seconds" requirement under load and pegs a core. Tail-only would accumulate
  silent drift from any parser gap. The hybrid is fast *and* self-correcting, and the drift number is
  itself a shippable health signal.
- **Rejected.** *Full recompute every tick* (simple, correct, too slow). *Tail only* (fast, silently
  wrong over time). *Watch-and-invalidate a per-file cache* (a middle ground, but still O(files
  touched today) and does not solve dedup across files).
- **Consequences.** Two code paths that must agree — which is exactly what the parity + drift tests
  assert. Note this does **not** violate constraint #1: we never tokenize; ccusage remains the
  parsing and pricing authority, and our tail reader reads the same provider-reported `usage` fields
  from the same lines.

### ADR-004 — Always compute cost from tokens, offline, with a vendored price snapshot
- **Decision.** `costMode: calculate`. Ignore any pre-computed `costUSD` in Claude logs. Pricing runs
  in ccusage's offline mode with `src/pricing/prices.snapshot.json` as an unconditional fallback.
  Refreshing the price table is an explicit, user-initiated, opt-in `lum pricing update` — never
  automatic.
- **Rationale.** Constraint #4 and acceptance signal 5 make any implicit network call a defect.
  Codex emits no cost at all, so a token-based computation is required regardless; using it for both
  CLIs makes the two commensurable and makes imputed vs real a labelling concern rather than a
  computation fork.
- **Rejected.** *`auto` mode* (prefers reported cost when present → Claude and Codex priced by
  different mechanisms, and the number changes depending on which Claude Code version wrote the log).
  *Live price fetch* (violates constraint #4). *Hardcoded rates* (guaranteed to rot; violates the
  ccusage-as-pricing-authority constraint).
- **Consequences.** Prices go stale between updates. `lum doctor` shows the snapshot version and its
  age; unknown models are surfaced rather than silently zero-priced.

### ADR-005 — JSON files for all persistence; no SQLite in v1
- **Decision.** `~/.localusagemeter/{config.json, daemon.lock, state/today.json,
  ledgers/<day>.json, ledgers/<day>.seen.json, pricing/}`. All writes are tmp-file + `fsync` +
  `rename`. 35-day retention, pruned at rollover.
- **Rationale.** The working set is one day of aggregates plus a few thousand dedup keys. There is
  exactly one writer, so we need no concurrency control, no transactions, no query engine. Atomic
  rename gives crash safety for free, and every file is human-inspectable — a real support advantage
  for a local dev tool.
- **Rejected.** *`node:sqlite`* (built-in from Node 22.5, but raises the runtime floor and adds
  schema migrations for zero v1 benefit). *`better-sqlite3`* (native build on install — breaks
  "setup is trivial"). *Append-only event log of TurnRecords* (nice for future analytics, but
  unbounded growth and a compaction story we do not need yet).
- **Consequences.** Historical trend queries (a likely P6 ask) would mean scanning up to 35 JSON
  files. That is fine at this scale; if history becomes a product surface, migrate then — the
  `StorePort` seam makes it a one-adapter change.

### ADR-006 — Six-field token model with per-CLI normalization at the boundary
- **Decision.** Normalize both CLIs into `TokenCounts` (§3.1) at the reader boundary. `reasoning` is
  stored but never priced. Cache-write TTL split is honoured when the log provides it, otherwise all
  cache creation is priced at the 5-minute (1.25×) rate.
- **Rationale.** Constraint #2 names cache-bucket collapse as the top accuracy bug. The subtler traps
  are directional: Anthropic's `input_tokens` *excludes* cache reads while OpenAI's *includes* them,
  and OpenAI's `output_tokens` *includes* reasoning. Handling these anywhere other than one
  normalization boundary guarantees they get re-broken later. Defaulting unknown cache writes to
  1.25× under-states rather than over-states cost — the honest direction for a budget tool is to be
  conservative *about the user's remaining budget*, but here 1.25× is also simply the common case
  (Claude Code's default cache TTL is 5 minutes).
- **Rejected.** *Four fields exactly as the PO listed* (cannot represent the 1.25×/2× split the PO
  themselves named, and cannot show reasoning in the breakdown). *Carrying raw provider shapes into
  the domain* (pushes CLI-specific traps into pricing and aggregation).
- **Consequences.** Each new CLI needs a normalizer + a golden fixture, nothing else. The four
  *priced* classes remain exactly as specified.

### ADR-007 — `chokidar@4` + an always-on safety poll; plain-ANSI TUI
- **Decision.** Watching: chokidar as primary, plus an unconditional 5 s mtime safety poll, plus
  automatic permanent demotion to 1 s polling on watcher failure. Rendering: hand-rolled ANSI with
  `picocolors`, single alternate-screen redraw loop driven by snapshot changes.
- **Rationale.** Raw `fs.watch` recursive semantics differ across macOS (FSEvents), Linux (inotify,
  recursive only recently and with `ENOSPC` limits) and Windows; chokidar has absorbed a decade of
  those edge cases with no native build step. But no watcher is reliable enough alone for a tool
  whose whole value is "the number is current" — hence the safety poll. For the TUI, `ink` means a
  React runtime and ~100 ms extra start for one static screen.
- **Rejected.** *Raw `fs.watch`* (platform matrix we would re-learn the hard way). *`@parcel/watcher`*
  (fastest, but a native postinstall binary). *Poll-only* (simple and robust, but wastes CPU at the
  cadence needed for sub-second latency). *`ink`/`blessed`* (weight / unmaintained).
- **Consequences.** One more dependency in the daemon (never on the statusline path). Watch mode is
  observable in the snapshot and in `lum doctor`.

### ADR-008 — Zero-dependency notifier, latched per threshold per usage-day
- **Decision.** `notify()` shells out per platform — macOS `osascript -e 'display notification …'`,
  Linux `notify-send`, Windows PowerShell toast — with a terminal-bell + stderr fallback and a
  user-overridable `notifications.command`. Fired only by the daemon, only on an upward crossing, at
  most once per threshold per usage-day, latched in `thresholdsFired` so a daemon restart cannot
  re-fire.
- **Rationale.** `node-notifier` bundles platform binaries and is effectively unmaintained; the
  underlying commands are three one-liners. Persisting the latch is what makes acceptance signal 4
  trustworthy — an unlatched implementation re-alerts on every restart and users disable it.
- **Rejected.** *`node-notifier`* (weight, staleness, bundled binaries). *In-memory latch* (re-fires
  after restart). *Alerting from the statusline process* (stateless — cannot latch; would spam).
- **Consequences.** Notification text is intentionally minimal and contains no prompt, path or project
  name, satisfying constraint #4. Wording varies by account type per ratified A+C hybrid (Q3):
  API account: `LocalUsageMeter — 80% of daily budget ($8.00/$10.00)`
  Subscription: `LocalUsageMeter — 80% of daily usage allowance (≈$8.00/$10.00)`
  The distinction is a single string interpolation in `notify/notifier.ts`.

### ADR-009 — Privacy by construction, tested
- **Decision.** Parsers whitelist fields (never object-spread a parsed line). No content field is
  ever assigned to a `TurnRecord`. No network primitive (`fetch`, `node:http`, `node:https`,
  `node:net`, `undici`) may appear in shipped source outside the opt-in P6 shipper, enforced by a
  lint rule **and** a build-artifact grep test. A CI test writes a full run against fixtures
  containing canary strings and asserts no canary appears in any produced file.
- **Rationale.** Constraint #4 is absolute and is the reason a developer will trust this on a work
  machine. "We didn't write any network code" is an assertion; a failing test is a guarantee.
- **Rejected.** *Policy-only enforcement* (drifts silently the first time someone adds telemetry).
- **Consequences.** The P6 rollup shipper must live in a separate, explicitly-installed package so
  the core package stays structurally network-free.

---

## 9. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | **ccusage internal API drift** — subpath exports or return shapes change on upgrade, breaking the baseline loader or pricing adapter. | High | Medium | Exact version pin (no `^`); all contact confined to `adapters/ccusage/*`; blocking CI parity test on every upgrade; shell-out adapter behind the same port as a same-day escape hatch. |
| **R2** | **Double counting** — Claude assistant messages duplicated across session files (resume/compact/branch) and Codex `total_token_usage` being cumulative inflate today's number by 2–3×. | High | **High** — directly breaks acceptance signals 2 and 3 and destroys trust. | Dedup key on `message.id` + `requestId`; Codex consumes `last_token_usage` (or diffs consecutive totals) and never sums totals; golden fixtures containing a resumed session and a multi-event Codex session; parity test vs ccusage catches regressions. |
| **R3** | **Cache-bucket / reasoning misattribution** — Anthropic excludes cache reads from `input_tokens`, OpenAI includes them; OpenAI's `output_tokens` includes reasoning. Getting a sign wrong shifts cost by up to ~10× on the affected bucket. | Medium | **High** | Single normalization boundary (ADR-006); per-CLI unit tests asserting the directionality explicitly; `VERIFY-01/02` against real sample logs before P1 is accepted; parity test vs ccusage as an independent check. |
| **R4** | **Statusline latency / hang** — a slow or blocking hook degrades or freezes the Claude Code UI, the primary surface. | Medium | High | Statusline imports only `node:fs`, reads one < 2 KB file, ignores stdin (cannot block on a pipe), always exits 0, self-timeout at 150 ms; fault-injection tests for missing/corrupt/stale snapshot and dead daemon; p95 latency assertion in CI. |
| **R5** | **Missed filesystem events** — sleep/wake, network or virtualised FS, container bind mounts, inotify `ENOSPC` → the number silently stops updating while still looking live. | Medium | High (silent staleness is worse than visible failure) | Always-on 5 s mtime safety poll independent of the watcher; wake detection via heartbeat drift; automatic permanent demotion to polling; snapshot age surfaced as `⋯` in the statusline past 60 s; `lum doctor` explains the current watch mode. |
| **R6** | **Pricing staleness / unknown model** — a newly released model is absent from the vendored offline price table and is priced at $0, silently undercounting. | Medium | Medium | Unknown models never silently zero: recorded in `health.unknownModels`, snapshot marked `degraded`, statusline appends `?`; `lum doctor` lists them; `lum pricing update` is an explicit opt-in refresh; price snapshot version + age always visible. |
| **R7** | **Log format change** in a Claude Code or Codex release breaks parsing mid-flight. | Medium | High | Schema-validated parsing with a per-line failure counter rather than a crash; `health.parseErrors > 0` surfaces as `degraded`; ccusage reconcile acts as an independent second opinion (if ccusage still parses and we don't, drift spikes and we repair from ccusage); fixtures versioned per CLI release. |

---

## 10. Pre-build prerequisites

**Gate: SCAFFOLD is unblocked; VERIFICATION is not.** Nothing blocks `a0b2098a`. But every
accuracy claim in §3.1 — the six-field normalization that the whole cost figure rests on — is
still derived from documentation, not from a log. PRE-1 is a soft dependency for the scaffold and
a hard one for anything that claims to be correct.

| # | Prerequisite | Owner | Blocks | Status |
|---|---|---|---|---|
| **PRE-1** | **One real, scrubbed Claude Code log**: `~/.claude/projects/<proj>/<session>.jsonl`. Keep `message.id`, `requestId`, `message.model`, `message.usage.*`, `timestamp`, `type`; replace all text content with `"[scrubbed]"`. Must include at least one cache hit (`cache_read_input_tokens > 0`). | Human | `46e3230b` golden tests only | **PENDING** — supply before step 2b |
| **PRE-2** | ~~Scrubbed Codex log~~ | — | — | **RESOLVED** — ARCH_QUESTION 2 closed; Codex reader uses documented schema + defensive normalization + provisional marking in `lum doctor` |
| **PRE-3** | **Duplicated-session Claude fixture** (same `message.id` in two `.jsonl` files) | Builder | P1 dedup test | **Builder-generated** — synthesize from PRE-1 by copying one line into a second file |
| **PRE-4** | **`VERIFY-01`** — from PRE-1, confirm Claude `input_tokens` excludes `cache_read_input_tokens`; confirm 5m/1h cache creation split presence | Builder | `46e3230b` golden tests | **PENDING** — cannot be confirmed before PRE-1 supplies the log it reads. Previously marked "Confirmed via real log" while PRE-1 was still outstanding; no such log was ever supplied. |
| **PRE-5** | ~~`VERIFY-02`~~ — Codex token semantics | — | — | **RESOLVED** — handled by unconditional defensive normalization: `inputUncached = input_tokens − cached_input_tokens`; consume `last_token_usage` never `total_token_usage` sum |
| **PRE-6** | **`VERIFY-03`** — Claude Code `statusLine` hook contract (settings key, stdin schema, refresh cadence) | Builder | P3 only | **PARTIALLY CONFIRMED** — RESEARCH.md §3 has the full stdin schema; `process.stdin.destroy()` pattern recommended |
| **PRE-7** | **`VERIFY-04` (simplified)** — confirm `ccusage daily --json --offline` output schema; confirm ccusage version for README | Builder | `415dc77e` reconciler | Simpler now: no subpath exports to find |
| **PRE-8** | **Repo scaffold** | Builder | P1 | **START HERE** — task `a0b2098a` |
| **PRE-9** | **Vendor `prices.snapshot.json`** at scaffold time | Builder | P1 pricing | One command: `ccusage pricing --json > src/pricing/prices.snapshot.json` or curl from LiteLLM |
| **PRE-10** | **Human sign-off on the constraint-#1 inversion** (§0). The PO required ccusage to parse both CLIs and to price; the design now does neither on the primary path. Forced by RESEARCH.md §1, ratified by the evaluator — never by the human who set it. | Human | Nothing technically; it is a scope acceptance | **PENDING** — one line, before P1 ships |

---

## Appendix A — On-disk layout

```
~/.localusagemeter/
  config.json                  user-owned, hot-reloaded
  daemon.lock                  { pid, startedAt, version }
  statusline.js                installed copy (or a shim to the package bin)
  state/
    today.json                 Snapshot — the ONLY file readers touch
    spawn-attempt              mtime-based throttle marker
  ledgers/
    2026-08-10.json            DailyLedger (35-day retention)
    2026-08-10.seen.json       dedup key set
  pricing/
    prices.snapshot.json       vendored offline price table + version
  logs/
    daemon.log                 rotated, diagnostics only, never content
```

## Appendix B — CLI surface

```
lum today            one-shot readout + per-CLI/per-model breakdown   (P1/P5)
lum watch [--daemon] start the live loop                              (P2)
lum --live           full-screen dashboard                            (P5)
lum statusline       print one statusline row (same as bin shim)      (P3)
lum install-statusline   patch ~/.claude/settings.json (with backup)  (P3)
lum service install|uninstall   launchd / systemd --user unit         (P5)
lum doctor           paths, watch mode, snapshot age, pricing version,
                     unknown models, parse errors, last drift         (P5)
lum pricing update   explicit, opt-in price table refresh             (P4)
```

Argument parsing via `node:util` `parseArgs` — no CLI framework dependency.

## Appendix C — Test strategy anchors

- **Golden fixtures** per CLI: raw `.jsonl` in → pinned `DailyLedger` JSON out.
- **Parity test:** our total vs ccusage total, both loaders, tolerance `max($0.01, 0.5%)`.
- **Trap tests:** duplicated Claude message; Codex cumulative totals; reasoning-subset;
  cache-read directionality per CLI.
- **Offline test:** whole suite with sockets stubbed to throw.
- **Privacy test:** canary strings in fixtures must not appear in any written artifact.
- **Fault injection:** corrupt/missing/stale snapshot, dead daemon, truncated log mid-line,
  file replaced (inode change), clock jump across `resetHourLocal`, DST transition day.
- **Latency test:** statusline p95 < 30 ms over 200 invocations.

---

_Open product questions are recorded in
`pathly/features/local-usage-meter/feedback/HUMAN_QUESTIONS.md`._
