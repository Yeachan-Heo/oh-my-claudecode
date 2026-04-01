# Data Contracts: Inter-Agent Communication Schemas

Canonical JSON schemas for all messages exchanged between agents in the self-improvement loop.

## 1. Plan Document

**Producer:** planner | **Consumer:** critic, executor

```json
{
  "plan_id": "round_{N}_{planner_id}",
  "planner_id": "planner_a|planner_b|planner_c",
  "round": 1,
  "hypothesis": "Doing X should improve Y because Z",
  "approach_family": "<taxonomy value>",
  "critic_approved": false,
  "target_files": ["path/to/file1"],
  "steps": [
    { "step": 1, "file": "path/to/file", "change": "exact description" }
  ],
  "expected_outcome": {
    "metric": "<metric from goal>",
    "estimated_impact": "<quantified estimate>",
    "rationale": "<why>",
    "sub_score_expectations": {}
  },
  "history_reference": {
    "builds_on": "<prior success or 'none'>",
    "avoids": "<prior failure or 'none'>"
  },
  "critic_review": {
    "h001_hypothesis_count": "pass|fail",
    "h002_family_streak": "pass|fail",
    "h003_intra_round_diversity": "pass|fail",
    "schema_valid": "pass|fail",
    "history_aware": "pass|fail",
    "verdict": "approved|rejected",
    "rejection_reason": null
  },
  "architect_review": {
    "verdict": "approve|reject",
    "feedback": "",
    "structural_concerns": []
  }
}
```

## 2. Benchmark Result

**Producer:** executor | **Consumer:** tournament (SKILL.md)

```json
{
  "executor_id": "executor_{id}",
  "plan_id": "round_{n}_planner_{x}",
  "benchmark_score": 85.2,
  "benchmark_raw": "full stdout verbatim",
  "status": "success|regression|error|timeout",
  "sub_scores": { "dim_a": 85.2, "dim_b": 42.3 },
  "failure_analysis": null,
  "timestamp": "ISO 8601 UTC"
}
```

**Status definitions:**
- `success` — score improved or held even
- `regression` — score dropped below baseline
- `error` — benchmark could not run
- `timeout` — exceeded time limit

## 3. Research Brief

**Producer:** researcher | **Consumer:** planners

```json
{
  "iteration": 1,
  "researcher_id": "researcher",
  "repo_analysis_summary": "...",
  "ideas": [
    {
      "title": "Short action name",
      "source": "Specific origin",
      "evidence": "Concrete evidence",
      "approach_family": "<taxonomy value>",
      "confidence": "high|medium|low",
      "estimated_impact": "3-5%"
    }
  ]
}
```

## 4. Iteration History Record

**Producer:** orchestrator | **Consumer:** planners, researcher

```json
{
  "iteration": 1,
  "baseline_score": 80.0,
  "winner": {
    "plan_id": "round_1_planner_a",
    "score": 85.2,
    "approach_family": "training_config",
    "hypothesis": "...",
    "sub_scores": {}
  },
  "losers": [
    {
      "plan_id": "round_1_planner_b",
      "score": 78.5,
      "approach_family": "architecture",
      "hypothesis": "...",
      "sub_scores": {},
      "failure_analysis": {
        "what": "Score dropped",
        "why": "Root cause",
        "category": "regression",
        "lesson": "Actionable lesson"
      }
    }
  ],
  "research_brief_id": "round_1"
}
```

## 5. Visualization Data

**File:** `.omc/self-improve/tracking/raw_data.json` — top-level JSON array, append-only.

```json
[
  {
    "iteration": 1,
    "plan_id": "round_1_planner_a",
    "benchmark_score": 85.2,
    "is_winner": true,
    "approach_family": "training_config",
    "sub_scores": {}
  }
]
```

## 6. Approach Family Taxonomy

