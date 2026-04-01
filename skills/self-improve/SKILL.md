---
name: self-improve
description: Autonomous evolutionary code improvement engine with tournament selection
level: 4
---

# Self-Improvement Orchestrator

You are the **loop controller** for the self-improvement system. You manage the full lifecycle: setup, research, planning, execution, tournament selection, history recording, visualization, and stop-condition evaluation. You delegate to specialized OMC agents and coordinate their inputs and outputs.

---

## Autonomous Execution Policy

**NEVER stop or pause to ask the user during the improvement loop.** Once the gate check passes and the loop begins, you run fully autonomously until a stop condition is met.

- **Do not ask for confirmation** between iterations or between steps within an iteration.
- **Do not summarize and wait** — execute the next step immediately.
- **On agent failure**: retry once, then skip that agent and continue with remaining agents. Log the failure in iteration history.
- **On all plans rejected**: log it, continue to the next iteration automatically.
- **On all executors failing**: log it, continue to the next iteration automatically.
- **On benchmark errors**: log the error, mark the executor as failed, continue with other executors.
- **The only things that stop the loop** are the stop conditions in Step 11.
- **Trust boundary**: The loop runs benchmark commands as-is inside the target repo. The user explicitly confirms the repo path and benchmark command during setup. The loop does NOT install packages, modify system config, or access network resources beyond what the benchmark command does.
- **Sealed files**: validate.sh enforces that benchmark code cannot be modified by the loop, preventing self-modification of the evaluation.

---

## State Tracking

All state lives under `.omc/self-improve/`:

```
.omc/self-improve/
├── config/                    # User configuration
│   ├── settings.json          # agents, benchmark, thresholds, sealed_files
│   ├── goal.md                # Improvement objective + target metric
│   ├── harness.md             # Guardrail rules (H001/H002/H003)
│   └── idea.md                # User experiment ideas
├── state/                     # Runtime state
│   ├── agent-settings.json    # iterations, best_score, status, counters
│   ├── iteration_state.json   # Within-iteration progress (resumability)
│   ├── research_briefs/       # Research output per round
│   ├── iteration_history/     # Full history per round
│   ├── merge_reports/         # Tournament results
│   └── plan_archive/          # Archived plans (permanent)
├── plans/                     # Active plans (current round)
└── tracking/                  # Visualization data
    ├── raw_data.json          # All candidate scores
    ├── baseline.json          # Initial benchmark score
    ├── events.json            # Config changes
    └── progress.png           # Generated chart
```

OMC mode lifecycle: `.omc/state/sessions/{sessionId}/self-improve-state.json`

---

## Agent Mapping

All augmentations delivered via Task description context at spawn time. No modifications to existing agent .md files.

| Step | Role | OMC Agent | Model |
|------|------|-----------|-------|
| Research | Codebase analysis + hypothesis generation | general-purpose Agent | opus |
| Planning | Hypothesis → structured plan | oh-my-claudecode:planner | opus |
| Architecture Review | 6-point plan review | oh-my-claudecode:architect | opus |
| Critic Review | Harness rule enforcement | oh-my-claudecode:critic | opus |
| Execution | Implement plan + run benchmark | oh-my-claudecode:executor | opus |
| Git Operations | Atomic merge/tag/PR | oh-my-claudecode:git-master | sonnet |
| Goal Setup | Interactive interview | (directly in this skill) | N/A |
| Benchmark Setup | Create + validate benchmark | custom agent | opus |

**Research prompt**: Read `si-researcher.md` from this skill directory and pass its content as the agent prompt.

**Benchmark builder**: Read `si-benchmark-builder.md` from this skill directory and pass its content as the agent prompt.

**Goal clarifier**: Read `si-goal-clarifier.md` from this skill directory and execute the interview directly (interactive, needs user).

---

## Inputs

Read these files at startup and at the beginning of each iteration:

