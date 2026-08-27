# License scan — `P4-6`

**Run 2026-08-27** against `main` @ `7664f55`. Re-run before any release; the method is at the
bottom so the numbers can be reproduced rather than trusted.

---

## 1. The published artifact carries no third-party code at all

This is the finding that makes the rest of the scan short.

`package.json` `files` publishes exactly three things — `dist/`, `src/bin/statusline.js`, and
`src/bin/guard.js` — and **`dependencies` is empty**. Not "small": empty. `pnpm list --prod
--depth Infinity` returns nothing.

Verified at the artifact rather than at the manifest, because a manifest describes intent and a
bundle describes fact:

| Shipped file | Modules it pulls in | Third-party |
|---|---|---|
| `dist/lum.js` | `node:module`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`, `node:child_process`, `node:timers/promises` | **none** |
| `src/bin/statusline.js` | `node:fs`, `node:os`, `node:path`, `node:url` | **none** |
| `src/bin/guard.js` | `node:fs`, `node:os`, `node:path`, `node:url` | **none** |

So the runtime license surface is our own license plus Node itself. There is nothing to attribute,
nothing to vendor, and no transitive obligation to track.

That is a consequence of the architecture rather than a coincidence: ADR-v2-001 says consume a
collector instead of parsing logs, which is what removes the parser, the watcher and the date
library that would each have arrived with a license. The hot-path import gate
(`test/gates/imports.test.ts`) is what keeps it true — `statusline.js` and `guard.js` may import
four `node:` modules and nothing else, and the build fails otherwise.

**One methodological note, because the first attempt got this wrong.** A regex for `from "…"` over
the bundle reported a third-party module called `the collector confirms zero spend`. That is prose
from a comment in `resolve.ts`, surviving into the bundle because tsdown preserves comments. The
scan strips comments before matching. A license scan that reports a false positive is a license scan
someone stops reading, so the stripping is part of the method, not a tidy-up.

## 2. The dev tree is entirely permissive

Not distributed — recorded because "we checked" is worth being able to say with a number.

**146 distinct packages** across the whole pnpm store:

| Count | License |
|---|---|
| 117 | MIT |
| 13 | ISC |
| 6 | BSD-3-Clause |
| 5 | BlueOak-1.0.0 |
| 3 | Apache-2.0 |
| 2 | MIT OR Apache-2.0 |

**Nothing copyleft, source-available, or unstated.** No GPL / AGPL / LGPL, no SSPL, no BUSL, no
CC-BY-NC, and no package with a missing or `UNLICENSED` field.

## 3. `ccusage` is spawned, never redistributed

`ccusage@20` is **MIT**, across its own tree.

It matters less than it looks: we never bundle or re-ship it. `lum` spawns whatever the user
installed, and the README tells them to install it themselves. There is no redistribution, so no
attribution obligation attaches to our artifact — the MIT note here is for completeness, and because
a reader who sees us recommend an install will reasonably want to know what it is.

---

## 4. Two things this scan cannot decide

Both are the owner's call, both block release, and neither is a code change.

### ~~`license` is `UNLICENSED`, and there is no `LICENSE` file~~ — RESOLVED 2026-08-27: MIT

```json
"license": "UNLICENSED"
```

This is the real blocker in this section. `UNLICENSED` is not a placeholder meaning "not decided" —
it is a positive statement that nobody may use the software. Publishing a public repo with it says
"you may read this and may not run it", which is almost certainly not the intent for a tool whose
whole pitch is that people install it in one command.

Recommendation, not a decision: **MIT**. It matches all 146 dev packages, it matches `ccusage`,
it is what the ecosystem this tool lives in expects, and it imposes nothing on us. Apache-2.0 is
the reasonable alternative if patent language is wanted.

**Resolved: MIT.** Both halves done — the `license` field and a `LICENSE` file, because the field
alone is not the grant. `npm pack --dry-run` confirms `LICENSE` is in the tarball (npm includes it
regardless of `files`, but "npm probably does that" is not the same as having looked).

### ~~`engines` requires Node 22~~ — RESOLVED 2026-08-27: `>=20.11`, with a CI job behind it

```json
"engines": { "node": ">=22" }
```

Grepping for anything 22-only — `node:sqlite`, the stable test runner, `--experimental` flags —
found **nothing**. Older planning documents said `>=20.11`, so this floor may have drifted upward
without a reason attached to it.

It is not free: Node 20 is still in maintenance LTS and a `>=22` floor makes `npm i -g` fail outright
for those users, which is a strange first impression for a tool selling zero setup.

**Resolved by getting the evidence rather than arguing.** A `node20-compat` CI job now installs
under 22 and runs typecheck plus tests under 20; the floor is `>=20.11`.

Two things that job found, both worth knowing:

- **pnpm cannot run on Node 20 at all.** `pnpm@11.23.0` imports `node:sqlite`, absent before Node 22,
  so the first attempt — a `node: [20, 22]` matrix dimension — died inside `pnpm/action-setup` before
  reaching any of our code. The question was never asked, let alone answered. Hence install-under-22,
  run-under-20. The constraint is the toolchain's, not the product's: nobody installing `lum` uses
  pnpm.
- **626 of 648 tests passed on Node 20**, and the one failure was the test HARNESS: the SIGKILL
  atomicity case spawns a child importing `atomic.ts` under `--experimental-strip-types`, a Node 22.6
  flag. It now skips below 22 with that reason in the code. Raising the floor for every consumer to
  accommodate one test's harness would have been the tail wagging the dog.

A third, unrelated thing it exposed is recorded in §6.

---

## 5. Method

```bash
# 1. Is anything shipped at all beyond our own code?
node -e 'console.log(require("./package.json").dependencies ?? "NONE")'
pnpm list --prod --depth Infinity

# 2. What does the built artifact actually import? (comments stripped first)
#    See §1 — the un-stripped version produces false positives from prose.

# 3. Whole-store license tally, walking node_modules/.pnpm
#    (pnpm licenses list reports nothing useful here precisely because the prod tree is empty)

# 4. The spawned collector
npm view ccusage@20 license --json
```

---

## 6. A side-effect worth recording: `layer C` is contention-sensitive

Not a license finding. It belongs here because this scan's own follow-up work is what surfaced it.

Doubling the CI matrix to test Node 20 took the job count from three to six, and
`layer C — absolute wall clock is < 150ms p95` failed on the Windows runner at **188.5 ms** — on a
commit that touched only CI config and a version string. It had passed on the two PRs immediately
before. Reverting to three jobs made it pass again.

So layer C is partly measuring how busy the runner is. That is the same defect `a7dee06` fixed for
layer B, arriving from the other direction — and this time it was my own change to the harness that
perturbed what the harness measures.

Deliberately **not** patched. The 150 ms is a claim about the latency a user's prompt waits for, not
a threshold to raise until the build is green. Options are written up for a decision.
