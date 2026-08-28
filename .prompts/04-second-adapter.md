STEP 04 of 06 — see .prompts/README.md. Independent of 01-03.

Read HANDOFF.md and test/contract/README.md, then build P1-5.

Start: git checkout main && git pull && git checkout -b feat/p1-5-jsonfile-adapter

Add jsonfile.ts as a second REAL adapter behind UsageSourcePort. It must pass the
existing 18-case contract suite UNMODIFIED, alongside the in-memory reference and
ccusage. That is the whole point: adding an adapter is three lines plus a harness.

It is also the escape hatch for any collector nobody has adapted — a user points
it at a JSON file they produce however they like.

The corpus in test/fixtures/collector/CORPUS.json is shared and non-negotiable.
When an adapter and the in-memory fake disagree, the fake is right.

Mutation-test it the way the others were. `git log --grep=mutation` shows the
five defect classes the ccusage adapter was checked against: inclusive-to,
window-ignored, re-pricing from tokens, unpriceable-as-$0.00, canary leak.

--- NEXT ---

  -> .prompts/05-source-selection.md

--- HOUSE RULES (apply to every step) ---

Board is the source of truth. BOARD.json is a MIRROR — never edit it.
  list:   curl -s "http://127.0.0.1:8765/comms/tasks?feature=lum-budget-layer"
  done:   POST /comms/tasks/status  {task_ids[], status:"done", reason, actor}
  attach: POST /comms/attach        {message_id, artifact_path, artifact_type, title, summary}
A task is buildable when task_status is "pending" and every depends_on id is "done".

Conventions (HANDOFF.md §8):
  - Mutation-test anything load-bearing: break the rule on purpose, confirm the
    suite catches it, then restore. If it does not catch it, the test is wrong.
  - Every skipped test needs a written reason.
  - Do not loosen a gate without writing down why in the same commit.
  - Comments explain WHY, especially where the code looks wrong.

Finish every step the same way:
  pnpm verify  ->  commit  ->  PR  ->  CI green on all 3 platforms  ->  merge
  ->  mark the board task done with the REAL finding as the reason (not "done")
  ->  git checkout main && git pull

Never silently change enforcement behaviour (guard.js). If a finding says it
should change, tell me first.