| File | Purpose |
|---|---|
| `.omc/self-improve/config/settings.json` | User config: `number_of_agents`, `benchmark_command`, `benchmark_format`, `benchmark_direction`, `max_iterations`, `plateau_threshold`, `plateau_window`, `target_value`, `primary_metric`, `sealed_files`, `regression_threshold`, `circuit_breaker_threshold`, `target_branch`, `current_repo_url`, `fork_url`, `upstream_url` |
| `.omc/self-improve/state/agent-settings.json` | Runtime: `iterations`, `best_score`, `plateau_consecutive_count`, `circuit_breaker_count`, `status`, `goal_slug` (derived: lowercase underscore from goal objective, persisted for cross-session consistency) |
| `.omc/self-improve/state/iteration_state.json` | Per-iteration progress for resumability |
| `.omc/self-improve/config/goal.md` | Improvement objective, target metric, scope |
| `.omc/self-improve/config/harness.md` | Guardrail rules (H001, H002, H003) |

---

## Setup Phase

1. Check if target repo path exists. If not configured, ask user for the path to the repository to improve.
2. Create `.omc/self-improve/` directory structure by copying from `templates/` in this skill directory.
3. Read `.omc/self-improve/state/agent-settings.json`. Check `si_setting_goal`, `si_setting_benchmark`, `si_setting_harness`.
4. **Trust confirmation** (mandatory, cannot be skipped):
   a. If `trust_confirmed` is already `true` in agent-settings.json, skip to step 5 (resume path).
   b. Display the target repo path and ask user to confirm:
      `"Self-improve will run benchmark commands inside {repo_path}. This executes arbitrary code in that repository. Confirm? [yes/no]"`
   c. If user declines: abort setup and exit. Do NOT proceed.
   d. Record consent: set `trust_confirmed: true` in agent-settings.json.
5. If goal not set → read `si-goal-clarifier.md` from this skill directory and run the 4-dimension Socratic interview directly in this context (Objective, Metric, Target, Scope). Write result to `.omc/self-improve/config/goal.md`.
6. If benchmark not set → read `si-benchmark-builder.md` from this skill directory, spawn a custom Agent(model=opus) with its content as prompt. The agent surveys the repo, creates or wraps a benchmark, validates 3x, and records baseline.
   After benchmark is set, confirm the benchmark command with user:
   `"Benchmark command: {benchmark_command}. This will be run repeatedly during the loop. Confirm? [yes/no]"`
   If user declines: abort setup and exit.
7. If harness not set → confirm default harness rules (H001/H002/H003) with user or customize.
8. **Gate**: All of `si_setting_goal`, `si_setting_benchmark`, `si_setting_harness`, `trust_confirmed` must be true.
9. **Create improvement branch** (if it does not exist):
   ```
   git -C {repo_path} checkout -b improve/{goal_slug} {target_branch}
   git -C {repo_path} checkout {target_branch}
   ```
   Where `{goal_slug}` is derived from the goal objective (lowercase, underscored). If the branch already exists, skip creation. Persist `goal_slug` in agent-settings.json.
10. **Mode exclusivity**: Call `state_list_active`. If autopilot, ralph, or ultrawork is active, refuse to start.
11. Write initial state: `state_write(mode='self-improve', active=true, iteration=0, started_at=<now>)`

---

## Git Strategy

All git operations happen inside the target repo, NOT in the OMC project root.

- **Improvement branch**: `improve/{goal_slug}` — accumulates winning changes only.
- **Experiment branches**: `experiment/round_{n}_executor_{id}` — short-lived, per executor.
- **Archive tags**: `archive/round_{n}_executor_{id}` — losing branches tagged before deletion.
- **Worktree setup** (SKILL.md creates before each executor):
  ```
  git -C {repo_path} worktree add worktrees/round_{n}_executor_{id} -b experiment/round_{n}_executor_{id} improve/{goal_slug}
  ```
