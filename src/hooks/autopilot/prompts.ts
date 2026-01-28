/**
 * Autopilot Prompt Generation
 *
 * Generates phase-specific prompts that include Task tool invocations
 * for Claude to execute. This is the core of the agent invocation mechanism.
 */

/**
 * Generate the expansion phase prompt (Phase 0)
 * Analyst extracts requirements, Architect creates technical spec
 */
export function getExpansionPrompt(idea: string): string {
  return `## AUTOPILOT PHASE 0: IDEA EXPANSION

Your task: Expand this product idea into detailed requirements and technical spec.

**Original Idea:** "${idea}"

### Step 1: Spawn Analyst for Requirements

\`\`\`
Task(
  subagent_type="oh-my-claudecode:analyst",
  model="opus",
  prompt="REQUIREMENTS ANALYSIS for: ${escapeForPrompt(idea)}

Extract and document:
1. Functional requirements (what it must do)
2. Non-functional requirements (performance, UX, etc.)
3. Implicit requirements (things user didn't say but needs)
4. Out of scope items

Output as structured markdown with clear sections."
)
\`\`\`

WAIT for Analyst to complete before proceeding.

### Step 2: Spawn Architect for Technical Spec

After Analyst completes, spawn Architect:

\`\`\`
Task(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  prompt="TECHNICAL SPECIFICATION for: ${escapeForPrompt(idea)}

Based on the requirements analysis above, create:
1. Tech stack decisions with rationale
2. Architecture overview (patterns, layers)
3. File structure (directory tree)
4. Dependencies list (packages)
5. API/interface definitions

Output as structured markdown."
)
\`\`\`

### Step 3: Save Combined Spec

Combine Analyst requirements + Architect technical spec into a single document.
Save to: \`.omc/autopilot/spec.md\`

### Step 4: Signal Completion

When the spec is saved, signal: EXPANSION_COMPLETE
`;
}

/**
 * Generate the direct planning prompt (Phase 1)
 * Uses Architect instead of Planner to create plan directly from spec
 */
export function getDirectPlanningPrompt(specPath: string): string {
  return `## AUTOPILOT PHASE 1: DIRECT PLANNING

The spec is complete from Phase 0. Create implementation plan directly (no interview needed).

### Step 1: Read Spec

Read the specification at: ${specPath}

### Step 2: Create Plan via Architect

Spawn Architect to create the implementation plan:

\`\`\`
Task(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  prompt="CREATE IMPLEMENTATION PLAN

Read the specification at: ${specPath}

Generate a comprehensive implementation plan with:

1. **Task Breakdown**
   - Each task must be atomic (one clear deliverable)
   - Include file paths for each task
   - Estimate complexity (simple/medium/complex)

2. **Dependency Graph**
   - Which tasks depend on others
   - Optimal execution order
   - Tasks that can run in parallel

3. **Acceptance Criteria**
   - Testable criteria for each task
   - Definition of done

4. **Risk Register**
   - Identified risks
   - Mitigation strategies

Save to: .omc/plans/autopilot-impl.md

Signal completion with: PLAN_CREATED"
)
\`\`\`

### Step 3: Validate Plan via Critic

After Architect creates the plan:

\`\`\`
Task(
  subagent_type="oh-my-claudecode:critic",
  model="opus",
  prompt="REVIEW IMPLEMENTATION PLAN

Plan file: .omc/plans/autopilot-impl.md
Original spec: ${specPath}

Verify:
1. All requirements from spec have corresponding tasks
2. No ambiguous task descriptions
3. Acceptance criteria are testable
4. Dependencies are correctly identified
5. Risks are addressed

Verdict: OKAY or REJECT with specific issues"
)
\`\`\`

### Iteration Loop

If Critic rejects, feed feedback back to Architect and retry (max 5 iterations).

When Critic approves: PLANNING_COMPLETE
`;
}

/**
 * Generate the execution phase prompt (Phase 2)
 */
