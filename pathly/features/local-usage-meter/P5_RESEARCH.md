# P5 RESEARCH — the three contract questions

**Date:** 2026-08-27. **Closes:** `P5-1`, `P5-4`, `P5-5`. **Feeds:** `P5-2`.

Two of these verify assumptions that already-merged code (`src/bin/guard.js`) rests on. The third
decides whether `P5-2` ships code or ships a documented limitation.

**Headline:** all three are answered. The guard's guessed enum was **correct**, its enforcement is
**hard, not advisory**, and Codex — contrary to `HANDOFF.md` §5 — **does have a blocking PreToolUse
hook with a byte-identical deny shape**, but **no statusline** a third party can write into.

Versions pinned at time of research: Claude Code `2.1.245`, Codex CLI `0.147.0`.

---

## P5-5 — the exact `permissionDecision` enum

**CONFIRMED. Four values: `allow`, `deny`, `ask`, `defer`.**

Primary source: the Claude Code hooks reference, fetched as raw markdown (not summarised) from
`https://docs.claude.com/en/docs/claude-code/hooks.md`.

The summary table of hook output fields gives the enum verbatim:

> | PreToolUse | `hookSpecificOutput` | `permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason` |

And the PreToolUse decision-control table gives the semantics:

> `"allow"` skips the permission prompt […] `"deny"` prevents the tool call. `"ask"` prompts the user
> to confirm. `"defer"` exits gracefully so the tool can be resumed later.

Three further facts from the same page that the guard should know:

- **Multi-hook precedence** — "When multiple PreToolUse hooks return different decisions, precedence
  is `deny` > `defer` > `ask` > `allow`." A competing hook cannot override our deny.
- **Deprecated aliases** — PreToolUse previously used top-level `decision`/`reason`; `"approve"` maps
  to `"allow"` and `"block"` to `"deny"`. We do not use these, and should not start.
- **Exit code 2 routes as deny** — "A hook that blocks by exiting 2 routes the same way as `"deny"`:
  Claude sees the stderr message as the denial reason."

### Why the two earlier fetches disagreed

They were not both wrong about the same thing — one was too narrow and one hallucinated a value.

The page contains this prose line describing PreToolUse: *"Uses `hookSpecificOutput` for richer
control: allow, deny, or **escalate** to the user."* That is English describing what `ask` does. It
is **not** a fifth enum member. `escalate` appears exactly once in the whole 292 KB document, in that
sentence, and never in a table, schema or code sample.

**Lesson worth keeping:** the earlier research read a *summary* of this page. Summarisers flatten
prose and schema into one list. Both P5-4 and P5-5 were resolved here by fetching the raw `.md` and
grepping it — no intermediate model. Do that for contract questions.

### Corroboration in the shipped implementation

Independent of the docs, the Claude Code `2.1.245` bundle contains the output validator, which
branches on exactly these four and no others:

```js
case "PreToolUse": {
  let o = e.permissionDecision === "deny" || e.permissionDecision === "ask";
  t(n, "allow", e.permissionDecision === "allow");
  t(n, "defer", e.permissionDecision === "defer");
  …
```

### Consequence for `guard.js`

**None. No change required.** `denyPayload()` in [src/bin/guard.js:93](src/bin/guard.js:93) already
emits the confirmed shape:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
```

The guess was right. It is now no longer a guess.

---

## P5-4 — does `deny` survive `--dangerously-skip-permissions`?

**CONFIRMED: YES. A hook deny applies in `bypassPermissions` mode. Enforcement is HARD, not
advisory.**

This is documented — the earlier research looked on the wrong page. It is not in the hooks reference
or in `permissions.md`; it is in the Agent SDK permissions page,
`https://docs.claude.com/en/docs/claude-code/agent-sdk/permissions.md`, which is the only page that
publishes the full permission evaluation order.

### The evaluation order — hooks are step 1 of 6

| # | Step | What happens in `bypassPermissions` |
|---|---|---|
| 1 | **Hooks** | **Runs. A deny here ends it.** |
| 2 | Deny rules | Block, "even in `bypassPermissions` mode" |
| 3 | Ask rules | Still prompt, "even in `bypassPermissions` mode" |
| 4 | **Permission mode** | ← `bypassPermissions` is applied *here*, at step 4 |
| 5 | Allow rules | "Allow rules have no effect in `bypassPermissions`" |
| 6 | `canUseTool` callback | Never invoked |

Bypass mode is applied at step 4. A hook deny is returned at step 1. It never reaches the step that
would have waved it through.

The same page then states it outright, so this is not an inference from the ordering:

> For checks that must run on every tool call, use a `PreToolUse` hook: **hooks run before every
> other step, and a hook deny applies even in `bypassPermissions` mode.**

### Two independent corroborations

**The CLI hooks reference**, on when the event fires at all:

> PreToolUse hooks run before every tool call, **whether or not it needs permission**.

