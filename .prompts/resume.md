FALLBACK — use this only if you would rather the session pick its own task.
The ordered sequence is .prompts/README.md; prefer that.

Read HANDOFF.md first — it is the cold-start doc for this repo.

We are building `lum`, a local budget guardrail for AI coding tools. main is at
e2f0c85, everything merged, 483 tests green on all three platforms.

Start: git checkout main && git pull && git checkout -b feat/<task-you-pick>

The pathly board is the source of truth (BOARD.json is a MIRROR — never edit it):
  curl -s "http://127.0.0.1:8765/comms/tasks?feature=lum-budget-layer"

A task is buildable when task_status is "pending" and every id in depends_on is
"done". Show me what is buildable, recommend one WITH your reasoning, and wait
for me to agree before building.

Two things bias the choice, and say so if you disagree:
  - P5-4 and P5-5 verify assumptions that already-merged code (guard.js) rests
    on. That is the only thing in the repo that could be actively wrong in a way
    a user would feel. Everything else is additive.
  - P4-6 is human-blocked on PRE-B and PRE-D. Do not start it.

Follow HANDOFF.md §8 — especially: mutation-test anything load-bearing (break
the rule deliberately, confirm the suite catches it), and every skipped test
needs a written reason.

Finish: pnpm verify -> commit -> PR -> CI green on all 3 platforms -> merge ->
mark the task done on the board with a reason that says what you actually did.

Never silently change enforcement behaviour (guard.js). Tell me first.