export function getExecutionPrompt(planPath: string): string {
  return `## AUTOPILOT PHASE 2: EXECUTION

Execute the plan at ${planPath} using Ralph+Ultrawork mode.

### Activation

Ralph and Ultrawork are now active. Execute tasks in parallel where possible.

### Execution Rules

- Read the plan from ${planPath}
- Identify independent tasks that can run in parallel
- Spawn multiple executor agents for parallel work
- Track progress in the TODO list
- Use appropriate agent tiers based on task complexity

### Agent Spawning Pattern

\`\`\`
// For simple tasks (single file, straightforward logic)
Task(subagent_type="oh-my-claudecode:executor-low", model="haiku", prompt="...")

// For standard implementation (feature, multiple methods)
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

// For complex work (architecture, debugging, refactoring)
Task(subagent_type="oh-my-claudecode:executor-high", model="opus", prompt="...")
\`\`\`

### Progress Tracking

Update TODO list as tasks complete:
- Mark task in_progress when starting
- Mark task completed when done
- Add new tasks if discovered during implementation

### Completion

When all tasks from the plan are complete: EXECUTION_COMPLETE
`;
}

/**
 * Generate the QA phase prompt (Phase 3)
 */
export function getQAPrompt(): string {
  return `## AUTOPILOT PHASE 3: QUALITY ASSURANCE

Run UltraQA cycles until build/lint/tests pass.

### QA Sequence

1. **Build**: Run the project's build command:
   - JavaScript/TypeScript: \`npm run build\` (or yarn/pnpm equivalent)
   - Python: \`python -m build\` (if applicable)
   - Go: \`go build ./...\`
   - Rust: \`cargo build\`
   - Java: \`mvn compile\` or \`gradle build\`
2. **Lint**: Run the project's linter:
   - JavaScript/TypeScript: \`npm run lint\`
   - Python: \`ruff check .\` or \`flake8\`
   - Go: \`golangci-lint run\`
   - Rust: \`cargo clippy\`
3. **Test**: Run the project's tests:
   - JavaScript/TypeScript: \`npm test\`
   - Python: \`pytest\`
   - Go: \`go test ./...\`
   - Rust: \`cargo test\`
   - Java: \`mvn test\` or \`gradle test\`

### Fix Cycle

For each failure:

1. **Diagnose** - Understand the error
\`\`\`
Task(
  subagent_type="oh-my-claudecode:architect-low",
  model="haiku",
  prompt="Diagnose this error and suggest fix: [ERROR]"
)
\`\`\`

2. **Fix** - Apply the fix
\`\`\`
Task(
  subagent_type="oh-my-claudecode:build-fixer",
  model="sonnet",
  prompt="Fix this error with minimal changes: [ERROR]"
)
\`\`\`

3. **Re-run** - Verify the fix worked
4. **Repeat** - Until pass or max cycles (5)

### Exit Conditions

- All checks pass → QA_COMPLETE
- Max cycles reached → Report failures
- Same error 3 times → Escalate to user

When all checks pass: QA_COMPLETE
`;
}

/**
 * Generate the validation phase prompt (Phase 4)
 */
export function getValidationPrompt(specPath: string): string {
  return `## AUTOPILOT PHASE 4: VALIDATION

Spawn parallel validation architects for comprehensive review.

### Parallel Validation Spawns

Spawn all three architects in parallel:

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
5. Documentation and comments
6. Maintainability and readability

Verdict: APPROVED (high quality) or REJECTED (with specific issues)"
)
\`\`\`

### Verdict Aggregation

- **All APPROVED** → AUTOPILOT_COMPLETE
- **Any REJECTED** → Fix the issues and re-validate (max 3 rounds)

### Fix and Retry

If any reviewer rejects:
1. Collect all rejection reasons
2. Fix each issue identified
3. Re-run validation

When all approve: AUTOPILOT_COMPLETE
`;
}

/**
 * Escape special characters for embedding in prompts
 */
function escapeForPrompt(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Get the prompt for the current phase
 */
export function getPhasePrompt(
  phase: string,
  context: {
    idea?: string;
    specPath?: string;
    planPath?: string;
  }
): string {
  switch (phase) {
    case 'expansion':
      return getExpansionPrompt(context.idea || '');
    case 'planning':
      return getDirectPlanningPrompt(context.specPath || '.omc/autopilot/spec.md');
    case 'execution':
      return getExecutionPrompt(context.planPath || '.omc/plans/autopilot-impl.md');
    case 'qa':
      return getQAPrompt();
    case 'validation':
      return getValidationPrompt(context.specPath || '.omc/autopilot/spec.md');
    default:
      return '';
  }
}
