---
description: Orchestrate parallel scientist agents for comprehensive research with AUTO mode
---

# Research Skill

[RESEARCH MODE ACTIVATED]

Orchestrate parallel scientist agents for comprehensive research workflows with optional AUTO mode for fully autonomous execution.

## Usage Examples

```
/oh-my-claudecode:research <goal>                    # Standard research with user checkpoints
/oh-my-claudecode:research AUTO: <goal>              # Fully autonomous until complete
/oh-my-claudecode:research status                    # Check current research session status
/oh-my-claudecode:research resume                    # Resume interrupted research session
/oh-my-claudecode:research list                      # List all research sessions
/oh-my-claudecode:research report <session-id>       # Generate report for session
```

## Research Protocol

### Stage Decomposition

When given a research goal, decompose into 3-7 independent stages:

1. **Decomposition** - Break research goal into independent stages/hypotheses
2. **Execution** - Run parallel scientist agents on each stage
3. **Verification** - Cross-validate findings, check consistency
4. **Synthesis** - Aggregate results into comprehensive report

### Parallel Scientist Invocation

Fire independent stages in parallel via Task tool:

```
// Stage 1 - Simple data gathering
Task(subagent_type="oh-my-claudecode:scientist", model="haiku", prompt="[RESEARCH_STAGE:1] Investigate...")

// Stage 2 - Standard analysis
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="[RESEARCH_STAGE:2] Analyze...")

// Stage 3 - Complex reasoning
Task(subagent_type="oh-my-claudecode:scientist-high", model="opus", prompt="[RESEARCH_STAGE:3] Deep analysis of...")
```

### Smart Model Routing

| Task Complexity | Agent | Model | Use For |
|-----------------|-------|-------|---------|
| Data gathering | `scientist` (model=haiku) | haiku | File enumeration, pattern counting, simple lookups |
| Standard analysis | `scientist` | sonnet | Code analysis, pattern detection, documentation review |
| Complex reasoning | `scientist-high` | opus | Architecture analysis, cross-cutting concerns, hypothesis validation |

### Concurrency Limit

**Maximum 20 concurrent scientist agents** to prevent resource exhaustion.

## AUTO Mode

AUTO mode runs the complete research workflow autonomously with loop control.

### Promise Tags

| Tag | Meaning | When to Use |
|-----|---------|-------------|
| `[PROMISE:RESEARCH_COMPLETE]` | Research finished successfully | All stages done, verified, report generated |
| `[PROMISE:RESEARCH_BLOCKED]` | Cannot proceed | Missing data, access issues, circular dependency |

### AUTO Mode Rules

1. **Max Iterations:** 10
2. **Continue until:** Promise tag emitted OR max iterations
3. **State tracking:** Persist after each stage completion
4. **Cancellation:** `/oh-my-claudecode:cancel` or "stop", "cancel"

## Session Management

Sessions are stored at `.omc/research/{session-id}/` with:
- `state.json` - Session state and progress
- `stages/` - Individual stage findings
- `findings/` - Raw and verified findings
- `report.md` - Final synthesized report

## Cancellation

```
/oh-my-claudecode:cancel
```

Or say: "stop research", "cancel research", "abort"

Progress is preserved for resume.

---

Research goal:
{{PROMPT}}