| Tag | Description |
|-----|-------------|
| `architecture` | Model/component structure changes |
| `training_config` | Optimizer, LR, scheduler, batch size, epochs |
| `data` | Data loading, augmentation, preprocessing |
| `infrastructure` | Mixed precision, distributed training, checkpointing |
| `optimization` | Algorithmic/numerical optimizations |
| `testing` | Evaluation methodology changes |
| `documentation` | Documentation-only changes |
| `other` | Does not fit above — explain in evidence |

Custom families from harness.md are also valid.

## 7. Failure Analysis Object

```json
{
  "what": "Factual description with scores/errors",
  "why": "Root cause mechanism",
  "category": "oom|timeout|regression|logic_error|scope_error|infrastructure|benchmark_parse_error|sealed_file_violation",
  "lesson": "Actionable lesson for future planners"
}
```

## 8. Iteration State

**File:** `.omc/self-improve/state/iteration_state.json` — tracks within-iteration progress.

```json
{
  "iteration": 1,
  "status": "in_progress|completed|failed|interrupted",
  "current_step": "research|planning|critic_review|execution|tournament|recording|stop_check",
  "started_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "research": { "status": "pending|in_progress|completed|failed", "output_path": null, "completed_at": null },
  "planning": {
    "status": "pending|in_progress|completed",
    "plans": {
      "planner_a": { "status": "completed", "output_path": "...", "critic_approved": true }
    },
    "approved_count": 2,
    "completed_at": null
  },
  "execution": {
    "status": "pending|in_progress|completed",
    "executors": {
      "executor_1": { "status": "running", "plan_id": "...", "output_path": null, "benchmark_score": null }
    },
    "completed_at": null
  },
  "tournament": { "status": "pending", "winner": null, "winner_score": null, "completed_at": null },
  "recording": { "status": "pending", "history_path": null, "visualization_updated": false, "cleanup_done": false },
  "user_ideas_consumed": []
}
```

## 9. Merge Report

**Producer:** tournament (SKILL.md) | **Consumer:** orchestrator

```json
{
  "iteration": 3,
  "goal_slug": "reduce_latency",
  "winner": {
    "executor_id": "executor_2",
    "branch": "experiment/round_3_executor_2",
    "hypothesis": "Cache intermediate results",
    "score_before": 142.3,
    "score_after": 118.7,
    "sub_scores": {}
  },
  "archived": ["archive/round_3_executor_1"],
  "regressions_detected": false,
  "re_benchmark_score": 118.7,
  "status": "merged|no_improvement|no_winner|all_rejected",
  "reason": null
}
```

**Status definitions:**
- `merged` — a candidate was merged and re-benchmark confirmed improvement
- `no_improvement` — candidates existed and were tested, but all failed re-benchmark (no merge occurred)
- `no_winner` — all executors failed or produced non-success status (no candidates to evaluate)
- `all_rejected` — all plans were rejected by the critic (execution was skipped)

`reason` is required (string) when status is not `merged`, null when `merged`.
```

## 10. Plan Archive

**Location:** `.omc/self-improve/state/plan_archive/round_{n}/`

Exact copies of all plan JSON files, including critic and architect reviews. Permanent retention.

## 11. Event Log

**File:** `.omc/self-improve/tracking/events.json` — append-only array.

```json
[
  {
    "timestamp": "ISO 8601",
    "event_type": "config_change|phase_transition",
    "iteration": 5,
    "details": {
      "field": "number_of_agents",
      "old_value": 2,
      "new_value": 3,
      "source": "user"
    }
  }
]
```

## 12. Goal Phase

Defined in goal.md under `## Phases`. Tracked in agent-settings.json as `current_phase`.

```markdown
## Phases
| Phase | Focus | Sub-Score Targets | Status |
|-------|-------|-------------------|--------|
| phase_1 | Primary dimension | dim_a >= 90.0 | active |
| phase_2 | Secondary dimension | dim_b <= 50.0 | pending |
```

Phase transitions are tracked as events but do not affect tournament selection.
