# Research Findings — local-usage-meter

_Date: 2026-08-10 · Stage: RESEARCHING · Rigor: standard_
_Dispositions added 2026-08-24 — every "the builder should evaluate" below now has an answer in
ARCHITECTURE_PROPOSAL.md. This file records what was found; the architecture records what was
decided. Where they differ, the architecture is current._

All findings are external and sourced. Anything marked **unconfirmed** requires verification against the installed package.

---

## 1. ccusage npm package structure (CRITICAL — blocks ADR-001)

### Finding: ccusage v20 is a Rust binary, not a JS library

**ccusage ≥ v20 is a compiled Rust binary distributed as platform-specific optional npm deps.**
The `apps/ccusage/package.json` `optionalDependencies` lists:
`@ccusage/ccusage-darwin-arm64`, `@ccusage/ccusage-darwin-x64`, `@ccusage/ccusage-linux-arm64`,
`@ccusage/ccusage-linux-x64`, `@ccusage/ccusage-win32-arm64`, `@ccusage/ccusage-win32-x64`.
The TypeScript layer in `apps/ccusage/src/cli.js` is only a thin platform-dispatch launcher.

**No JavaScript/TypeScript library exports exist in the published package.**
The `package.json` has no `exports` field beyond the `bin` entry (`"ccusage": "./src/cli.js"`).
There are no programmatic subpath exports such as `ccusage/pricing`, `ccusage/data`, or
`ccusage/data-loader`. The library-usage docs page (`ccusage.com/guide/library-usage`)
returned HTTP 404 — consistent with those docs being removed after the Rust rewrite.
Community index snippets referencing `loadDailyUsageData` from `'ccusage/data-loader'` reflect
an older TypeScript version of ccusage and **do not apply to v20**.

**`@ccusage/codex` is deprecated.**
Its npm page states: deprecated in favor of `npx ccusage`. Codex CLI session parsing is now
built into the main Rust binary via `ccusage codex daily`, `ccusage codex monthly`,
`ccusage codex session`. No separate JS/TS package for Codex pricing exists.

### Architecture impact: CRITICAL — **APPLIED**

The architect's PricingPort and BaselineLoaderPort designs (§4 of ARCHITECTURE_PROPOSAL.md)
assumed ccusage could be embedded as an `import`. **This is not possible with ccusage v20.**

> **Disposition:** ADR-001, §0, §1.2 and §4 were rewritten. Option B below was taken, not
> Option A: `pricing.bundled.ts` (vendored LiteLLM JSON) is the primary `PricingPort`, and
> `baseline.shellout.ts` is an *optional* `BaselineLoaderPort` skipped when the binary is absent.
> This inverts PO constraint #1 and is tracked for human sign-off as PRE-10.

### Shell-out interface (confirmed and documented)

`ccusage daily --json`, `ccusage session --json`, `ccusage monthly --json`, and
`ccusage blocks --json` all emit structured JSON. The `--offline` flag uses pre-cached pricing
without a network call (this is a CLI flag, not a JS API). The pricing source is the LiteLLM
`model_prices_and_context_window.json` file.

JSON schema for session output:
```json
{
  "type": "...",
  "data": [{
    "session": "string",
    "models": ["string"],
    "inputTokens": "number",
    "outputTokens": "number",
    "cacheCreationTokens": "number",
    "cacheReadTokens": "number",
    "totalTokens": "number",
    "costUSD": "number",
    "firstActivity": "ISO timestamp",
    "lastActivity": "ISO timestamp"
  }],
  "summary": {}
}
```

### Alternative: direct JSONL reader + LiteLLM pricing (no ccusage runtime dependency)

**Disposition: (B), with (A) retained as an optional reconcile only.**
- **(A) Shell-out to `ccusage --json`** — fast to implement, adds a runtime binary dependency,
  ~150–500ms latency per invocation. The reconcile path (every 5 min) tolerates this; the
  tail-on-hot-path design already avoids this on the latency-critical path.
