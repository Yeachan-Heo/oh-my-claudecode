/**
 * Sonnet-Optimized Prompt Adaptations
 *
 * Sonnet (MEDIUM tier) prompts are designed for:
 * - Balanced reasoning with good speed
 * - Focused task execution
 * - Clear deliverables with structured output
 * - Efficient multi-step workflows
 */
/**
 * Sonnet prompt prefix for focused execution
 */
export declare const SONNET_PROMPT_PREFIX = "## Task Execution Mode\n\nExecute this task efficiently with clear deliverables:\n\n";
/**
 * Sonnet prompt suffix for verification
 */
export declare const SONNET_PROMPT_SUFFIX = "\n\n---\nFocus on delivering the requested outcome. Be thorough but efficient.\n";
/**
 * Adapt a base prompt for Sonnet execution
 */
export declare function adaptPromptForSonnet(basePrompt: string): string;
/**
 * Sonnet delegation template
 */
export declare const SONNET_DELEGATION_TEMPLATE = "## TASK DELEGATION\n\n**Tier**: MEDIUM (balanced)\n\n### Task\n{TASK}\n\n### Expected Outcome\n{DELIVERABLES}\n\n### Success Criteria\n{SUCCESS_CRITERIA}\n\n### Context\n{CONTEXT}\n\n### Required Tools\n{TOOLS}\n\n### Constraints\n- MUST DO: {MUST_DO}\n- MUST NOT DO: {MUST_NOT}\n\n---\nExecute efficiently. Report completion status.\n";
/**
 * Sonnet implementation template
 */
export declare const SONNET_IMPLEMENTATION_TEMPLATE = "## IMPLEMENTATION TASK\n\n### What to Build\n{TASK}\n\n### Acceptance Criteria\n{CRITERIA}\n\n### Approach\n1. Read relevant files to understand patterns\n2. Plan changes before making them\n3. Implement following existing conventions\n4. Verify changes work correctly\n\n### Files to Modify\n{FILES}\n\n### Existing Patterns to Follow\n{PATTERNS}\n\n---\nMatch existing code style. Test your changes.\n";
/**
 * Sonnet research template
 */
export declare const SONNET_RESEARCH_TEMPLATE = "## RESEARCH TASK\n\n### Query\n{QUERY}\n\n### Required Information\n{REQUIREMENTS}\n\n### Sources to Search\n{SOURCES}\n\n### Output Format\n```\n## Query: [restated query]\n\n## Findings\n### [Source 1]\n[Key information]\n**Reference**: [URL/file path]\n\n### [Source 2]\n[Key information]\n**Reference**: [URL/file path]\n\n## Summary\n[Synthesized answer]\n\n## Recommendations\n[Actionable next steps]\n```\n\n---\nCite sources. Provide actionable information.\n";
/**
 * Sonnet frontend template
 */
export declare const SONNET_FRONTEND_TEMPLATE = "## FRONTEND TASK\n\n### Change Required\n{TASK}\n\n### Visual Expectations\n{VISUAL_REQUIREMENTS}\n\n### Technical Constraints\n- Framework: {FRAMEWORK}\n- Styling: {STYLING_APPROACH}\n- Components: {COMPONENT_PATTERNS}\n\n### Existing Patterns\n{PATTERNS}\n\n### Files to Modify\n{FILES}\n\n---\nMatch the existing aesthetic. Test in browser if applicable.\n";
//# sourceMappingURL=sonnet.d.ts.map