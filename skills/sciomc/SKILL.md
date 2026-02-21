---
name: sciomc
description: Orchestrate parallel scientist agents for comprehensive analysis with AUTO mode
argument-hint: <research goal>
---

# Research Skill

Orchestrate parallel scientist agents for comprehensive research workflows with optional AUTO mode for fully autonomous execution.

## Overview

Research is a multi-stage workflow that decomposes complex research goals into parallel investigations:

1. **Decomposition** - Break research goal into independent stages/hypotheses
2. **Execution** - Run parallel scientist agents on each stage
3. **Verification** - Cross-validate findings, check consistency
4. **Synthesis** - Aggregate results into comprehensive report

## Usage Examples

```
/oh-my-claudecode:sciomc <goal>                    # Standard research with user checkpoints
/oh-my-claudecode:sciomc AUTO: <goal>              # Fully autonomous until complete
/oh-my-claudecode:sciomc status                    # Check current research session status
/oh-my-claudecode:sciomc resume                    # Resume interrupted research session
/oh-my-claudecode:sciomc list                      # List all research sessions
/oh-my-claudecode:sciomc report <session-id>       # Generate report for session
```

### Quick Examples

```
/oh-my-claudecode:sciomc What are the performance characteristics of different sorting algorithms?
/oh-my-claudecode:sciomc AUTO: Analyze authentication patterns in this codebase
/oh-my-claudecode:sciomc How does the error handling work across the API layer?
```

## Research Protocol

### Stage Decomposition Pattern

When given a research goal, decompose into 3-7 independent stages:

```markdown
## Research Decomposition

**Goal:** <original research goal>

### Stage 1: <stage-name>
- **Focus:** What this stage investigates
- **Hypothesis:** Expected finding (if applicable)
- **Scope:** Files/areas to examine
- **Tier:** LOW | MEDIUM | HIGH

### Stage 2: <stage-name>
...
```

### Parallel Scientist Invocation

Fire independent stages in parallel via Task tool:

```
// Stage 1 - Simple data gathering
Task(subagent_type="oh-my-claudecode:scientist", model="haiku", prompt="[RESEARCH_STAGE:1] Investigate...")

// Stage 2 - Standard analysis
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="[RESEARCH_STAGE:2] Analyze...")

// Stage 3 - Complex reasoning
Task(subagent_type="oh-my-claudecode:scientist", model="opus", prompt="[RESEARCH_STAGE:3] Deep analysis of...")
```

### Smart Model Routing

**CRITICAL: Always pass `model` parameter explicitly!**

| Task Complexity | Agent | Model | Use For |
|-----------------|-------|-------|---------|
| Data gathering | `scientist` (model=haiku) | haiku | File enumeration, pattern counting, simple lookups |
| Standard analysis | `scientist` | sonnet | Code analysis, pattern detection, documentation review |
| Complex reasoning | `scientist` | opus | Architecture analysis, cross-cutting concerns, hypothesis validation |

### Routing Decision Guide

| Research Task | Tier | Example Prompt |
|---------------|------|----------------|
| "Count occurrences of X" | LOW | "Count all usages of useState hook" |
| "Find all files matching Y" | LOW | "List all test files in the project" |
| "Analyze pattern Z" | MEDIUM | "Analyze error handling patterns in API routes" |
| "Document how W works" | MEDIUM | "Document the authentication flow" |
| "Explain why X happens" | HIGH | "Explain why race conditions occur in the cache layer" |
| "Compare approaches A vs B" | HIGH | "Compare Redux vs Context for state management here" |

### Verification Loop

After parallel execution completes, verify findings:

```
// Cross-validation stage
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="
[RESEARCH_VERIFICATION]
Cross-validate these findings for consistency:

Stage 1 findings: <summary>
Stage 2 findings: <summary>
Stage 3 findings: <summary>

Check for:
1. Contradictions between stages
2. Missing connections
3. Gaps in coverage
4. Evidence quality

Output: [VERIFIED] or [CONFLICTS:<list>]
")
```

## AUTO Mode

AUTO mode runs the complete research workflow autonomously with loop control.

### Loop Control Protocol

```
[RESEARCH + AUTO - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working.

Current state: {{STATE}}
Completed stages: {{COMPLETED_STAGES}}
Pending stages: {{PENDING_STAGES}}
```

### Promise Tags

| Tag | Meaning | When to Use |
|-----|---------|-------------|
| `[PROMISE:RESEARCH_COMPLETE]` | Research finished successfully | All stages done, verified, report generated |
| `[PROMISE:RESEARCH_BLOCKED]` | Cannot proceed | Missing data, access issues, circular dependency |

