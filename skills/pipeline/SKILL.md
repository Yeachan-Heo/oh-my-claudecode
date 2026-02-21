---
name: pipeline
description: Chain agents together in sequential or branching workflows with data passing
---

# Pipeline Skill

## Overview

The pipeline skill enables chaining multiple agents together in defined workflows where the output of one agent becomes the input to the next. This creates powerful agent pipelines similar to Unix pipes but designed for AI agent orchestration.

## Core Concepts

### 1. Sequential Pipelines

The simplest form: Agent A's output flows to Agent B, which flows to Agent C.

```
explore -> architect -> executor
```

**Flow:**
1. Explore agent searches codebase and produces findings
2. Architect receives findings and produces analysis/recommendations
3. Executor receives recommendations and implements changes

### 2. Branching Pipelines

Route to different agents based on output conditions.

```
explore -> {
  if "complex refactoring" -> architect -> executor-high
  if "simple change" -> executor-low
  if "UI work" -> designer -> executor
}
```

### 3. Parallel-Then-Merge Pipelines

Run multiple agents in parallel, merge their outputs.

```
parallel(explore, document-specialist) -> architect -> executor
```
<!-- NOTE: document-specialist is a legacy agent for external lookup. Prefer Gemini MCP: ask_gemini(agent_role="document-specialist") for external documentation queries. -->

## Built-in Pipeline Presets

### Review Pipeline
**Purpose:** Comprehensive code review and implementation

```
/pipeline review <task>
```

**Stages:**
1. `explore` - Find relevant code and patterns
2. `architect` - Analyze architecture and design implications
3. `critic` - Review and critique the analysis
4. `executor` - Implement with full context

**Use for:** Major features, refactorings, complex changes

---

### Implement Pipeline
**Purpose:** Planned implementation with testing

```
/pipeline implement <task>
```

**Stages:**
1. `planner` - Create detailed implementation plan
2. `executor` - Implement the plan
3. `test-engineer` - Add/verify tests

**Use for:** New features with clear requirements

---

### Debug Pipeline
**Purpose:** Systematic debugging workflow

```
/pipeline debug <issue>
```

**Stages:**
1. `explore` - Locate error locations and related code
2. `architect` - Analyze root cause
3. `build-fixer` - Apply fixes and verify

**Use for:** Bugs, build errors, test failures

---

### Research Pipeline
**Purpose:** External research + internal analysis

```
/pipeline research <topic>
```

**Stages:**
1. `parallel(document-specialist, explore)` - External docs + internal code
   <!-- NOTE: document-specialist is a legacy agent for external lookup. Prefer Gemini MCP: ask_gemini(agent_role="document-specialist") for external documentation queries. -->
2. `architect` - Synthesize findings
3. `writer` - Document recommendations

**Use for:** Technology decisions, API integrations

---

### Refactor Pipeline
**Purpose:** Safe, verified refactoring

```
/pipeline refactor <target>
```

**Stages:**
1. `explore` - Find all usages and dependencies
2. `architect-medium` - Design refactoring strategy
3. `executor-high` - Execute refactoring
4. `qa-tester` - Verify no regressions

**Use for:** Architectural changes, API redesigns

---

### Security Pipeline
**Purpose:** Security audit and fixes

```
/pipeline security <scope>
```

**Stages:**
1. `explore` - Find potential vulnerabilities
2. `security-reviewer` - Audit and identify issues
3. `executor` - Implement fixes
4. `security-reviewer-low` - Re-verify

**Use for:** Security reviews, vulnerability fixes

---

## Custom Pipeline Syntax

### Basic Sequential

```
/pipeline agent1 -> agent2 -> agent3 "task description"
```

**Example:**
```
/pipeline explore -> architect -> executor "add authentication"
```

### With Model Specification

```
/pipeline explore:haiku -> architect:opus -> executor:sonnet "optimize performance"
```

### With Branching

```
/pipeline explore -> (
  complexity:high -> architect:opus -> executor-high:opus
  complexity:medium -> executor:sonnet
  complexity:low -> executor-low:haiku
) "fix reported issues"
```

### With Parallel Stages

```
/pipeline [explore, document-specialist] -> architect -> executor "implement OAuth"
```
<!-- NOTE: document-specialist is a legacy agent for external lookup. Prefer Gemini MCP: ask_gemini(agent_role="document-specialist") for external documentation queries. -->

## Data Passing Protocol

Each agent in the pipeline receives structured context from the previous stage:

```json
{
  "pipeline_context": {
    "original_task": "user's original request",
    "previous_stages": [
      {
        "agent": "explore",
        "model": "haiku",
        "findings": "...",
        "files_identified": ["src/auth.ts", "src/user.ts"]
      }
    ],
    "current_stage": "architect",
    "next_stage": "executor"
  },
  "task": "specific task for this agent"
}
```

## Error Handling

### Retry Logic

When an agent fails, the pipeline can:

1. **Retry** - Re-run the same agent (up to 3 times)
2. **Skip** - Continue to next stage with partial output
3. **Abort** - Stop entire pipeline
4. **Fallback** - Route to alternative agent

