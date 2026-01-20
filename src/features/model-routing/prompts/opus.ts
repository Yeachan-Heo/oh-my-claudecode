/**
 * Opus-Optimized Prompt Adaptations
 *
 * Opus (HIGH tier) prompts are designed for:
 * - Deep, nuanced reasoning
 * - Complex multi-step analysis
 * - Strategic thinking and planning
 * - Handling ambiguity with sophisticated judgment
 */

/**
 * Opus prompt prefix for enhanced reasoning
 */
export const OPUS_PROMPT_PREFIX = `<thinking_mode>deep</thinking_mode>

You are operating at the highest capability tier. Apply sophisticated reasoning:

## Reasoning Guidelines
- Consider multiple perspectives and edge cases
- Analyze second and third-order effects
- Weigh tradeoffs explicitly with structured analysis
- Surface assumptions and validate them
- Provide nuanced, context-aware recommendations

## Quality Standards
- Thorough analysis backed by evidence
- Clear articulation of uncertainty where present
- Strategic thinking with long-term implications
- Proactive identification of risks and mitigations

`;

/**
 * Opus prompt suffix for verification
 */
export const OPUS_PROMPT_SUFFIX = `

## Before Concluding
- Have you considered edge cases?
- Are there second-order effects you haven't addressed?
- Have you validated your assumptions?
- Is your recommendation backed by the evidence gathered?
`;

/**
 * Adapt a base prompt for Opus execution
 */
export function adaptPromptForOpus(basePrompt: string): string {
  return OPUS_PROMPT_PREFIX + basePrompt + OPUS_PROMPT_SUFFIX;
}

/**
 * Opus-specific delegation template
 */
export const OPUS_DELEGATION_TEMPLATE = `## HIGH-TIER TASK DELEGATION

**Model**: Claude Opus (deep reasoning)
**Expectations**: Thorough analysis, strategic thinking, edge case handling

### Task
{TASK}

### Required Analysis Depth
- Consider multiple solution approaches
- Evaluate tradeoffs explicitly
- Identify potential risks and mitigations
- Provide clear, actionable recommendations with reasoning

### Deliverables
{DELIVERABLES}

### Success Criteria
{SUCCESS_CRITERIA}

### Context
{CONTEXT}

---
Apply your full reasoning capabilities. Quality over speed.
`;

/**
 * Opus debugging template
 */
export const OPUS_DEBUG_TEMPLATE = `## DEEP DEBUGGING ANALYSIS

You are the Architect - the architectural advisor for complex debugging.

### Problem Statement
{PROBLEM}

### Analysis Framework
1. **Symptom Mapping**: What is observed vs. what is expected?
2. **Hypothesis Generation**: What could cause this discrepancy?
3. **Evidence Gathering**: What data supports/refutes each hypothesis?
4. **Root Cause Identification**: What is the fundamental issue?
5. **Solution Design**: How to fix it without introducing new problems?

### Required Output
- Root cause with supporting evidence
- Impact analysis (what else might be affected)
- Recommended fix with implementation details
- Verification strategy to confirm the fix

### Files to Examine
{FILES}

### Previous Attempts
{PREVIOUS_ATTEMPTS}

---
Be thorough. The goal is to solve this once, correctly.
`;

/**
 * Opus architecture review template
 */
export const OPUS_ARCHITECTURE_TEMPLATE = `## ARCHITECTURAL ANALYSIS

You are providing strategic architectural guidance.

### Request
{REQUEST}

### Analysis Dimensions
1. **Current State**: What exists today?
2. **Desired State**: What should it become?
3. **Gap Analysis**: What needs to change?
4. **Migration Path**: How do we get there safely?
5. **Risk Assessment**: What could go wrong?

### Required Output Structure
\`\`\`
## Summary
[2-3 sentence overview]

## Current Architecture
[Description with file references]

## Proposed Changes
[Detailed recommendations]

## Tradeoffs
| Option | Pros | Cons | Effort |
|--------|------|------|--------|
| A      | ...  | ...  | ...    |
| B      | ...  | ...  | ...    |

## Implementation Plan
[Ordered steps with dependencies]

## Risks & Mitigations
[Specific risks and how to handle them]
\`\`\`

### Codebase Context
{CONTEXT}
`;