### AUTO Mode Rules

1. **Max Iterations:** 10 (configurable)
2. **Continue until:** Promise tag emitted OR max iterations
3. **State tracking:** Persist after each stage completion
4. **Cancellation:** `/oh-my-claudecode:cancel` or "stop", "cancel"

### AUTO Mode Example

```
/oh-my-claudecode:sciomc AUTO: Comprehensive security analysis of the authentication system

[Decomposition]
- Stage 1 (LOW): Enumerate auth-related files
- Stage 2 (MEDIUM): Analyze token handling
- Stage 3 (MEDIUM): Review session management
- Stage 4 (HIGH): Identify vulnerability patterns
- Stage 5 (MEDIUM): Document security controls

[Execution - Parallel]
Firing stages 1-3 in parallel...
Firing stages 4-5 after dependencies complete...

[Verification]
Cross-validating findings...

[Synthesis]
Generating report...

[PROMISE:RESEARCH_COMPLETE]
```

## Parallel Execution Patterns

### Independent Dataset Analysis (Parallel)

When stages analyze different data sources:

```
// All fire simultaneously
Task(subagent_type="oh-my-claudecode:scientist", model="haiku", prompt="[STAGE:1] Analyze src/api/...")
Task(subagent_type="oh-my-claudecode:scientist", model="haiku", prompt="[STAGE:2] Analyze src/utils/...")
Task(subagent_type="oh-my-claudecode:scientist", model="haiku", prompt="[STAGE:3] Analyze src/components/...")
```

### Hypothesis Battery (Parallel)

When testing multiple hypotheses:

```
// Test hypotheses simultaneously
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="[HYPOTHESIS:A] Test if caching improves...")
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="[HYPOTHESIS:B] Test if batching reduces...")
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="[HYPOTHESIS:C] Test if lazy loading helps...")
```

### Cross-Validation (Sequential)

When verification depends on all findings:

```
// Wait for all parallel stages
[stages complete]

// Then sequential verification
Task(subagent_type="oh-my-claudecode:scientist", model="opus", prompt="
[CROSS_VALIDATION]
Validate consistency across all findings:
- Finding 1: ...
- Finding 2: ...
- Finding 3: ...
")
```

### Concurrency Limit

**Maximum 20 concurrent scientist agents** to prevent resource exhaustion.

If more than 20 stages, batch them:
```
Batch 1: Stages 1-5 (parallel)
[wait for completion]
Batch 2: Stages 6-7 (parallel)
```

## Session Management

### Directory Structure

```
.omc/research/{session-id}/
  state.json              # Session state and progress
  stages/
    stage-1.md            # Stage 1 findings
    stage-2.md            # Stage 2 findings
    ...
  findings/
    raw/                  # Raw findings from scientists
    verified/             # Post-verification findings
  figures/
    figure-1.png          # Generated visualizations
    ...
  report.md               # Final synthesized report
```

### State File Format

```json
{
  "id": "research-20240115-abc123",
  "goal": "Original research goal",
  "status": "in_progress | complete | blocked | cancelled",
  "mode": "standard | auto",
  "iteration": 3,
  "maxIterations": 10,
  "stages": [
    {
      "id": 1,
      "name": "Stage name",
      "tier": "LOW | MEDIUM | HIGH",
      "status": "pending | running | complete | failed",
      "startedAt": "ISO timestamp",
      "completedAt": "ISO timestamp",
      "findingsFile": "stages/stage-1.md"
    }
  ],
  "verification": {
    "status": "pending | passed | failed",
    "conflicts": [],
    "completedAt": "ISO timestamp"
  },
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

### Session Commands

| Command | Action |
|---------|--------|
| `/oh-my-claudecode:sciomc status` | Show current session progress |
| `/oh-my-claudecode:sciomc resume` | Resume most recent interrupted session |
| `/oh-my-claudecode:sciomc resume <session-id>` | Resume specific session |
| `/oh-my-claudecode:sciomc list` | List all sessions with status |
| `/oh-my-claudecode:sciomc report <session-id>` | Generate/regenerate report |
| `/oh-my-claudecode:sciomc cancel` | Cancel current session (preserves state) |

## Tag Extraction

Scientists use structured tags for findings. Extract them with these patterns:

### Finding Tags

```
[FINDING:<id>] <title>
<evidence and analysis>
[/FINDING]

[EVIDENCE:<finding-id>]
- File: <path>
- Lines: <range>
- Content: <relevant code/text>
[/EVIDENCE]

