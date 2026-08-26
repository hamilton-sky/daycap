# The `UsageSourcePort` contract

Every source adapter runs the **same** suite. That is the whole point: `P1-3` exists so a collector
can be swapped without touching `app/`, and a contract that each adapter interprets its own way
does not deliver that.

## Adding an adapter

Three lines, plus a harness:

```ts
// test/contract/ccusage.contract.test.ts
import { ccusageHarness } from "./ccusage.harness.ts";
import { runUsageSourceContract } from "./usage-source.contract.ts";

runUsageSourceContract(ccusageHarness);
```

The harness is the real work. It must arrange **four worlds**, because five of the cases are
assertions about the world around the adapter rather than about its return values:

| Scenario  | What the harness must arrange                          | Cases |
|-----------|--------------------------------------------------------|-------|
| `present` | collector installed, holding the corpus                | most  |
| `absent`  | collector not installed at all                         | C2    |
| `hanging` | collector installed but never answers                  | C11a/b |
| `garbage` | collector answers with something that isn't its schema  | C12   |

## The corpus is shared, and that is not negotiable

`test/fixtures/collector/CORPUS.json` is the adapter-independent ground truth. The in-memory fake
and every real adapter's fixtures encode **the same** rows, windows and totals.

**When a real adapter and the fake disagree, the fake is right and the adapter has a bug.**

If a harness brings its own private corpus, this stops being a contract and becomes several
unrelated test files that happen to import the same helper. Resist it.

## Things the corpus is carrying on purpose

- **Closed-past windows only.** An adapter that ignores the window and always answers "today"
  passes a naive two-window test whenever the corpus happens to be today's. Closed-past windows
  make that adapter fail regardless of the day CI runs.
- **Two boundary probes.** One row sits exactly on `narrowDay`'s exclusive `to`, another on
  `narrowInstant`'s. Half-open `[from, to)` must exclude both. Without a probe on the edge that a
  given granularity actually asserts, a `<=` bug passes every case — verified by mutation, and the
  instant probe was added *because* the first version missed it.
- **The inconsistency trap** (`C9b`): `$1.23` against 5,000,000 tokens. No price table on earth
  produces that. An adapter that derives USD from tokens cannot land on `1.23` whatever table it
  used — which turns "no re-pricing" from an unobservable intention into a failing test.
- **An unpriceable row** (`C9c`): tokens present, cost absent, and the adapter must surface
  `usd: null`. Never `0`. This is why `ToolSpend.usd` is nullable.
- **Canaries** (`C13`): strings seeded through the fixtures that must never appear on a returned
  object.

## Money is asserted in integer cents

The original C9 tolerance of `< 1e-9` on a *sum* is simultaneously too loose (float drift
accumulates across rows) and too weak (it cannot tell passthrough from a price table that happens
to agree). Everything goes through `toCents()`.

## Skips must carry a reason

`SourceHarness.skips` is typed `Partial<Record<CaseId, string>>` — the string is required. A skip
without a written reason is how a suite quietly stops covering the thing it was written for. The
in-memory fake skips `C11b` and `C14b` because it never spawns a child process.

## Where four cases went

- **C2's PATH-stripping half** → an integration test. `PATH=''` does not fail uniformly across
  platforms (Windows resolves `.exe` via `PATHEXT`), so the contract uses an injected
  `resolveBinary: () => null` instead.
- **C6's "canonical kebab set"** → split. A canonical map *is* a per-tool branch, which `P1-1`
  forbids anywhere in `src/`. The contract asserts syntactic normalisation plus verbatim
  passthrough of unknown ids; per-adapter alias maps live in that adapter's own unit tests.
- **C13's socket half** → `test/gates/network.test.ts` (`P1-9`). It is a process-global property;
  running it once per adapter is both slow and the wrong place.
- **C14's "no `Date.now()`"** → you cannot observe the absence of a clock read. Replaced by two
  positive mechanisms (two clocks 400 days apart, TZ perturbation across a +14/−11 span) plus a
  static import gate in `P1-9`.
