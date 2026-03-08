# Harsh-Critic Benchmark

Evaluates whether the archived `harsh-critic` prompt detects more gaps than the standard `critic` agent across a controlled set of fixtures with known ground truth.

## What This Benchmark Measures

This benchmark compares an archived snapshot of `harsh-critic` vs the current `critic` prompt across 8 fixtures in 3 domains (plans, code, analysis).

**Primary hypothesis**: The structured "What's Missing" output section and multi-perspective investigation protocol in `harsh-critic` improve gap detection compared to `critic`'s open-ended critical challenge format.

**Based on**: A/B testing findings from issue #1240, which showed that structured output templates are the active ingredient — not adversarial framing. The key differentiator is whether the agent is prompted to enumerate missing coverage across multiple perspectives before rendering a verdict.

The historical `harsh-critic` prompt was removed from the live agent registry during agent consolidation, so this benchmark now loads an archived prompt snapshot from `benchmarks/harsh-critic/prompts/harsh-critic.md`.

## Fixtures

8 fixtures across 3 domains:

| Domain | Count | Description |
|--------|-------|-------------|
| plans  | 3     | Auth migration plan, infrastructure scaling plan, API versioning plan |
| code   | 3     | Authentication middleware, data pipeline, rate limiter implementation |
| analysis | 2   | Performance analysis report, security threat model |

Each fixture has **deliberately embedded flaws** with a known ground truth list of gaps (stored in `ground-truth/`). The scoring system checks how many ground-truth gaps each agent detects.

**2 clean baselines** (one plan, one code) test false-positive resistance — agents should not flag non-issues in well-constructed artifacts.

## Scoring Methodology

Composite score across 7 dimensions (0–1 scale each):

| Dimension | Weight | Rationale |
|-----------|--------|-----------|
| True positive rate | 25% | Correctly identified known gaps |
| Missing coverage | 20% | Gaps the agent surfaced that weren't in ground truth but are valid |
| False negative rate | 15% | Known gaps the agent missed (inverted — lower miss rate is better) |
| Evidence rate | 10% | Claims backed by specific evidence from the artifact |
| Perspective coverage | 10% | Number of distinct perspectives examined (security, performance, ops, etc.) |
| Process compliance | 10% | Agent followed its own structured protocol |
| False positive rate | 10% | Flagged non-issues in clean baselines (inverted — lower is better) |

**Missing coverage is weighted highest** because it is the key differentiator between the agents. `harsh-critic`'s multi-perspective investigation protocol is specifically designed to surface gaps that a reviewer focused on a single angle would miss.

Scoring uses **keyword-based fuzzy matching** against ground truth entries. Each ground truth item has a list of signal keywords; a finding is counted as a true positive if it contains enough matching keywords.

## How to Run

```bash
# Full benchmark (both agents, all fixtures)
ANTHROPIC_API_KEY=sk-... npx tsx benchmarks/harsh-critic/run-benchmark.ts --agent both

# Single agent
npx tsx benchmarks/harsh-critic/run-benchmark.ts --agent harsh-critic
npx tsx benchmarks/harsh-critic/run-benchmark.ts --agent critic

# Single fixture
npx tsx benchmarks/harsh-critic/run-benchmark.ts --agent both --fixture plan-auth-migration

# Output goes to benchmarks/harsh-critic/results/ (gitignored)
```

Results are written to `benchmarks/harsh-critic/results/` as JSON files with timestamps.

## Interpreting Results

Each run produces a summary table with per-fixture breakdowns:

| Fixture | Critic Score | Harsh-Critic Score | Delta | Winner |
|---------|--------------|--------------------|-------|--------|
| plan-auth-migration | 0.61 | 0.78 | +0.17 | harsh-critic |
| ... | ... | ... | ... | ... |

- **Composite score**: 0–1 scale, higher is better
- **Delta**: harsh-critic score minus critic score (positive = harsh-critic better)
- **Win/Loss/Tie** per fixture (tie = delta within 0.05)
- **Key insight**: The metric with the largest improvement tells you which protocol element is doing the most work. If `missing_coverage` shows the largest delta, the multi-perspective investigation protocol is working. If `true_positive_rate` shows the largest delta, the structured output template is the driver.

## Reproducibility

LLM output varies between runs. Recommendations:

- Run 3x and average scores across runs for stable comparisons
- Pin the model version in `run-benchmark.ts` if you need reproducibility across time
- Results directory is gitignored — each run produces fresh output, old results are not tracked
- Scoring logic has its own vitest tests that run without an API key:

```bash
npx vitest run src/__tests__/benchmark-scoring
```

## Cost

- Approximately $3–5 per full benchmark run (8 fixtures × 2 agents × Opus)
- Use `--fixture` for targeted single-fixture runs during development (~$0.50–1.00 per fixture pair)
- `critic` runs cost slightly less than `harsh-critic` runs due to shorter system prompts and fewer output tokens