[CONFIDENCE:<level>] # HIGH | MEDIUM | LOW
<reasoning for confidence level>
```

### Extraction Regex Patterns

```javascript
// Finding extraction
const findingPattern = /\[FINDING:(\w+)\]\s*(.*?)\n([\s\S]*?)\[\/FINDING\]/g;

// Evidence extraction
const evidencePattern = /\[EVIDENCE:(\w+)\]([\s\S]*?)\[\/EVIDENCE\]/g;

// Confidence extraction
const confidencePattern = /\[CONFIDENCE:(HIGH|MEDIUM|LOW)\]\s*(.*)/g;

// Stage completion
const stageCompletePattern = /\[STAGE_COMPLETE:(\d+)\]/;

// Verification result
const verificationPattern = /\[(VERIFIED|CONFLICTS):?(.*?)\]/;
```

### Evidence Window

When extracting evidence, include context window:

```
[EVIDENCE:F1]
- File: /src/auth/login.ts
- Lines: 45-52 (context: 40-57)
- Content:
  ```typescript
  // Lines 45-52 with 5 lines context above/below
  ```
[/EVIDENCE]
```

### Quality Validation

Findings must meet quality threshold:

| Quality Check | Requirement |
|---------------|-------------|
| Evidence present | At least 1 [EVIDENCE] per [FINDING] |
| Confidence stated | Each finding has [CONFIDENCE] |
| Source cited | File paths are absolute and valid |
| Reproducible | Another agent could verify |

## Report Generation

### Report Template

```markdown
# Research Report: {{GOAL}}

**Session ID:** {{SESSION_ID}}
**Date:** {{DATE}}
**Status:** {{STATUS}}

## Executive Summary

{{2-3 paragraph summary of key findings}}

## Methodology

### Research Stages

| Stage | Focus | Tier | Status |
|-------|-------|------|--------|
{{STAGES_TABLE}}

### Approach

{{Description of decomposition rationale and execution strategy}}

## Key Findings

### Finding 1: {{TITLE}}

**Confidence:** {{HIGH|MEDIUM|LOW}}

{{Detailed finding with evidence}}

#### Evidence

{{Embedded evidence blocks}}

### Finding 2: {{TITLE}}
...

## Visualizations

{{FIGURES}}

## Cross-Validation Results

{{Verification summary, any conflicts resolved}}

## Limitations

- {{Limitation 1}}
- {{Limitation 2}}
- {{Areas not covered and why}}

## Recommendations

1. {{Actionable recommendation}}
2. {{Actionable recommendation}}

## Appendix

### Raw Data

{{Links to raw findings files}}

### Session State

{{Link to state.json}}
```

### Figure Embedding Protocol

Scientists generate visualizations using this marker:

```
[FIGURE:path/to/figure.png]
Caption: Description of what the figure shows
Alt: Accessibility description
[/FIGURE]
```

Report generator embeds figures:

```markdown
## Visualizations

![Figure 1: Description](figures/figure-1.png)
*Caption: Description of what the figure shows*

![Figure 2: Description](figures/figure-2.png)
*Caption: Description of what the figure shows*
```

### Figure Types

| Type | Use For | Generated By |
|------|---------|--------------|
| Architecture diagram | System structure | scientist |
| Flow chart | Process flows | scientist |
| Dependency graph | Module relationships | scientist |
| Timeline | Sequence of events | scientist |
| Comparison table | A vs B analysis | scientist |

## Configuration

Optional settings in `.claude/settings.json`:

```json
{
  "omc": {
    "research": {
      "maxIterations": 10,
      "maxConcurrentScientists": 5,
      "defaultTier": "MEDIUM",
      "autoVerify": true,
      "generateFigures": true,
      "evidenceContextLines": 5
    }
  }
}
```

## Cancellation

```
/oh-my-claudecode:cancel
```

Or say: "stop research", "cancel research", "abort"

Progress is preserved in `.omc/research/{session-id}/` for resume.

## Troubleshooting

**Stuck in verification loop?**
- Check for conflicting findings between stages
- Review state.json for specific conflicts
- May need to re-run specific stages with different approach

**Scientists returning low-quality findings?**
- Check tier assignment - complex analysis needs HIGH tier
- Ensure prompts include clear scope and expected output format
- Review if research goal is too broad

**AUTO mode exhausted iterations?**
- Review state to see where it's stuck
- Check if goal is achievable with available data
- Consider breaking into smaller research sessions

**Missing figures in report?**
- Verify figures/ directory exists
- Check [FIGURE:] tags in findings
- Ensure paths are relative to session directory