- **Winner merges** via `oh-my-claudecode:git-master`:
  ```
  Merge experiment/round_{n}_executor_{winner_id} into improve/{goal_slug} with --no-ff
  Message: "Iteration {n}: {hypothesis} (score: {before} → {after})"
  ```
- **Push after merge**: `git -C {repo_path} push origin improve/{goal_slug}` (backup, non-blocking)
- **Losers archived**: Tag + delete via git-master.

---

## Improvement Loop

**Gate**: All settings must be true. Once the gate passes, execute continuously without stopping.

Update `state_write(mode='self-improve', active=true, status="running")`.

### Step 0 — Stale Worktree Cleanup (mandatory, runs every iteration)

**PREREQUISITE**: This step MUST run to completion before any other step, including resume logic. It is idempotent and safe to run multiple times.

1. List all worktrees in the target repo: `git -C {repo_path} worktree list`
2. For any worktree matching `worktrees/round_*` that does NOT belong to the current iteration: remove it with `git -C {repo_path} worktree remove {path} --force`
3. Run `git -C {repo_path} worktree prune` to clean up stale references
4. This handles crash recovery — orphaned worktrees from interrupted iterations are cleaned before the new iteration starts

### Step 1 — Refresh State

`state_write(mode='self-improve', active=true, iteration=N)` to reset 30min TTL.

### Step 2 — Check Stop Request

Read state via `state_read(mode='self-improve')`.

If state is cleared (cancel was invoked) OR status is `user_stopped`:
  a. Set `status: "user_stopped"` in `.omc/self-improve/state/agent-settings.json`
  b. Update `iteration_state.json`: set `status: "interrupted"`, record `current_step`
  c. Clean up any active worktrees for the current round (Step 0 logic)
  d. Log: `"Self-improve stopped by user at iteration {N}, step {current_step}"`
  e. Exit gracefully — do NOT invoke /cancel again (already cancelled)

### Step 3 — Check User Ideas

Read `.omc/self-improve/config/idea.md`. If non-empty, snapshot contents for planners. Clear after planners consume.

### Step 4 — Research

Spawn 1 general-purpose Agent(model=opus) with the content of `si-researcher.md` as prompt.

Pass in the prompt:
- Current iteration number
- Path to target repo
- Path to `.omc/self-improve/config/goal.md`
- Path to `.omc/self-improve/state/iteration_history/` (all prior records)
- Path to `.omc/self-improve/state/research_briefs/` (prior briefs)
- Content of `data_contracts.md` Section 3 (Research Brief schema)

Expected output: research brief JSON → `.omc/self-improve/state/research_briefs/round_{n}.json`

If researcher fails, proceed with history only.

### Step 5 — Plan

Spawn N `oh-my-claudecode:planner`(model=opus) agents in parallel (N = `number_of_agents` from settings).

Pass in each planner's prompt:
- Planner identity (planner_a, planner_b, planner_c...)
- Research brief path
- Iteration history path
- Harness rules from `.omc/self-improve/config/harness.md`
- Data contract schema for Plan Document
- **Override instructions**: Output JSON (not markdown), skip interview mode, generate exactly ONE testable hypothesis per plan, include approach_family tag and history_reference.
- User ideas (if any, planner_a gets priority)

Expected output: Plan Document JSON → `.omc/self-improve/plans/round_{n}/plan_planner_{id}.json`

### Step 6 — Review

For each plan, **sequentially** (architect before critic):

**6a. Architecture Review**: Spawn `oh-my-claudecode:architect` with the plan + 6-point checklist:
1. Testability — is the hypothesis testable?
2. Novelty — different from prior attempts?
3. Scope — right-sized?
4. Target files — exist, not sealed?
5. Implementation clarity — executor can implement without guessing?
6. Expected outcome — realistic given evidence?

Architect verdict is **advisory only**.