In bypass mode no call needs permission — and the hook still runs.

**The shipped bundle (2.1.245)** contains this SDK warning string, which exists precisely to steer
people off `canUseTool` and onto hooks for this reason:

> `canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call
> (except explicit deny rules) before the callback is consulted. To gate every tool call, use a
> PreToolUse hook instead.`

### What actually defeats the guard — say this in the README, not "bypass mode"

Bypass mode is **not** the escape hatch. Three other things are, and a user who wants a hard stop
should be told about them:

1. **`"disableAllHooks": true`** in a settings file turns off every hook. Per the hooks reference,
   `--settings '{"disableAllHooks": true}'` "takes precedence over project and local settings", and
   "There is no way to disable an individual hook while keeping it in the configuration."
2. **`--bare`** — Claude Code "reads no hooks, skills, custom commands, subagents, plugins" from the
   project.
3. **Uninstalling the hook** from `~/.claude/settings.json`, which is one edit.

None of these are attacks; `lum` guards a budget, not an adversary. But the README must not say
"cannot be bypassed". The honest claim is: **the guard survives `--dangerously-skip-permissions`, and
is turned off by turning hooks off.**

### Limits of this finding

This is documentary plus implementation-string evidence. **The empirical test was not run.** The
plan was three headless runs (bypass + no hook / bypass + deny hook / non-bypass + deny hook, with
the hook logging its own invocation to separate "did it run" from "was it honoured"). Launching a
nested `claude --dangerously-skip-permissions` was refused by the auto-mode classifier, and working
around that refusal was not appropriate. The fixtures are written and the experiment is reproducible
by hand if anyone wants belt and braces — but with the flow order, the explicit doc sentence and the
shipped warning string all agreeing, this is not a coin toss.

---

## P5-1 — does Codex CLI have hook or statusline equivalents?

**Hooks: YES — and far closer to Claude Code than anyone expected.**
**Statusline: NO — closed set of built-in items, no third-party surface.**

`HANDOFF.md` §5 says "Codex has no statusline and no guard because both are Claude Code hook
mechanisms. Whether Codex has any equivalent is `P5-1`, unresearched." **Half of that is now wrong
and should be corrected.**

First signal was local, from the installed CLI's own help:

```
--dangerously-bypass-hook-trust
    Run enabled hooks without requiring persisted hook trust for this invocation.
```

Primary source for everything below: `https://developers.openai.com/codex/hooks.md`, plus the
condensed manual at `https://learn.chatgpt.com/docs/codex-manual.md`.

### Hooks — yes, with a byte-identical deny shape

Codex has a full lifecycle hook system: `SessionStart`, `SessionEnd`, `SubagentStart`, **`PreToolUse`**,
**`PermissionRequest`**, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
`SubagentStop`, `Stop`.

