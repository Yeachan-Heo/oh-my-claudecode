---
name: ralplan
description: Runs the consensus planning workflow. Spawns architect and critic review iterations to verify the plan before moving the finalized design to .omc/plans/.
---

# Consensus Planning (RALPLAN-DR) Workflow

Use this skill to draft, critique, and finalize a highly robust technical design plan before commencing any coding. This workflow utilizes a structured multi-agent deliberation loop (Planner -> Architect -> Critic -> Finalization).

---

## 1. Execution Steps

When this skill is triggered by a prompt or keyword, execute the following stages sequentially:

### Stage 1: Initial Planning & Discovery
1. Run broad search/discovery tools to map out the target codebase if it's a brownfield project.
2. Draft a complete technical plan focusing on:
   - Context and Work Objectives.
   - Architectural Decision Record (ADR) detailing options and drivers.
   - Guardrails (Must Have / Must Not Have).
   - Pre-Mortem (Risks & Mitigations, e.g. hydration mismatches, blocking loops).
   - Detailed TODOs broken down by step with clear acceptance criteria.
3. Save this initial plan to `.omc/plans/draft-plan.md`.

### Stage 2: Architect Review
1. Spawn a subagent (or run a specialized session) acting as an **Architect Reviewer**.
2. Review `.omc/plans/draft-plan.md` against:
   - System boundaries and modularity.
   - Directory structures and code patterns.
   - Type safety, compiler configurations, and framework compatibility.
3. Save the review feedback to `.omc/plans/architect-review.md`.
4. Update `.omc/plans/draft-plan.md` to resolve all recommendations raised by the architect.

### Stage 3: Critic Review
1. Spawn a subagent (or run a specialized session) acting as a **Critic Reviewer**.
2. Challenge the revised plan on:
   - Edge cases, error handling, and performance bottlenecks (e.g. Minimax execution).
   - Test spec adequacy (unit, integration, and E2E coverage).
   - Accessibility constraints (keyboard grid navigation, live screen-reader announcements).
3. Save the review feedback to `.omc/plans/critic-review.md`.
4. Update `.omc/plans/draft-plan.md` to address all edge cases raised by the critic.
5. Loop back to the Critic Review stage if the critic flags any unresolved high-severity items.

### Stage 4: Move & Finalize & Tmux Bootstrap
1. Once the critic confirms the design is solid and complete, merge all final revisions.
2. Move the plan file to its permanent home: `.omc/plans/<project-name>.md`.
3. Create the test specification document at: `.omc/plans/test-spec-<project-name>.md`.
4. **Bootstrap the execution environment programmatically:**
   - Run `tmux list-panes` to check if a split-pane layout already exists.
   - If only one pane exists:
     - Split it horizontally to create the right column: `tmux split-window -h -c "#{pane_current_path}"`
     - Split the new right pane vertically: `tmux split-window -v -t 1 -c "#{pane_current_path}"`
   - Determine the active pane IDs (`tmux list-panes`).
   - Launch the executor CLI in the bottom-right pane (usually `%2` or `%4`):
     ```bash
     tmux send-keys -t <bottom_right_pane_id> "/home/galadriel/.local/bin/agy --dangerously-skip-permissions" Enter
     ```
   - Stage the start command in the top-right pane (usually `%1` or `%3`) pointing to the bottom-right pane:
     ```bash
     tmux send-keys -t <top_right_pane_id> "omc ralphthon --leader <bottom_right_pane_id> --skip-interview 'Implement the plan in .omc/plans/<project-name>.md'"
     ```
5. Notify the user that planning is complete, the workspace is bootstrapped, and the execution command is staged and ready to be run in the top-right pane.

---

## 2. Best Practices

* **Do not start coding:** Under no circumstances should you edit or write production source code files during this skill. Focus exclusively on planning, review, and consensus.
* **Be critical:** The architect and critic subagents must act as independent checkers. Do not automatically approve the first draft; challenge assumptions.