**6b. Critic Review**: Spawn `oh-my-claudecode:critic` with the plan + harness rules:
- H001: Exactly one hypothesis (reject if zero or multiple)
- H002: No approach_family repetition streak >= 3
- H003: Intra-round diversity (no two plans same family in same round)
- Schema validation against data_contracts.md
- History awareness check

Critic sets `critic_approved: true` or `false`. Plans with `false` are excluded from execution.

If ALL plans rejected, log and skip to Step 9.

### Step 7 — Execute

For each approved plan, spawn `oh-my-claudecode:executor`(model=opus) in parallel.

**Before spawning**, create worktree:
```
git -C {repo_path} worktree add worktrees/round_{n}_executor_{id} -b experiment/round_{n}_executor_{id} improve/{goal_slug}
```

Pass in each executor's prompt:
- The approved plan JSON
- Worktree directory path
- Benchmark command from settings
- Sealed files list from settings
- Path to `scripts/validate.sh` in this skill directory
- Data contract schema for Benchmark Result
- **Override instructions**: Implement the plan faithfully, run validate.sh before benchmarking, run the benchmark command, produce Benchmark Result JSON as output.

Expected output: Benchmark Result JSON (written by executor or returned as output).

### Step 8 — Tournament Selection

SKILL.md does this directly (not delegated):

1. **Collect** all executor results
2. **Filter** to `status: "success"` only. If zero candidates, skip to Step 9 (Record & Visualize).
3. **Rank** by `benchmark_score` (respecting `benchmark_direction`)
4. **Ranked-candidate loop** — for each candidate in rank order (best first):
   a. **No-regression check**: candidate score must improve or hold even vs `best_score`, respecting `benchmark_direction` (`higher_is_better`: score >= best_score; `lower_is_better`: score <= best_score)
   b. **Merge** via `oh-my-claudecode:git-master`: `git merge experiment/round_{n}_executor_{id} --no-ff -m "Iteration {n}: {hypothesis} (score: {before} → {after})"`
   c. **Re-benchmark** on merged state to confirm improvement
   d. If re-benchmark **confirms** improvement: **accept winner**, break loop
   e. If re-benchmark shows **regression**: **revert merge** via `git -C {repo_path} reset --hard HEAD~1`, continue to next candidate
   f. If merge **conflicts**: `git -C {repo_path} merge --abort`, continue to next candidate
5. If a winner was accepted AND `auto_push` is `true` in settings: **Push** improvement branch: `git -C {repo_path} push origin improve/{goal_slug}` (non-blocking).
   If `auto_push` is `false` (default): skip push. Log: `"Push skipped (auto_push: false). Run manually: git -C {repo_path} push origin improve/{goal_slug}"`
6. **Archive** all non-winner branches via git-master: tag + delete
7. If no candidate survived the loop: no merge this round. Improvement branch stays at prior state.
8. **Write Merge Report** JSON to `.omc/self-improve/state/merge_reports/round_{n}.json` (schema: data_contracts.md Section 9).

### Step 9 — Record & Visualize

1. Write iteration history to `.omc/self-improve/state/iteration_history/round_{n}.json`
2. Update `.omc/self-improve/state/agent-settings.json`:
   - Increment `iterations` by 1
   - If winner AND improvement exceeds `plateau_threshold` (`abs(new_score - best_score) >= plateau_threshold`): update `best_score`, reset `plateau_consecutive_count = 0`, reset `circuit_breaker_count = 0`
   - If winner AND improvement below threshold (`abs(new_score - best_score) < plateau_threshold`): update `best_score` if better, increment `plateau_consecutive_count += 1`, reset `circuit_breaker_count = 0`
   - If no winner (all rejected, all failed, or all regressed): increment `circuit_breaker_count += 1` (do NOT increment `plateau_consecutive_count` — plateau tracks stagnating wins, not failures)
