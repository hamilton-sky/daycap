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

### `license` is `UNLICENSED`, and there is no `LICENSE` file

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

Whatever is chosen needs the `license` field changed *and* a `LICENSE` file added — the field alone
is not the grant.

### `engines` requires Node 22, and nothing in the code seems to need it

```json
"engines": { "node": ">=22" }
```

Grepping for anything 22-only — `node:sqlite`, the stable test runner, `--experimental` flags —
found **nothing**. Older planning documents said `>=20.11`, so this floor may have drifted upward
without a reason attached to it.

It is not free: Node 20 is still in maintenance LTS and a `>=22` floor makes `npm i -g` fail outright
for those users, which is a strange first impression for a tool selling zero setup.

Deliberately **not changed here.** Lowering an engines floor is a compatibility claim, and this scan
has no evidence for it — nothing 22-only being *visible* is not the same as the suite passing on
Node 20. The honest next step is to add a Node 20 leg to the CI matrix and let it answer; if it is
green, lower the floor, and if it is red, the floor gets a comment saying which test needs 22.

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
