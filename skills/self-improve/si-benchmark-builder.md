# Self-Improvement Benchmark Builder

## Input Contract

Arguments passed via prompt context:
- `repo_path`: Absolute path to the target repository
- `goal_path`: Path to goal.md with defined objective and metric
- `settings_path`: Path to settings.json
- `agent_settings_path`: Path to agent-settings.json
- `tracking_path`: Path to tracking/ directory

## Role

You build a benchmark for the self-improvement loop. The benchmark must produce a measurable score that the loop can optimize against. Prefer adapting existing evaluation over building from scratch.

## Prerequisites

- Target repo exists and is cloned
- Goal is defined (si_setting_goal is true)
- goal.md has a defined objective and metric

## Workflow

### Phase 1 — Understand the Goal
Read goal.md. Extract metric name, direction, target value, scope.

### Phase 2 — Repo Survey
Explore the target repo for existing evaluation:
- Test suites (pytest, jest, go test, cargo test)
- Benchmark scripts (benchmark.*, eval.*, score.*)
- CI evaluation (.github/workflows/)
- Performance tests, metrics in code

Classify: Ready to use | Partially usable | Nothing exists

### Phase 3 — Interview (only if needed)
If approach is unclear, ask up to 3 questions. Hard cap.

### Phase 4 — Design
Requirements:
- **JSON output preferred**: Last line of stdout as `{"primary": 85.2, "sub_scores": {"dim_a": 0.92}}`
- **Deterministic**: Same code → same score (fixed seeds)
- **Fast**: Under 5 minutes ideally
- **Self-contained**: No external services
- **Honest**: Measures actual quality

### Phase 5 — Implement
Build the benchmark. Place it in the target repo (scripts/benchmark.py or benchmark.py).
Must exit 0 on success, non-zero on error. Print score as last stdout line.

### Phase 6 — Validate
Run the benchmark 3 times:
```
Run 1: {x}
Run 2: {y}
Run 3: {z}
Variance: {(max-min)/mean * 100}%
```
All 3 must complete. Variance must be < 5%.

### Phase 7 — Record and Configure
Update settings.json:
- `benchmark_command`: the shell command
- `benchmark_format`: "json", "number", or "pass_fail"
- `primary_metric`: key name in JSON output (default: "primary")

**Add benchmark script to `sealed_files`** — prevents the loop from modifying it.

Record baseline to tracking/baseline.json:
```json
{ "baseline_score": <mean_score>, "recorded_at": "<ISO 8601>" }
```

Update agent-settings.json:
- `si_setting_benchmark` → true
- `best_score` → mean_score

### Phase 8 — Handoff
Report: benchmark command, score, variance, and next step.
