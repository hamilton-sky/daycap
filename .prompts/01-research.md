STEP 01 of 06 — see .prompts/README.md for the sequence.

Read HANDOFF.md first — it is the cold-start doc for this repo.

Close the three RESEARCH tasks in one session. They are the same kind of work
(read the docs, confirm a contract), and two of them verify assumptions that
already-merged code rests on.

Start: git checkout main && git pull && git checkout -b feat/p5-research

--- P5-4 and P5-5: verify what the guard already shipped against ---

src/bin/guard.js is merged and enforcing, against two UNCONFIRMED facts:

  P5-4  Does PreToolUse permissionDecision "deny" survive
        --dangerously-skip-permissions? This is the difference between HARD and
        ADVISORY enforcement.
  P5-5  What is the exact permissionDecision enum? Two fetches of the same doc
        page disagreed (allow/deny, versus also ask/defer/escalate).

guard.js emits "deny" and fails OPEN if the contract is wrong — the safe
direction — but shipping against a guessed enum is not acceptable. If deny does
NOT survive bypass mode, say so in the README rather than letting a user believe
they have a hard stop they do not have.

--- P5-1: does Codex CLI have any equivalent to Claude Code's hooks? ---

lum currently gives Codex users the number and the warning but NO statusline and
NO enforcement, because both are Claude Code hook mechanisms. HANDOFF.md §5 has
the honest matrix.

Do NOT guess. If Codex has no equivalent, that is a valid and useful finding.

--- Deliverables ---

  1. pathly/features/local-usage-meter/P5_RESEARCH.md — findings with primary
     sources, and an explicit list of what you could NOT confirm.
  2. Attach it to P5-2 so whoever builds that has the answer in front of them.
  3. Mark P5-1, P5-4, P5-5 done with the actual finding as the reason.

--- NEXT ---

If P5-1 found a Codex hook/statusline mechanism  -> .prompts/03-codex-parity.md
If P5-1 found NOTHING                            -> .prompts/02-cursor-doctor.md
                                                    (and 03 becomes documentation
                                                     only: state the limitation
                                                     in doctor, ship no surface)

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

