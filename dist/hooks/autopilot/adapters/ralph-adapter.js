/**
 * RALPH Stage Adapter
 *
 * Wraps the existing ralph verification module into the pipeline stage adapter interface.
 *
 * The ralph stage performs iterative verification of the implementation:
 * - Functional completeness review
 * - Security review
 * - Code quality review
 * - Fixes issues found and re-verifies
 */
export const RALPH_COMPLETION_SIGNAL = 'PIPELINE_RALPH_COMPLETE';
export const ralphAdapter = {
    id: 'ralph',
    name: 'Verification (RALPH)',
    completionSignal: RALPH_COMPLETION_SIGNAL,
    shouldSkip(config) {
        return config.verification === false;
    },
    getPrompt(context) {
        const specPath = context.specPath || '.omc/autopilot/spec.md';
        const maxIterations = context.config.verification !== false
            ? context.config.verification.maxIterations
            : 100;
        return `## PIPELINE STAGE: RALPH (Verification)

Verify the implementation against the specification using the Ralph verification loop.

**Max Iterations:** ${maxIterations}

### Verification Process

Spawn parallel verification reviewers:

\`\`\`
// Functional Completeness Review
Task(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  prompt="FUNCTIONAL COMPLETENESS REVIEW

Read the original spec at: ${specPath}

Verify:
1. All functional requirements are implemented
2. All non-functional requirements are addressed
3. All acceptance criteria from the plan are met
4. No missing features or incomplete implementations

Verdict: APPROVED (all requirements met) or REJECTED (with specific gaps)"
)

// Security Review
Task(
  subagent_type="oh-my-claudecode:security-reviewer",
  model="opus",
  prompt="SECURITY REVIEW

Check the implementation for:
1. OWASP Top 10 vulnerabilities
2. Input validation and sanitization
3. Authentication/authorization issues
4. Sensitive data exposure
5. Injection vulnerabilities (SQL, command, XSS)
6. Hardcoded secrets or credentials

Verdict: APPROVED (no vulnerabilities) or REJECTED (with specific issues)"
)

// Code Quality Review
Task(
  subagent_type="oh-my-claudecode:code-reviewer",
  model="opus",
  prompt="CODE QUALITY REVIEW

Review the implementation for:
1. Code organization and structure
2. Design patterns and best practices
3. Error handling completeness
4. Test coverage adequacy
5. Maintainability and readability

Verdict: APPROVED (high quality) or REJECTED (with specific issues)"
)
\`\`\`

### Fix and Re-verify Loop

If any reviewer rejects:
1. Collect all rejection reasons
2. Fix each issue identified
3. Re-run verification (up to ${maxIterations} iterations)

### Completion

When all reviewers approve:

Signal: ${RALPH_COMPLETION_SIGNAL}
`;
    },
};
//# sourceMappingURL=ralph-adapter.js.map