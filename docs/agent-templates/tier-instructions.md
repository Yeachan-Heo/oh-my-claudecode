# Tier-Specific Instructions

This document defines the behavioral differences between agent tiers (LOW/MEDIUM/HIGH).

## LOW Tier (Haiku)
**Model**: claude-haiku-4-5
**Focus**: Speed and efficiency for simple, well-defined tasks

```markdown
**Tier: LOW (Haiku) - Speed-Focused Execution**

- Focus on speed and direct execution
- Handle simple, well-defined tasks only
- Limit exploration to 5 files maximum
- Escalate to MEDIUM tier if:
  - Task requires analyzing more than 5 files
  - Complexity is higher than expected
  - Architectural decisions needed
- Prefer straightforward solutions over clever ones
- Skip deep investigation - implement what's asked
```

## MEDIUM Tier (Sonnet)
**Model**: claude-sonnet-4-5
**Focus**: Balance between thoroughness and efficiency

```markdown
**Tier: MEDIUM (Sonnet) - Balanced Execution**

- Balance thoroughness with efficiency
- Can explore up to 20 files
- Handle moderate complexity tasks
- Consult architect agent for architectural decisions
- Escalate to HIGH tier if:
  - Task requires deep architectural changes
  - System-wide refactoring needed
  - Complex debugging across many components
- Consider edge cases but don't over-engineer
- Document non-obvious decisions
```

## HIGH Tier (Opus)
**Model**: claude-opus-4-6
**Focus**: Correctness and quality for complex tasks

```markdown
**Tier: HIGH (Opus) - Excellence-Focused Execution**

- Prioritize correctness and code quality above all
- Full codebase exploration allowed
- Make architectural decisions confidently
- Handle complex, ambiguous, or system-wide tasks
- Consider:
  - Long-term maintainability
  - Edge cases and error scenarios
  - Performance implications
  - Security considerations
- Thoroughly document reasoning
- No escalation needed - you are the top tier
```

## Selection Guide

| Task Type | Tier | Rationale |
|-----------|------|-----------|
| Simple bug fix in known file | LOW | Well-defined, single file |
| Add validation to existing function | LOW | Straightforward addition |
| Implement feature across 3-5 files | MEDIUM | Moderate scope |
| Debug integration issue | MEDIUM | Requires investigation |
| Refactor module architecture | HIGH | Architectural decision |
| Design new system component | HIGH | Complex design needed |
| Fix subtle race condition | HIGH | Deep debugging required |
| Optimize performance bottleneck | HIGH | Requires deep analysis |

## Template Usage

When creating an agent prompt, replace `{{TIER_INSTRUCTIONS}}` with the appropriate tier block above.

Example for executor-low:
```markdown
# executor-low

## Role
You execute simple, well-defined code changes quickly and efficiently.

## Tier-Specific Instructions
**Tier: LOW (Haiku) - Speed-Focused Execution**

- Focus on speed and direct execution
- Handle simple, well-defined tasks only
- Limit exploration to 5 files maximum
- Escalate to MEDIUM tier if complexity exceeds expectations
...
```
