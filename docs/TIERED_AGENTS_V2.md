# Tiered Agents v2 Architecture Design

## Overview

This document describes an improved tiered agent architecture that addresses current gaps and implements sophisticated patterns for model routing, capability inheritance, and dynamic escalation.

## Current Issues Identified

1. **Incomplete Inheritance**: Tiered agents don't inherit core behavioral patterns from base agents
2. **Inconsistent Tool Restrictions**: Tool restrictions vary without clear rationale
3. **Missing Escalation Signals**: No mechanism for agents to request escalation when overloaded
4. **Minimal Behavioral Instructions**: Tiered variants have too few instructions
5. **No Dynamic Routing in Markdown**: TypeScript router exists but markdown agents don't leverage it

## Design Principles

### 1. Template-Based Inheritance

Each tiered agent should inherit from a base template that provides:
- Core identity and role
- Fundamental constraints (read-only, no delegation, etc.)
- Output format requirements
- Quality standards

Tier-specific overrides then customize:
- Task complexity boundaries
- Tool restrictions
- Response depth/breadth
- Escalation thresholds

### 2. Explicit Capability Boundaries

Each tier has clear boundaries:

| Tier | Complexity | Response Depth | Self-Assessment |
|------|------------|----------------|-----------------|
| LOW (Haiku) | Simple, single-focus | Concise, direct | "Is this within my scope?" |
| MEDIUM (Sonnet) | Moderate, multi-step | Thorough, structured | "Can I handle this fully?" |
| HIGH (Opus) | Complex, system-wide | Comprehensive, nuanced | "What are the trade-offs?" |

### 3. Escalation Signals

Agents should recognize when to recommend escalation:

```markdown
<Escalation_Signals>
## When to Recommend Higher Tier

Escalate when you detect:
- Task exceeds your complexity boundary
- Multiple failed attempts (>2)
- Cross-system dependencies you can't trace
- Security-sensitive changes
- Irreversible operations

Output escalation recommendation:
**ESCALATION RECOMMENDED**: [reason] → Use [higher-tier-agent]
</Escalation_Signals>
```

### 4. Tool Capability Tiers

| Tool | LOW | MEDIUM | HIGH |
|------|-----|--------|------|
| Read | ✅ | ✅ | ✅ |
| Glob | ✅ | ✅ | ✅ |
| Grep | ✅ | ✅ | ✅ |
| Edit | ✅ (simple) | ✅ | ✅ |
| Write | ✅ (simple) | ✅ | ✅ |
| Bash | Limited | ✅ | ✅ |
| WebSearch | ❌ | ✅ | ✅ |
| WebFetch | ❌ | ✅ | ✅ |
| Task | ❌ | ❌ | Varies |
| TodoWrite | ✅ | ✅ | ✅ |

## Agent Family Templates

### Oracle Family (Analysis)

**Base Identity**: Strategic advisor, READ-ONLY consultant, diagnoses not implements

| Variant | Model | Tools | Focus |
|---------|-------|-------|-------|
| oracle-low | Haiku | Read, Glob, Grep | Quick lookups, single-file analysis |
| oracle-medium | Sonnet | + WebSearch, WebFetch | Standard analysis, dependency tracing |
| oracle | Opus | Full read access | Deep architecture analysis, system-wide patterns |

**Shared Constraints**:
- NO Write/Edit tools
- NO implementation
- MUST cite file:line references
- MUST provide actionable recommendations

**Tier-Specific Behaviors**:

```markdown
## oracle-low
- Answer direct questions quickly
- Single-file focus
- Output: Answer + Location + Context (3 lines max)
- Escalate if: cross-file dependencies, architecture questions

## oracle-medium
- Standard analysis workflow
- Multi-file tracing allowed
- Output: Summary + Findings + Diagnosis + Recommendations
- Escalate if: system-wide impact, security concerns, irreversible changes

## oracle (high)
- Deep architectural analysis
- System-wide pattern recognition
- Output: Full structured analysis with trade-offs
- No escalation needed (highest tier)
```

### Sisyphus-Junior Family (Execution)

**Base Identity**: Focused executor, works ALONE, no delegation, TODO obsessed

| Variant | Model | Tools | Focus |
|---------|-------|-------|-------|
| sisyphus-junior-low | Haiku | Read, Glob, Grep, Edit, Write, Bash, TodoWrite | Single-file, trivial changes |
| sisyphus-junior | Sonnet | Same | Multi-step, moderate complexity |
| sisyphus-junior-high | Opus | Same | Multi-file, complex refactoring |

**Shared Constraints**:
- Task tool BLOCKED (no delegation)
- MUST use TodoWrite for 2+ step tasks
- MUST verify after changes
- Works ALONE

**Tier-Specific Behaviors**:

```markdown
## sisyphus-junior-low
- Single-file edits only
- Trivial changes (typos, simple additions)
- Skip TodoWrite for <2 step tasks
- Escalate if: multi-file changes, complex logic, architectural decisions

## sisyphus-junior (medium)
- Multi-step tasks within a module
- Standard complexity
- Always use TodoWrite
- Escalate if: system-wide changes, cross-module dependencies

## sisyphus-junior-high
- Multi-file refactoring
- Complex architectural changes
- Deep analysis before changes
- No escalation needed (use oracle for consultation)
```

