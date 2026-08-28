# Prompts — all six are done

**Historical.** These were written on 2026-08-27 as six copy-paste sessions, back when the CLI was
called `lum` and the repo was called `token-tracker`. Every one has been carried out. They are kept
because each states what the task *was for* better than the resulting commit message does, and
because the two that changed shape en route are worth being able to look up.

Do not run them. The house rules at the bottom of each file are still accurate; the tasks are not.

| # | Task | Outcome |
|---|---|---|
| 01 | `P5-1`, `P5-4`, `P5-5` — verify the guard's contracts | **done** — [#9]. No code changed: all three answers said the shipped guard was already right. `deny` does survive `--dangerously-skip-permissions`; the enum is `allow`/`deny`/`ask`/`defer`. |
| 02 | `P5-3` — name Cursor in `doctor` | **done** — [#11], then **corrected** in [#16]. The original claim ("no local spend data, ever") was too strong and had to be rewritten; see below. |
| 03 | `P5-2` — Codex surfaces | **done** — [#10]. Codex got a guard through the same `decide()`; it has no statusline and cannot. |
| 04 | `P1-5` — `jsonfile.ts` | **done** — [#11]. Passes the 18-case contract suite unmodified, which is what finally made the port a seam rather than decoration. |
| 05 | `P4-3` — `source: auto\|ccusage\|jsonfile` | **done** — [#11]. Naming a source disables the fallback, per the rule `errors.ts` had already written down. |
| 06 | `P4-6` — release readiness | **done** — README and licence scan [#12], Node floor [#13], MIT [#14], and `v0.1.0` tagged. |

[#9]: https://github.com/hamilton-sky/daycap/pull/9
[#10]: https://github.com/hamilton-sky/daycap/pull/10
[#11]: https://github.com/hamilton-sky/daycap/pull/11
[#12]: https://github.com/hamilton-sky/daycap/pull/12
[#13]: https://github.com/hamilton-sky/daycap/pull/13
[#14]: https://github.com/hamilton-sky/daycap/pull/14
[#16]: https://github.com/hamilton-sky/daycap/pull/16

## Where the plan was wrong, which is the part worth keeping

**Step 02 asserted something it could not know.** It told the session that Cursor "exposes NO local
spend data: schema-level, not empty-on-this-machine … no adapter will change that", and that
instruction went into the README as the word *ever*. A recheck three weeks later found Cursor's CLI
had begun emitting per-turn token counts in February 2026, and that its Admin API returns real spend.
The claim had an expiry date and carried nothing to remind anyone to check it.

The durable reason turned out to be *ours*, not Cursor's: their token counts live in CLI transcripts,
and reading those is transcript parsing (`ADR-v2-001`); turning tokens into dollars is re-pricing,
which contract case `C9b` exists to forbid. Rules we enforce do not expire. Predictions about another
vendor's schema do.

**Step 06's gate turned out to be the wrong gate.** It was blocked on `PRE-B` — "has anyone asked for
this?" — which cannot be answered about an unreleased, unnamed tool. It was answered by the owner
deciding they wanted it themselves, which was available the whole time.

## What the plan could not have told anyone

Six defects were found by *using* the tool, none by testing it: eleven tests silently skipping
themselves after a rename, the `today` header still reading `lum`, the help screen advertising a
retired command, a CLI that did nothing at all when installed via `npm i -g`, `--version` reporting
the wrong build, and the guard's denial message — the one sentence a blocked user reads — naming a
command that no longer existed.

Every one sat in the seam between the code and its environment: the shell, the filesystem, the
installed layout, the output text. A prompt file cannot ask for that. Installing the thing and typing
its name can.
