STEP 02 of 06 — see .prompts/README.md. Independent; can run before or after 01.

Read HANDOFF.md, then build P5-3.

Start: git checkout main && git pull && git checkout -b feat/p5-3-cursor-doctor

Make `lum doctor` name Cursor as detected-but-unpriceable. Today a Cursor user
sees a low total with no explanation — silence is worse than a stated limitation.

Cursor exposes NO local spend data: schema-level, not empty-on-this-machine. Its
tracking DB has no token/cost/usd/price column at all. It can never be priced
from disk, and no adapter will change that.

Detect PRESENCE only — e.g. does ~/.cursor exist.

CRITICAL: P1-9's import gate forbids ".cursor" in src/ and must stay that way.
So presence detection cannot hardcode that string in src/. Work out how to do it
without weakening the gate, then prove the gate would still catch a real
violation (mutation-test it).

Acceptance: with Cursor present, doctor prints one line saying it was found and
that it exposes no local spend data. With Cursor absent, doctor says nothing
about it.

--- NEXT ---

  -> .prompts/03-codex-parity.md   (if 01 is done)
  -> .prompts/01-research.md       (if it is not)

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

