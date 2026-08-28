STEP 06 of 06 — see .prompts/README.md.

DO NOT START THIS unless the repo owner has answered both gates. No agent can
close them, and shipping without them means publishing under a name nobody chose
to an audience nobody validated.

  PRE-B  Is there demand? Evidence so far is in
         pathly/features/local-usage-meter/COMPETITIVE_ANALYSIS.md and it is
         THIN — the ccusage maintainer closed two requests for this exact feature
         as NOT_PLANNED, and the strongest signal found anywhere was one
         thumbs-up. LiteLLM proves people want budget control; nobody has shown
         they want it badly enough to prefer zero-setup.
  PRE-D  What is it called? The package is local-usage-meter; the GitHub repo is
         still token-tracker, which collides with an established OSS project.
         Renaming the repo is a settings change only the owner can make.

If both are answered, read HANDOFF.md and build P4-6:

Start: git checkout main && git pull && git checkout -b feat/p4-6-release

  - README that claims ZERO SETUP, not uniqueness. COMPETITIVE_ANALYSIS.md
    explains why: a proxy CAN see subscription usage, so the differentiator is
    setup cost. Do not reinstate the old claim.
  - Say plainly that we warn and enforce LOCALLY, and that a proxy is the
    alternative for anyone wanting provider-side control who will operate one.
  - Document the transitive pricing dependency: ccusage consumes LiteLLM's
    model_prices_and_context_window.json, so our dollars trace back to it. Note
    the known failure modes (unrecognised new models, stale cache).
  - Document the multi-tool matrix from HANDOFF.md §5 honestly, including what
    Codex and Cursor do NOT get.
  - Remove private:true only when the name is settled.

--- NEXT ---

  Nothing. This is the last planned step. After it, work is driven by users.

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

