STEP 03 of 06 — see .prompts/README.md. REQUIRES step 01 to be done.

Read HANDOFF.md and pathly/features/local-usage-meter/P5_RESEARCH.md (produced by
step 01 and attached to this task on the board).

Start: git checkout main && git pull && git checkout -b feat/p5-2-codex-parity

Build P5-2, scoped by what P5_RESEARCH.md actually found:

  If Codex has a BLOCKING hook      -> guard.js gains a Codex entrypoint that
                                       shares the same pure decide(). Do not fork
                                       the decision logic.
  If Codex has a STATUSLINE contract -> statusline.js likewise.
  If Codex has NEITHER               -> ship no surface. Instead make lum doctor
                                       state plainly that enforcement and the
                                       ambient display are Claude Code only.
                                       A documented limitation beats a surface
                                       that half-works.

Whatever you build inherits the hot-path constraints in HANDOFF.md §3-§4:
node:fs/os/path/url only, spawn nothing, fail open, never touch the collector.
A timed-out hook does not block, so a slow guard is an absent guard.

Update HANDOFF.md §5's multi-tool table to match reality when you are done.

--- NEXT ---

  -> .prompts/04-second-adapter.md

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