The `PreToolUse` deny payload is **the same JSON we already emit**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive command blocked by hook."
  }
}
```

Codex also accepts legacy `{"decision":"block","reason":"…"}`, and exit code 2 with the reason on
stderr. Config shape (`hooks` → matcher group → handlers, `type: "command"`) is likewise near-identical.

**Where Codex looks:** `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`,
`<repo>/.codex/config.toml`. All matching sources load; higher layers don't replace lower ones.

### Six differences that matter to P5-2

1. **`ask` is not supported.** `permissionDecision: "ask"`, legacy `decision: "approve"`, `continue`,
   `stopReason` and `suppressOutput` are "parsed but not supported yet. Codex marks the hook run as
   failed, reports the error, and continues the tool call." Only `allow` and `deny` do anything. Our
   guard only emits `deny`, so this costs us nothing — and note the failure mode is **fail-open**,
   matching invariant 3.
2. **Hook trust gate.** Non-managed hooks must be reviewed and trusted via `/hooks` before they run,
   and trust is recorded **against the hook's hash** — so every edit re-arms review. `lum install`
   cannot silently activate a Codex guard the way it can a Claude Code one. The installer must tell
   the user to run `/hooks` and trust it.
3. **Default timeout is 600 seconds**, versus Claude Code's 60. Our "a slow guard is an absent guard"
   reasoning inverts here: on Codex a stalled hook stalls the *tool call*, for up to ten minutes. A
   Codex entrypoint must set an explicit short `timeout`.
4. **Tool coverage is not total.** Covered: shell (`Bash`), unified exec, `apply_patch`
   (`Edit`/`Write`), MCP tools, other local function tools. **Not** covered: hosted tools such as
   `WebSearch`.
5. **OpenAI declines to call it an enforcement boundary** — their words, from the tool-coverage
   section: *"Some specialized tool paths can opt out of the default hook path. Treat tool hooks as a
   useful guardrail, not a complete enforcement boundary."* Claude Code's docs make the opposite,
   stronger commitment (P5-4 above). **The two guarantees are not equal and the README matrix must
   not flatten them into one ✅.**
6. **`PermissionRequest`** is a second, separate event — fires when Codex is about to ask for
   approval. Any `deny` wins; `allow` skips the prompt. Probably not what we want (it doesn't fire
   when no approval is needed), but it exists.

### Statusline — no equivalent

The only statusline surface is `tui.status_line`, typed `array<string> | null`: an "Ordered list of
TUI footer status-line item identifiers. `null` disables the status line." The identifiers are
Codex's own built-ins — the documented example is:

```toml
status_line = ["model", "context-remaining", "git-branch"]
```

configured interactively with `/statusline`, which "Pick[s] and reorder[s] footer items
(model/context/limits/git/tokens/session)".

**There is no command contract, no stdin JSON, and no way to inject arbitrary text.** A third party
cannot render into the Codex footer. `lum` cannot have a Codex statusline. This is a schema-level no,
like Cursor's spend data — not a gap waiting to be filled.

---

## What I could NOT confirm

Listed explicitly, per the task's acceptance criteria.

1. ~~**Does a Codex `PreToolUse` deny survive `--dangerously-bypass-approvals-and-sandbox`
   (`--yolo`)?**~~ **ANSWERED during P5-2 — YES.** The docs are still silent, but Codex is open
   source, so this was settled by reading the dispatch path rather than by running a YOLO session.
   In `codex-rs/core/src/tools/registry.rs` the call to `run_pre_tool_use_hooks` sits in the tool
   dispatch path gated only by whether the tool participates in the hook path at all — never by
   approval policy or sandbox mode. And `hook_permission_mode` in `codex-rs/core/src/hook_runtime.rs`
   maps `AskForApproval::Never`, which is what `--yolo` sets, to the string `"bypassPermissions"`:
   Codex not only runs the hook, it tells the hook it is in bypass mode. The residual caveat is
   unchanged and is difference #5 — a tool whose path opts out of hooks entirely is never seen.
2. **The empirical Claude Code bypass test was not executed** (see P5-4 §Limits). Documentary and
   implementation evidence only, from three independent places that agree.
3. **The closed set of `tui.status_line` item identifiers is not enumerated** in any doc I found —
   only examples and a parenthetical list. Doesn't change the finding (none of them are "arbitrary
   text from a command"), but I can't print the full set.
4. **Codex requires a non-empty `permissionDecisionReason` on a deny** — found during P5-2 in
   `codex-rs/hooks/src/engine/output_parser.rs`, which rejects the hook run outright with
   "PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason",
   and a rejected run lets the tool call proceed. Claude Code has no such requirement. So on Codex
   invariant 5 ("say why") is load-bearing for correctness, not manners: an empty reason there is
   not an ugly block, it is **no block**. `guard.js` now enforces this before emitting.

5. **Codex command-hook timeout semantics on expiry.** The fail-open statement I found
   ("Errors, missing servers, and unavailable tools don't block the operation") is in the *MCP tool
   hooks* section. I did not find an equivalent explicit sentence for a *command* hook that exceeds
   its timeout.

---

## Recommended consequences

Flagged, not applied — `guard.js` enforcement behaviour is not to be changed silently.

- **`guard.js`: no change.** Enum confirmed correct, hard enforcement confirmed. (P5-5, P5-4)
- **`HANDOFF.md` §5: correct the Codex row.** "Codex has no statusline and no guard" is now half
  wrong — no statusline (confirmed, schema-level), but a real blocking hook exists.
- **README: state the guarantee precisely.** Survives `--dangerously-skip-permissions`; turned off by
  `disableAllHooks`, `--bare`, or removing the hook. Do not write "cannot be bypassed".
- **`P5-2` is unblocked and is now a build, not a doc-only task.** ✅ **Shipped.** It needed no new
  binary at all: `src/bin/guard.js` serves both hosts from one `decide()`, because both read
  `tool_name` off stdin and honour the same deny payload. `lum install --codex [--guard]` writes
  `~/.codex/hooks.json` with pinned timeouts and the `/hooks` trust step in its output, and
  `lum doctor` gained a `surfaces` row. Statusline parity was **cancelled**, not deferred — there
  is nothing to build against.
- **Per `.prompts/01-research.md`, the next step is `.prompts/03-codex-parity.md`**, not
  `02-cursor-doctor.md`: P5-1 found a mechanism.

## Method note

Every finding here comes from a raw `.md` fetch grepped directly, or from the installed binary — no
summarised page, because summarisation is what produced the `escalate` phantom in the first place.
Doc URLs used:

- `https://docs.claude.com/en/docs/claude-code/hooks.md`
- `https://docs.claude.com/en/docs/claude-code/agent-sdk/permissions.md`
- `https://docs.claude.com/en/docs/claude-code/permission-modes.md`
- `https://docs.claude.com/en/docs/claude-code/permissions.md`
- `https://developers.openai.com/codex/hooks.md`
- `https://developers.openai.com/codex/config-reference.md`
- `https://learn.chatgpt.com/docs/codex-manual.md`
