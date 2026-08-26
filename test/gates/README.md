# Structural gates (P1-9)

Three assertions that land in P1 and stay green forever. They exist because the rules they enforce
are **one careless change away from being undone, in a way that would look reasonable in review.**

| Gate | File | Enforces |
|---|---|---|
| Imports | `imports.test.ts` | ADR-v2-001 — consume a collector, never parse a log |
| Network | `network.test.ts` + `../setup/network-guard.ts` | no server, no proxy, no egress |
| Privacy | `privacy.test.ts` | ADR-v2-004 — no user data on any surface |
| Bin wiring | `bin.test.ts` | the declared binaries actually exist and run |

## 1. Imports

Nothing under `src/` may import a transcript watcher (`node:readline`, `chokidar`, `tail`,
`node-watch`) or reference a collector's private data directory (`.claude`, `.codex`, `.cursor`,
`.copilot`, `.jsonl`). `src/domain` stays free of `node:` imports entirely. Nothing in `src/`
imports from `test/`. `statusline.js` may import `node:fs`, `node:os`, `node:path`, `node:url` —
and nothing else, because it runs on every prompt render.

**Comments are stripped before scanning.** Without that the gate fires on its own rationale —
`ccusage.shellout.ts` explains at length why it does *not* read `~/.claude` — and a gate that
forbids explaining itself is a gate people delete.

## 2. Network

A `net.Socket.prototype.connect` hook installed through vitest `setupFiles`, so it covers **the
whole run**. "The product never egresses" is a property of the run; a gate watching one file is not
a fence.

Loopback stays allowed: a collector's local HTTP surface is a legitimate design (budi's daemon
listens on `127.0.0.1`). Everything else throws `EgressForbiddenError`.

This is also what makes the **npx ban structural instead of advisory**. `npx` performs registry
resolution, which is a non-loopback connect, which now fails the build — so the ccusage adapter
cannot quietly regress to `npx -y ccusage@20` and pay 2.6 s of cold start.

The gate carries its own **positive control**: a real `connect` to `example.com` must throw. An
always-passing guard is worse than no guard, because it looks like protection.

## 3. Privacy canary

`CORPUS.json` seeds canary strings, and the stub collector emits them in exactly the fields a real
payload uses for repository names, session titles and file paths — including on the forced-total
path, without which this gate would be vacuous on the path the restart tests use.

The gate drives the **whole pipeline as a real process** and asserts no canary reaches:

```
rendered stdout · the snapshot file · the latch file · the notification argv
```

Unit tests already assert the adapter does not copy them. This is the end-to-end version, because
the leak that matters is the one that happens two layers after the adapter.

It first asserts that each surface was actually produced — otherwise it would be proving that
strings absent from the input are absent from the output, which is true of any program.

## Every gate is mutation-verified

A gate is only worth its runtime if it fails when the rule is broken. Each of these was checked by
deliberately breaking the rule:

| Mutation | Caught by |
|---|---|
| `src/` imports `node:readline` | 2 tests |
| `src/` references `~/.claude` and `.jsonl` | 2 tests |
| `src/domain` imports `node:fs` | 1 test |
| adapter leaks the raw payload downstream | privacy gate |
| `bin` path that the build never produces | bin gate |
| built binary missing its shebang | bin gate |
