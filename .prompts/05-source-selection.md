STEP 05 of 06 — see .prompts/README.md. REQUIRES step 04 to be done.

Read HANDOFF.md, then build P4-3.

Start: git checkout main && git pull && git checkout -b feat/p4-3-source-selection

Implement source selection: config `source: auto|ccusage|jsonfile`.

  auto      probe in a documented order, cache available() for the process
            lifetime only
  explicit  if the named source is unavailable, ERROR — never silently fall back.
            Silently using a different collector than the one someone chose is
            how you report the wrong tool's numbers without telling anyone.

FIRST, deal with a stale edge: P4-3 currently depends on P4-2 (tokentracker.ts),
which was CUT in BUILD_PLAN_v3 §6 but is still "pending" on the board. Either
retract P4-2 and remove that dependency edge together, or leave both. Do not
retract P4-2 alone — that would leave P4-3 permanently unbuildable, waiting on a
task that no longer exists.

Update lum doctor so its source line reflects the selection, not just ccusage.

--- NEXT ---

  -> .prompts/06-release-prep.md   (only if PRE-B and PRE-D are answered)
  -> otherwise: .prompts/resume.md, or stop — the build queue is empty

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