### Frontend-Engineer Family (UI/UX)

**Base Identity**: Designer-developer hybrid, sees what pure devs miss, creates memorable interfaces

| Variant | Model | Tools | Focus |
|---------|-------|-------|-------|
| frontend-engineer-low | Haiku | Read, Glob, Grep, Edit, Write, Bash | Simple styling, minor tweaks |
| frontend-engineer | Sonnet | Same | Standard UI work, components |
| frontend-engineer-high | Opus | Same | Design systems, complex architecture |

**Shared Constraints**:
- NEVER use generic fonts (Inter, Roboto, Arial)
- NEVER use cliched patterns (purple gradients)
- Match existing code patterns
- Production-quality output

**Tier-Specific Behaviors**:

```markdown
## frontend-engineer-low
- Simple CSS changes (colors, spacing, fonts)
- Minor component tweaks
- Match existing patterns exactly
- Escalate if: new component design, design system changes

## frontend-engineer (medium)
- Standard component work
- Apply design philosophy
- Make intentional aesthetic choices
- Escalate if: design system creation, complex state management

## frontend-engineer-high
- Design system architecture
- Complex component hierarchies
- Deep aesthetic reasoning
- Full creative latitude
```

### Librarian Family (Research)

**Base Identity**: External documentation researcher, searches EXTERNAL resources

| Variant | Model | Tools | Focus |
|---------|-------|-------|-------|
| librarian-low | Haiku | Read, Glob, Grep, WebSearch, WebFetch | Quick lookups |
| librarian | Sonnet | Same | Comprehensive research |

**Shared Constraints**:
- ALWAYS cite sources with URLs
- Prefer official docs
- Note version compatibility
- Flag outdated information

**Tier-Specific Behaviors**:

```markdown
## librarian-low
- Quick API lookups
- Find specific references
- Output: Answer + Source + Example (if applicable)
- Escalate if: comprehensive research needed, multiple sources required

## librarian (medium)
- Comprehensive research
- Multiple source synthesis
- Full structured output format
- No escalation needed for research tasks
```

### Explore Family (Search)

**Base Identity**: Codebase search specialist, finds files and code patterns

| Variant | Model | Tools | Focus |
|---------|-------|-------|-------|
| explore | Haiku | Read, Glob, Grep | Quick searches |
| explore (model=sonnet) | Sonnet | Same | Thorough analysis |

**Shared Constraints**:
- READ-ONLY
- Always use absolute paths
- Return structured results
- Address underlying need, not just literal request

**Tier-Specific Behaviors**:

```markdown
## explore (low)
- Quick pattern matching
- File location
- Parallel tool calls (3+)
- Escalate if: architecture understanding needed, cross-module analysis

## explore (model=sonnet)
- Thorough analysis
- Cross-reference findings
- Explain relationships
- No escalation needed
```

## Implementation Changes Required

### 1. Update Markdown Agent Files

Each tiered agent file should include:

```markdown
---
name: [agent]-[tier]
description: [tier-specific description]
tools: [restricted tool list]
model: [haiku|sonnet|opus]
---

<Inherits_From>
Base: [base-agent].md
</Inherits_From>

<Tier_Identity>
[Tier-specific role and focus]
</Tier_Identity>

<Complexity_Boundary>
You handle: [specific types of tasks]
Escalate when: [specific conditions]
</Complexity_Boundary>

[Tier-specific instructions...]

<Escalation_Protocol>
When you detect tasks beyond your scope, output:
**ESCALATION RECOMMENDED**: [reason] → Use oh-my-claude-sisyphus:[higher-tier]
</Escalation_Protocol>
```

### 2. Update TypeScript Router

The router should:
- Parse agent capabilities from markdown
- Match task signals to tier boundaries
- Provide escalation recommendations in output

### 3. Add Escalation Detection

The orchestrator should:
- Detect "ESCALATION RECOMMENDED" in agent output
- Automatically retry with recommended higher tier
- Log escalation patterns for optimization

## Cost Impact Analysis

Based on current pricing (Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 per million tokens):

| Scenario | Before (all Sonnet) | After (Tiered) | Savings |
|----------|---------------------|----------------|---------|
| Simple lookups (70%) | $3/$15 | $1/$5 (Haiku) | ~67% |
| Standard work (25%) | $3/$15 | $3/$15 (Sonnet) | 0% |
| Complex work (5%) | $3/$15 | $5/$25 (Opus) | -67% |
| **Weighted Average** | $3/$15 | ~$1.60/$8 | **~47%** |

Intelligent routing can reduce costs by ~47% while improving quality for complex tasks.

## Next Steps

1. Create updated markdown files for all tiered agents
2. Add escalation detection to hooks
3. Update router to use agent capability parsing
4. Add telemetry for tier usage optimization
5. Create tests for escalation scenarios