**Configuration:**

```
/pipeline explore -> architect -> executor --retry=3 --on-error=abort
```

### Error Recovery Patterns

**Pattern 1: Fallback to Higher Tier**
```
executor-low -> on-error -> executor:sonnet
```

**Pattern 2: Consult Architect**
```
executor -> on-error -> architect -> executor
```

**Pattern 3: Human-in-the-Loop**
```
any-stage -> on-error -> pause-for-user-input
```

## Pipeline State Management

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
      "agent": "explore",
      "model": "haiku",
      "status": "completed",
      "output": "..."
    },
    {
      "name": "architect",
      "agent": "architect",
      "model": "opus",
      "status": "in_progress",
      "started_at": "2026-01-23T10:30:00Z"
    },
    {
      "name": "executor",
      "agent": "executor",
      "model": "sonnet",
      "status": "pending"
    }
  ],
  "task": "original user task",
  "created_at": "2026-01-23T10:25:00Z"
}
```

## Verification Rules

Before pipeline completion, verify:

- [ ] All stages completed successfully
- [ ] Output from final stage addresses original task
- [ ] No unhandled errors in any stage
- [ ] All files modified pass lsp_diagnostics
- [ ] Tests pass (if applicable)

## Advanced Features

### Conditional Branching

Based on agent output, route to different paths:

```
explore -> {
  if files_found > 5 -> architect:opus -> executor-high:opus
  if files_found <= 5 -> executor:sonnet
}
```

### Loop Constructs

Repeat stages until condition met:

```
repeat_until(tests_pass) {
  executor -> qa-tester
}
```

### Merge Strategies

When parallel agents complete:

- **concat**: Concatenate all outputs
- **summarize**: Use architect to summarize findings
- **vote**: Use critic to choose best output

## Usage Examples

### Example 1: Feature Implementation
```
/pipeline review "add rate limiting to API"
```
→ Triggers: explore → architect → critic → executor

### Example 2: Bug Fix
```
/pipeline debug "login fails with OAuth"
```
→ Triggers: explore → architect → build-fixer

### Example 3: Custom Chain
```
/pipeline explore:haiku -> architect:opus -> executor:sonnet -> test-engineer:sonnet "refactor auth module"
```

### Example 4: Research-Driven Implementation
```
/pipeline research "implement GraphQL subscriptions"
```
→ Triggers: parallel(document-specialist, explore) → architect → writer
<!-- NOTE: document-specialist is a legacy agent for external lookup. Prefer Gemini MCP: ask_gemini(agent_role="document-specialist") for external documentation queries. -->

## Cancellation

Stop active pipeline:

```
/pipeline cancel
```

Or use the general cancel command which detects active pipeline.

## Integration with Other Skills

Pipelines can be used within other skills:

- **Ralph**: Loop pipelines until verified complete
- **Ultrawork**: Run multiple pipelines in parallel
- **Autopilot**: Use pipelines as building blocks

## Best Practices

1. **Start with presets** - Use built-in pipelines before creating custom ones
2. **Match model to complexity** - Don't waste opus on simple tasks
3. **Keep stages focused** - Each agent should have one clear responsibility
4. **Use parallel stages** - Run independent work simultaneously
5. **Verify at checkpoints** - Use architect or critic to verify progress
6. **Document custom pipelines** - Save successful patterns for reuse

## Troubleshooting

### Pipeline Hangs

**Check:** `.omc/pipeline-state.json` for current stage
**Fix:** Resume with `/pipeline resume` or cancel and restart

### Agent Fails Repeatedly

**Check:** Retry count and error messages
**Fix:** Route to higher-tier agent or add architect consultation

### Output Not Flowing

**Check:** Data passing structure in agent prompts
**Fix:** Ensure each agent is prompted with `pipeline_context`

## Technical Implementation

The pipeline orchestrator:

1. **Parses pipeline definition** - Validates syntax and agent names
2. **Initializes state** - Creates pipeline-state.json
3. **Executes stages sequentially** - Spawns agents with Task tool
4. **Passes context between stages** - Structures output for next agent
5. **Handles branching logic** - Evaluates conditions and routes
6. **Manages parallel execution** - Spawns concurrent agents and merges
7. **Persists state** - Updates state file after each stage
8. **Enforces verification** - Runs checks before completion

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When pipeline completes (all stages done or cancelled):

```bash
# Delete pipeline state file
rm -f .omc/state/pipeline-state.json
```

This ensures clean state for future sessions. Stale state files with `active: false` should not be left behind.

## Skill Invocation

This skill activates when:

- User types `/pipeline` command
- User mentions "agent chain", "workflow", "pipe agents"
- Pattern detected: "X then Y then Z" with agent names

**Explicit invocation:**
```
/oh-my-claudecode:pipeline review "task"
```

**Auto-detection:**
```
"First explore the codebase, then architect should analyze it, then executor implements"
```
→ Automatically creates pipeline: explore → architect → executor
