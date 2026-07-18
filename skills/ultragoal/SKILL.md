---
name: ultragoal
description: Durable multi-goal workflow that persists plan/ledger artifacts under .omc/ultragoal and prints Claude /goal handoff text for the active session
argument-hint: "<brief or subcommand>"
level: 3
---

<Purpose>
Ultragoal breaks a brief into an ordered set of goals, records start/checkpoint/blocker/failure events in a durable append-only ledger, and tells the active Claude agent how to drive the Claude Code `/goal` slash command alongside the plan. It does not — and cannot — mutate Claude `/goal` state from the shell; it persists durable repo state and prints a model-facing handoff that the active agent must act on in-session.
</Purpose>

<Use_When>
- The user wants a durable, repo-native way to track an ultragoal across multiple Claude sessions or worktrees
- The work is large enough to warrant multiple ordered "stories" with attempt counts and per-story evidence
- The user wants the final completion gated behind ai-slop-cleaner + verification + $code-review
- The user wants the active Claude `/goal` directive coordinated with the ledger so that a session restart does not lose progress
</Use_When>

<Do_Not_Use_When>
- The task is a single small change — use direct delegation or `ralph` instead
- The user wants the assistant to literally invoke `/goal` itself from the shell — that is not possible; `omc ultragoal` only writes artifacts and prints handoff text
- The user wants a planning-only artifact with no execution loop — use `plan` instead
</Do_Not_Use_When>

<Why_This_Exists>
Claude Code `/goal` is a session-scoped Stop hook: it blocks the session from stopping until a condition holds, and auto-clears on success. That is a great single-session execution primitive, but it loses state across sessions and does not by itself enforce a final review gate. `omc ultragoal` adds a durable plan, ledger, and gating layer so a long multi-step initiative can survive session restarts, fresh worktrees, and review iterations while still leveraging Claude `/goal` to keep the active agent focused.
</Why_This_Exists>

<How_To_Use>

1. Create a plan from a brief:
   ```
   omc ultragoal create-goals --brief-file plan.md
   ```
   Or with explicit stories:
   ```
   omc ultragoal create-goals --brief "ship the migration" \
     --goal "Schema::Add new columns" \
     --goal "Backfill::Backfill rows in batches" \
     --goal "Cutover::Drop old columns and switch reads"
   ```
   The default mode is `aggregate` (one Claude `/goal` covers the run).
   Pass `--claude-goal-mode per-story` if you want each story to have its own `/goal`.

   **Multi-repo workspaces / parallel sessions:** when several Claude sessions
   in the same workspace need to run `/ultragoal` concurrently, pass either
   `--plan-id <stable-id>` or `--auto-plan-id` so the plan is written to
   `.omc/ultragoal/plans/{planId}/` instead of the shared single-plan path.
   Without that flag, two sessions creating goals would clobber each other.
   `--auto-plan-id` derives `{epochMs}-{slug}` from the brief title. Then thread
   the same `--plan-id <id>` through every subsequent subcommand in that session.
   Use `omc ultragoal list-plans` to enumerate available planIds when needed.

2. Start (or resume) the next story:
   ```
   omc ultragoal complete-goals
   ```
   This prints a model-facing handoff. The active Claude agent must read it and:
   - Set the native Claude `/goal` for this session — in standalone Claude Code neither the
     shell nor the agent can do it, so ask the user to type `/goal <aggregate objective>` and
     wait. `--claude-goal-json` (below) reconciles the ledger only and does not satisfy the
     PreToolUse `/goal` guard, which blocks tool calls until it observes an active `/goal`.
   - Work the story.
   - When the story is complete (and for the final story, after the full quality gate), share back a snapshot of the active `/goal` state and call `checkpoint`.

3. Checkpoint a story:
   ```
   omc ultragoal checkpoint --goal-id G001-... --status complete \
     --evidence "tests/files/PR evidence" \
     --claude-goal-json '{"goal":{"objective":"...","status":"active"}}'
   ```
   For the final story, also pass `--quality-gate-json` containing
   `aiSlopCleaner`, `verification`, and `codeReview` evidence (all clean).

4. If the final review is not clean, do NOT mark complete. Record blockers:
   ```
   omc ultragoal record-review-blockers --goal-id G00X-... \
     --title "Resolve final code-review blockers" \
     --objective "Fix the listed review findings and rerun final gates" \
     --evidence "<the review findings>" \
     --claude-goal-json '{"goal":{"objective":"...","status":"active"}}'
   ```
   This appends a new blocker story and keeps the Claude `/goal` active.

5. Inspect state at any time:
   ```
   omc ultragoal status
   ```

</How_To_Use>

<Important_Limitations>
- The shell cannot invoke or mutate Claude Code `/goal` state. `omc ultragoal` only persists durable artifacts and prints instructions that the active Claude agent reads and acts on in-session.
- Snapshots passed via `--claude-goal-json` are model-supplied proof of the active `/goal` state; OMC validates them for textual consistency with the plan's expected objective and ledger event, but it cannot independently observe Claude `/goal` state. They do not satisfy the PreToolUse `/goal` guard, which requires an actual active `/goal` — a host-injected snapshot or the native `/goal` the user set in-session.
- If the Claude `/goal` slash command is renamed or restructured, only the handoff wording needs to change; the reconciliation logic is name-agnostic.
</Important_Limitations>