- **(B) Direct JSONL reader + LiteLLM pricing JSON** — no ccusage runtime dependency at all.
  Read `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
  once at setup, vendor it as `prices.snapshot.json`. The architecture already specifies this
  as the `pricing.bundled` fallback — it can become the primary pricing source.

Option B is closest to what the architecture describes for the hot path. **Chosen.** The
`BaselineLoaderPort` was *not* reimplemented directly — it stayed a shell-out and became
optional instead. The consequence is worth stating plainly: **on a machine without ccusage
installed there is no independent cross-check at all**, and the Appendix C parity test cannot
run. It must report SKIPPED there, never PASSED.

**Sources:**
- [raw.githubusercontent.com/ryoppippi/ccusage/main/apps/ccusage/package.json](https://raw.githubusercontent.com/ryoppippi/ccusage/main/apps/ccusage/package.json)
- [deepwiki.com/ryoppippi/ccusage](https://deepwiki.com/ryoppippi/ccusage)
- [ccusage.com/guide/json-output](https://ccusage.com/guide/json-output)
- [ccusage.com/guide/codex/](https://ccusage.com/guide/codex/)
- [npmjs.com/package/@ccusage/codex](https://www.npmjs.com/package/@ccusage/codex)
- [github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)

---

## 2. chokidar@4 API

### What changed from v3

**Glob support was removed in v4.** In v3 you could pass glob patterns directly to
`chokidar.watch('src/*.ts')`. In v4 you must watch a directory and filter files in the handler.

**Correct v4 API to watch a directory and filter to `.jsonl` files:**
```js
chokidar.watch('/path/to/dir', {
  ignored: (path, stats) => stats?.isFile() && !path.endsWith('.jsonl'),
  persistent: true,
  ignoreInitial: true,
})
```
Guard with `stats?.isFile()` to avoid filtering out directories (the callback fires twice per
path: once with just the path string, once with `fs.Stats`).

**Event names are unchanged from v3:** `add`, `addDir`, `change`, `unlink`, `unlinkDir`,
`ready`, `raw`, `error`, and the meta-event `all`.

### Architecture claim "JS-only, no native build step" — CONFIRMED for v4

v4 removed the bundled `fsevents` optional native module, reducing npm dependencies from 13 to 1.
It relies exclusively on Node.js core `fs.watch`. No `node-gyp` or native compile step required.

### Known reliability risks

- **inotify watch loss on Linux.** Long-running processes can lose inotify watches if the
  watched path is briefly unmounted (NFS dropout, USB sleep, container remount). Mitigation:
  listen for the `error` event and restart the watcher — the architecture's always-on poll
  already provides a backstop.
- **macOS sleep/wake.** v4 uses Node's `fs.watch` (which internally uses FSEvents on macOS)
  rather than `fsevents` directly. Events may arrive in batches; the architecture's debounce
  and always-on safety poll handle this correctly.

### chokidar v5 note

v5 (November 2025) exists and is the currently maintained version. It is ESM-only, requires
Node.js ≥ 20, and has a smaller footprint (~80KB vs ~150KB for v4).

> **Disposition (closes B5): pin v4.** The architecture's dependency table briefly said `^5`
> while ADR-007 and §5.2 said 4 — one document, two versions. It is now v4 everywhere, because
> the v4 directory-watch + `ignored`-callback pattern documented above is the one this research
> actually verified. v5 is a fine later bump; it is not a v1 decision.

**Sources:**
- [github.com/paulmillr/chokidar](https://github.com/paulmillr/chokidar)
- [dev.to/43081j — Migrating from chokidar 3.x to 4.x](https://dev.to/43081j/migrating-from-chokidar-3x-to-4x-5ab5)
- [safeguard.sh — chokidar npm review](https://safeguard.sh/resources/blog/chokidar-npm)

---

## 3. Claude Code statusLine hook contract

### Confirmed interface

**Official docs:** `code.claude.com/docs/en/statusline`

**Update frequency:** at most every 300ms, triggered by conversation message updates.
An optional `refreshInterval` setting enables periodic refresh independent of conversation activity.

**stdout contract:** first line of stdout becomes the statusline. Multi-line statuslines are
supported via a documented multi-line mode (shown in official docs screenshots) — the exact
output format for multi-line mode is unconfirmed; test against installed Claude Code.

**ANSI color codes: CONFIRMED supported.** Official docs and multiple community examples use
`\033[32m`-style sequences. OSC 8 hyperlinks may render as plain text depending on terminal.

**Timeout:** command hooks default to 600 seconds. A `timeout` field in the statusLine config
can override this. Claude Code sends a termination signal when the timeout expires.

**Process environment:** the process runs in its own session without a controlling terminal
(as of v2.1.139). Cannot open `/dev/tty` or write escape sequences directly to the Claude Code
interface. Use `terminalSequence` in JSON output format instead.

### Complete stdin JSON schema

```json
{
  "hook_event_name": "Status",
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "version": "string",
  "model": { "id": "string", "display_name": "string" },
  "workspace": { "current_dir": "string", "project_dir": "string" },
  "output_style": { "name": "string" },
  "cost": {
    "total_cost_usd": "number",
    "total_duration_ms": "number",
    "total_api_duration_ms": "number",
    "total_lines_added": "number",
    "total_lines_removed": "number"
  },
  "context_window": {
    "total_input_tokens": "number",
    "total_output_tokens": "number",
    "context_window_size": "number",
    "used_percentage": "number",
    "remaining_percentage": "number",
    "current_usage": {
      "input_tokens": "number",
      "output_tokens": "number",
      "cache_creation_input_tokens": "number",
      "cache_read_input_tokens": "number"
    }
  },
  "rate_limits": {
    "five_hour": { "used_percentage": "number", "resets_at": "unix timestamp" },
    "seven_day": { "used_percentage": "number", "resets_at": "unix timestamp" }
  }
}
```

Note: not every field appears for every account, version, or route. Community sources also
document `worktree: { name: string }` and `git: { branch: string }` in some environments.

### Risk: stdin blocking (unconfirmed)

The architecture intentionally ignores stdin to avoid blocking on a pipe that may never be
written. Whether Claude Code blocks waiting for stdin to be consumed before reading stdout is
**unconfirmed** from public docs.

If Claude Code uses a blocking write to stdin, ignoring stdin could cause a deadlock.
**Safe pattern (recommended):** explicitly consume and discard stdin on startup before writing
to stdout:
```js
process.stdin.resume();
process.stdin.destroy();
```
This is non-blocking and harmless whether or not Claude Code writes to the pipe.

The `cost.total_cost_usd` field in the stdin payload is notable: it provides session-level cost
data from Claude Code itself. The architecture's design (ignore stdin entirely, use only the
snapshot) is correct for accuracy and for supporting Codex, but the builder should be aware
this field exists as a potential cross-check for Claude-only sessions.

**Sources:**
- [code.claude.com/docs/en/statusline (official)](https://code.claude.com/docs/en/statusline)
- [code.claude.com/docs/en/hooks (official)](https://code.claude.com/docs/en/hooks)
- [claudefa.st — statusline guide](https://claudefa.st/blog/tools/statusline-guide)
- [dandoescode.com — Building a custom statusline](https://www.dandoescode.com/blog/claude-code-custom-statusline)
- [dev.to/vee_atnameless — Super simple statusline](https://dev.to/vee_atnameless/claude-code-super-simple-statusline-1lbp)

---

## 4. Open items for the builder to verify

| # | Item | Why unconfirmed | Blocks |
|---|---|---|---|
| **B1** | Whether any JS library exports exist in the installed ccusage version (installed may differ from v20 latest). Run: `cat $(npm root -g)/ccusage/package.json` or `node -e "require('ccusage')"`. | npm install not run during research. Community snippets may ref older version. | ADR-001 finalization |
| **B2** | Whether `ccusage daily --offline --json` output includes per-turn data (for reconciliation) or only aggregated daily totals. | JSON output schema documented for session mode; `daily --json` schema not fully confirmed. | Reconciler design |
| **B3** | Whether Claude Code blocks on stdin before reading stdout from the statusline process. | Not documented in official hooks reference. | `bin/statusline.js` startup sequence |
| **B4** | Exact multi-line statusline output format (does a newline in stdout produce a 2-row statusline, or is a special format required?). | Docs show a screenshot but not the output format. | `render/statusline.ts` for multi-line mode |
| ~~**B5**~~ | ~~Whether chokidar v5 should be used instead of v4.~~ | **CLOSED 2026-08-24 — pinned to v4** (see §2). | — |

---

## Summary for design / plan

The research confirmed the architecture's high-level strategy but required one significant
correction, **which has since been applied**:

1. **ccusage embed → removed entirely from the primary path** *(applied)*: the architecture no
   longer embeds or depends on ccusage to run. `pricing.bundled.ts` reads a vendored LiteLLM
   table; `baseline.shellout.ts` is an optional drift check. The port abstraction (ADR-001)
   survived unchanged — only which adapter is primary flipped. Tracked as PRE-10 for human
   sign-off because it inverts PO constraint #1.

2. **chokidar@4 pattern is confirmed correct**: watch directory, filter `.jsonl` in `ignored` callback. No changes needed to §5 of the architecture.

3. **statusLine contract is well-documented**: the architecture's approach (ignore stdin, read snapshot, always exit 0) is sound — but explicitly consuming stdin on startup is recommended.

4. **The stdin payload contains `cost.total_cost_usd`** for the active Claude session — useful context for the design to acknowledge, even if the implementation ignores it.

---

## 5. Competitive landscape (added 2026-08-24) — the finding that forced v2

Research §1–§4 asked *how* to build a collector. Nobody asked *whether* one needed building. The
answer is no.

### The collection layer is commoditised

| Project | Tools covered | Method | Budget + alerts | License |
|---|---|---|---|---|
| [budi](https://github.com/siropkin/budi) | Claude Code, Cursor, Codex, Copilot Chat, Copilot CLI | transcript tailing, no proxy, Rust daemon | ❌ | MIT |
| [Token Tracker](https://github.com/xiufengsun/TokenTracker) | **34 tools**, 2,200+ models, menu-bar + tray apps | log parsing | ❌ | OSS |
| [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | 16+ providers | provider APIs | quota + rate limits | OSS |
| [ccusage](https://github.com/ryoppippi/ccusage) | Claude + Codex | log parsing | ❌ | MIT |

**budi is v1's architecture, already shipped** — "reads transcript files those tools already write
to disk. No proxy, no gateway, nothing in your network path." Local-first, MIT, five tools including
Cursor. Token Tracker's native menu-bar app is v1's P6 stretch goal, already done, for 34 tools.

`ccusage statusline` already prints
`🤖 Fable 5 | 💰 $0.23 session / $1.23 today / $0.45 block (2h 45m left) | 🔥 $0.12/hr | 🧠 25,000 (12%)`
offline, reading Claude Code's stdin. That is v1 phases 1–3 and 5.

### The gap that is real

**None of them does a configurable budget with threshold alerts.** Every one answers *"what did I
spend?"*; not one answers *"am I about to blow my allowance?"* Confirmed by feature docs and by the
absence of any budget/alert issue on budi's tracker.

That gap is the product. See ADR-v2-001.

### budi integration surface (for `UsageSourcePort`)

- **Rust daemon** on `127.0.0.1:7878`; single SQLite at `~/.local/share/budi/` (Unix) /
  `%LOCALAPPDATA%\budi` (Windows).
- **HTTP API:** `/analytics/*`, `/pricing/*`, `/admin/*` — **preferred seam.**
- **CLI:** `budi stats --format json` — more stable, process-spawn cost. Also `budi status`,
  `budi doctor`, `budi sessions <id>`.
- **Do not read the SQLite directly** — couples us to their schema.
- Health: 936 commits, active CI. But **0 external PRs**, 13 open issues all filed by the owner,
  issue activity quiet since May 2026. Solo project — hence ≥2 adapters before v1.0 (Risk R2).

### `rate_limits` on the statusline — the metric v1 discarded

Officially documented and present for Claude.ai Pro/Max subscribers after the first API response;
each window (`five_hour`, `seven_day`) independently optional; official handling is
`jq -r '.rate_limits.five_hour.used_percentage // empty'`. It regressed out in v2.1.96
([issue #45133](https://github.com/anthropics/claude-code/issues/45133), closed as duplicate) and
is back in the current docs — so treat it as optional-by-construction, never as an error.

For a Max subscriber this is the single most useful statusline metric, typically rendered
`7d:used%/elapsed%` to show whether you are ahead of or behind your weekly quota. v1 explicitly
refused to read stdin and therefore threw it away. ADR-v2-003 reverses that.

Also on that pipe and free: `cost.total_cost_usd` (session), `context_window.used_percentage`.
Claude Code debounces statusline updates at 300 ms and **cancels an in-flight script** when a new
update arrives.

**Sources:** [budi](https://getbudi.dev/) · [budi GitHub](https://github.com/siropkin/budi) ·
[Token Tracker](https://www.tokentracker.cc/) ·
[TokenTracker GitHub](https://github.com/xiufengsun/TokenTracker) ·
[coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) ·
[ccusage statusline](https://ccusage.com/guide/statusline) ·
[Claude Code statusline docs](https://code.claude.com/docs/en/statusline) ·
[Claude Code monitoring roundup](https://www.toriihq.com/articles/five-claude-code-usage-dashboards-and-monitoring-tools)
