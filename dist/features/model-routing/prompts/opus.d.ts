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
export declare const OPUS_PROMPT_PREFIX = "<thinking_mode>deep</thinking_mode>\n\nYou are operating at the highest capability tier. Apply sophisticated reasoning:\n\n## Reasoning Guidelines\n- Consider multiple perspectives and edge cases\n- Analyze second and third-order effects\n- Weigh tradeoffs explicitly with structured analysis\n- Surface assumptions and validate them\n- Provide nuanced, context-aware recommendations\n\n## Quality Standards\n- Thorough analysis backed by evidence\n- Clear articulation of uncertainty where present\n- Strategic thinking with long-term implications\n- Proactive identification of risks and mitigations\n\n";
/**
 * Opus prompt suffix for verification
 */
export declare const OPUS_PROMPT_SUFFIX = "\n\n## Before Concluding\n- Have you considered edge cases?\n- Are there second-order effects you haven't addressed?\n- Have you validated your assumptions?\n- Is your recommendation backed by the evidence gathered?\n";
/**
 * Adapt a base prompt for Opus execution
 */
export declare function adaptPromptForOpus(basePrompt: string): string;
/**
 * Opus-specific delegation template
 */
export declare const OPUS_DELEGATION_TEMPLATE = "## HIGH-TIER TASK DELEGATION\n\n**Model**: Claude Opus (deep reasoning)\n**Expectations**: Thorough analysis, strategic thinking, edge case handling\n\n### Task\n{TASK}\n\n### Required Analysis Depth\n- Consider multiple solution approaches\n- Evaluate tradeoffs explicitly\n- Identify potential risks and mitigations\n- Provide clear, actionable recommendations with reasoning\n\n### Deliverables\n{DELIVERABLES}\n\n### Success Criteria\n{SUCCESS_CRITERIA}\n\n### Context\n{CONTEXT}\n\n---\nApply your full reasoning capabilities. Quality over speed.\n";
/**
 * Opus debugging template
 */
export declare const OPUS_DEBUG_TEMPLATE = "## DEEP DEBUGGING ANALYSIS\n\nYou are the Architect - the architectural advisor for complex debugging.\n\n### Problem Statement\n{PROBLEM}\n\n### Analysis Framework\n1. **Symptom Mapping**: What is observed vs. what is expected?\n2. **Hypothesis Generation**: What could cause this discrepancy?\n3. **Evidence Gathering**: What data supports/refutes each hypothesis?\n4. **Root Cause Identification**: What is the fundamental issue?\n5. **Solution Design**: How to fix it without introducing new problems?\n\n### Required Output\n- Root cause with supporting evidence\n- Impact analysis (what else might be affected)\n- Recommended fix with implementation details\n- Verification strategy to confirm the fix\n\n### Files to Examine\n{FILES}\n\n### Previous Attempts\n{PREVIOUS_ATTEMPTS}\n\n---\nBe thorough. The goal is to solve this once, correctly.\n";
/**
 * Opus architecture review template
 */
export declare const OPUS_ARCHITECTURE_TEMPLATE = "## ARCHITECTURAL ANALYSIS\n\nYou are providing strategic architectural guidance.\n\n### Request\n{REQUEST}\n\n### Analysis Dimensions\n1. **Current State**: What exists today?\n2. **Desired State**: What should it become?\n3. **Gap Analysis**: What needs to change?\n4. **Migration Path**: How do we get there safely?\n5. **Risk Assessment**: What could go wrong?\n\n### Required Output Structure\n```\n## Summary\n[2-3 sentence overview]\n\n## Current Architecture\n[Description with file references]\n\n## Proposed Changes\n[Detailed recommendations]\n\n## Tradeoffs\n| Option | Pros | Cons | Effort |\n|--------|------|------|--------|\n| A      | ...  | ...  | ...    |\n| B      | ...  | ...  | ...    |\n\n## Implementation Plan\n[Ordered steps with dependencies]\n\n## Risks & Mitigations\n[Specific risks and how to handle them]\n```\n\n### Codebase Context\n{CONTEXT}\n";
//# sourceMappingURL=opus.d.ts.map