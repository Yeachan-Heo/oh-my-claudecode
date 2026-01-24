---
description: Sequential agent chaining with data passing between stages
aliases: [pipe, chain]
---

# Pipeline Command

[PIPELINE MODE ACTIVATED]

Chain multiple agents together in sequential workflows where output from one agent flows to the next. Like Unix pipes for AI agents.

## User's Request

{{ARGUMENTS}}

## Mission

Execute a pipeline of agents where each stage receives context from previous stages and passes refined output to the next.

## Usage Patterns

### Built-in Presets

Use predefined pipelines for common workflows:

```
/oh-my-claudecode:pipeline review <task>
/oh-my-claudecode:pipeline implement <task>
/oh-my-claudecode:pipeline debug <issue>
/oh-my-claudecode:pipeline research <topic>
/oh-my-claudecode:pipeline refactor <target>
/oh-my-claudecode:pipeline security <scope>
```

### Custom Pipelines

Define your own agent sequence:

```
/oh-my-claudecode:pipeline explore -> architect -> executor "add authentication"
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> executor:sonnet "optimize performance"
```

### With Parallel Stages

Run agents in parallel then merge:

```
/oh-my-claudecode:pipeline [explore, researcher] -> architect -> executor "implement OAuth"
```

## Built-in Pipeline Definitions

### Review Pipeline
**Stages:** explore → architect → critic → executor
**Use for:** Comprehensive code review and implementation

### Implement Pipeline
**Stages:** planner → executor → tdd-guide
**Use for:** New features with clear requirements

### Debug Pipeline
**Stages:** explore → architect → build-fixer
**Use for:** Bugs, build errors, test failures

### Research Pipeline
**Stages:** parallel(researcher, explore) → architect → writer
**Use for:** Technology decisions, API integrations

### Refactor Pipeline
**Stages:** explore → architect-medium → executor-high → qa-tester
**Use for:** Architectural changes, API redesigns

### Security Pipeline
**Stages:** explore → security-reviewer → executor → security-reviewer-low
**Use for:** Security audits and vulnerability fixes

## Pipeline State

Pipelines maintain state in `.omc/pipeline-state.json`:

```json
{
  "pipeline_id": "uuid",
  "name": "review",
  "active": true,
  "current_stage": 2,
  "stages": [
    {
      "name": "explore",
      "status": "completed",
      "output": "..."
    },
    {
      "name": "architect",
      "status": "in_progress"
    },
    {
      "name": "executor",
      "status": "pending"
    }
  ]
}
```

## Data Passing Protocol

Each agent receives structured context:

```json
{
  "pipeline_context": {
    "original_task": "user's request",
    "previous_stages": [
      {
        "agent": "explore",
        "findings": "...",
        "files_identified": ["src/auth.ts"]
      }
    ],
    "current_stage": "architect",
    "next_stage": "executor"
  }
}
```

## Workflow

### 1. Parse Pipeline Definition

Extract:
- Pipeline name (preset) or custom agent sequence
- Model specifications for each stage
- Task description

### 2. Initialize State

Create `.omc/pipeline-state.json` with:
- Unique pipeline ID
- Stage definitions
- Status tracking

### 3. Execute Stages Sequentially

For each stage:
1. Spawn agent via Task tool
2. Pass context from previous stages
3. Collect output
4. Update pipeline state
5. Move to next stage

### 4. Handle Parallel Stages

When parallel stages detected (e.g., `[explore, researcher]`):
1. Spawn multiple agents with `run_in_background: true`
2. Wait for all to complete
3. Merge outputs (concat or summarize)
4. Pass merged output to next stage

### 5. Verify and Complete

Before completion:
- All stages marked "completed"
- Output from final stage addresses original task
- No unhandled errors
- Modified files pass lsp_diagnostics
- Tests pass (if applicable)

## Error Handling

When a stage fails:
- **Retry** - Re-run same agent (up to 3 times)
- **Fallback** - Route to higher-tier agent
- **Abort** - Stop entire pipeline

Configuration:
```
/pipeline explore -> architect -> executor --retry=3 --on-error=abort
```

## Cancellation

Stop active pipeline:
```
/oh-my-claudecode:cancel
```

The unified cancel command auto-detects active pipeline and cleans up state.

## Examples

### Example 1: Feature Implementation
```
/oh-my-claudecode:pipeline review "add rate limiting to API"
```
Triggers: explore → architect → critic → executor

### Example 2: Bug Fix
```
/oh-my-claudecode:pipeline debug "login fails with OAuth"
```
Triggers: explore → architect → build-fixer

### Example 3: Custom Chain
```
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> executor:sonnet -> tdd-guide:sonnet "refactor auth module"
```

### Example 4: Research-Driven Implementation
```
/oh-my-claudecode:pipeline research "implement GraphQL subscriptions"
```
Triggers: parallel(researcher, explore) → architect → writer

## Best Practices

1. **Start with presets** - Use built-in pipelines before custom ones
2. **Match model to complexity** - haiku for simple, opus for complex
3. **Keep stages focused** - One clear responsibility per agent
4. **Use parallel stages** - Run independent work simultaneously
5. **Verify at checkpoints** - Use architect or critic to verify progress
6. **Document custom pipelines** - Save successful patterns for reuse

## Output

Report when complete:
- Pipeline name and stages executed
- Output from each stage
- Final result
- Verification status
- Total time elapsed