3. Append to `.omc/self-improve/tracking/raw_data.json` (one entry per candidate)
4. Run `python3 {skill_dir}/scripts/plot_progress.py` for visualization
5. Archive plans: copy current round plans to `state/plan_archive/round_{n}/`

### Step 10 — Cleanup

Remove worktrees:
```
git -C {repo_path} worktree remove worktrees/round_{n}_executor_{id} --force
git -C {repo_path} worktree prune
```

Update `iteration_state.json` status to `completed`.

### Step 11 — Stop Condition Check

Evaluate ALL conditions. If ANY is true, exit:

| Condition | Check |
|---|---|
| User stop | `status == "user_stopped"` in agent-settings or state cleared |
| Target reached | `best_score` meets/exceeds `target_value` (respecting direction) |
| Plateau | `plateau_consecutive_count >= plateau_window` |
| Max iterations | `iterations >= max_iterations` |
| Circuit breaker | `circuit_breaker_count >= circuit_breaker_threshold` |

If NO stop condition: immediately go back to Step 1.

---

## Resumability

**PREREQUISITE**: Step 0 (stale worktree cleanup) MUST run to completion before any resume logic executes, regardless of prior state.

On invocation, before entering the loop:

1. **Always run Step 0** (stale worktree cleanup) — even on fresh start
2. Read `.omc/self-improve/state/agent-settings.json`:
   - If `status: "user_stopped"`: ask user `"Previous run was stopped at iteration {N}. Resume? [yes/no]"`. If no, exit. If yes, continue.
   - If `status: "running"`: session crashed — resume automatically (no user prompt)
   - If `status: "idle"`: fresh start
3. Re-confirm trust gate only if `trust_confirmed` is `false` in agent-settings.json
4. Read `.omc/self-improve/state/iteration_state.json`:
   - `status: "in_progress"` → resume from `current_step`, skip completed sub-steps
   - `status: "completed"` → start next iteration
   - `status: "failed"` → complete recording step if needed, start next iteration
   - File missing → start from iteration 1

---

## Completion

When the loop exits:

1. Update agent-settings.json with final status
2. If `target_reached` AND `auto_pr` is `true` in settings: spawn git-master to create PR from `improve/{goal_slug}` to upstream.
   If `auto_pr` is `false` (default): skip PR creation. Log: `"PR creation skipped (auto_pr: false). Run manually: gh pr create --head improve/{goal_slug} --base {target_branch}"`
3. Run plot_progress.py one final time
4. Print summary report:
   ```
   === Self-Improvement Loop Complete ===
   Status: {status}
   Iterations: {iterations}
   Best Score: {best_score} (baseline: {baseline})
   Improvement: {delta} ({delta_pct}%)
   ```
5. Run `/oh-my-claudecode:cancel` for clean state cleanup

---

## Error Handling

| Situation | Action |
|---|---|
| Agent fails to produce output | Retry once. If still no output, log and continue. |
| Researcher produces empty brief | Proceed — planners work from history alone. |
| All plans rejected by critic | Skip execution. Log. Continue to next iteration. |
| All executors fail | Skip tournament. Record failures. Continue. |
| Merge conflict | Reject candidate, try next. |
| Re-benchmark regression | Reject candidate, revert merge, try next. |
| Push failure | Log warning. Continue — push is backup. |
| Worktree already exists | Remove and recreate. |
| Settings corrupted | Report and stop. |

---

## Approach Family Taxonomy

Every plan must be tagged with exactly one:

| Tag | Description |
|-----|-------------|
| `architecture` | Model/component structure changes |
| `training_config` | Optimizer, LR, scheduler, batch size |
| `data` | Data loading, augmentation, preprocessing |
| `infrastructure` | Mixed precision, distributed training, compiled kernels |
| `optimization` | Algorithmic/numerical optimizations |
| `testing` | Evaluation methodology changes |
| `documentation` | Documentation-only changes |
| `other` | Does not fit above — explain in evidence |
