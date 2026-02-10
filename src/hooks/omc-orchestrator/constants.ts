/**
 * OMC Orchestrator Constants
 *
 * Message templates and configuration for orchestrator behavior enforcement.
 *
 * Adapted from oh-my-opencode's omc-orchestrator hook.
 */

export const HOOK_NAME = 'omc-orchestrator';

/** @deprecated Use ALLOWED_PATH_PATTERNS instead. Legacy single prefix. */
export const ALLOWED_PATH_PREFIX = '.omc/';

/** Path patterns that orchestrator IS allowed to modify directly.
 *  Paths are normalized to forward slashes before matching (via toForwardSlash). */
export const ALLOWED_PATH_PATTERNS = [
  /^\.omc\//,                    // .omc/**
  /^\.claude\//,                 // .claude/** (local)
  /^~?\/\.claude\//,             // ~/.claude/** (global)
  /\/\.claude\//,                // any /.claude/ path
  /CLAUDE\.md$/,                 // **/CLAUDE.md
  /AGENTS\.md$/,                 // **/AGENTS.md
];

/** Source file extensions that should trigger delegation warnings */
export const WARNED_EXTENSIONS = [
  // JavaScript/TypeScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py', '.pyw',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/JVM
  '.java', '.kt', '.scala',
  // C/C++
  '.c', '.cpp', '.cc', '.h', '.hpp',
  // Ruby
  '.rb',
  // PHP
  '.php',
  // Frontend frameworks
  '.svelte', '.vue',
  // GraphQL
  '.graphql', '.gql',
  // Shell
  '.sh', '.bash', '.zsh',
];

/** Tools that perform file modifications */
export const WRITE_EDIT_TOOLS = ['Write', 'Edit', 'write', 'edit'];

/** Reminder when orchestrator performs direct file work */
export const DIRECT_WORK_REMINDER = `

---

[SYSTEM REMINDER - DELEGATION REQUIRED]

You just performed direct file modifications outside \`.omc/\`.

**You are an ORCHESTRATOR, not an IMPLEMENTER.**

As an orchestrator, you should:
- **DELEGATE** implementation work to subagents via the Task tool
- **VERIFY** the work done by subagents
- **COORDINATE** multiple tasks and ensure completion

You should NOT:
- Write code directly (except for \`.omc/\` files like plans and notepads)
- Make direct file edits outside \`.omc/\`
- Implement features yourself

**If you need to make changes:**
1. Use the Task tool to delegate to an appropriate subagent
2. Provide clear instructions in the prompt
3. Verify the subagent's work after completion

---
`;

/** Strong warning when orchestrator tries to modify source files */
export const ORCHESTRATOR_DELEGATION_REQUIRED = `

---

[CRITICAL SYSTEM DIRECTIVE - DELEGATION REQUIRED]

**STOP. YOU ARE VIOLATING ORCHESTRATOR PROTOCOL.**

You (coordinator) are attempting to directly modify a file outside \`.omc/\`.

**Path attempted:** $FILE_PATH

---

**THIS IS FORBIDDEN** (except for VERIFICATION purposes)

As an ORCHESTRATOR, you MUST:
1. **DELEGATE** all implementation work via the Task tool
2. **VERIFY** the work done by subagents (reading files is OK)
3. **COORDINATE** - you orchestrate, you don't implement

**ALLOWED direct file operations:**
- Files inside \`.omc/\` (plans, notepads, drafts)
- Files inside \`~/.claude/\` (global config)
- \`CLAUDE.md\` and \`AGENTS.md\` files
- Reading files for verification
- Running diagnostics/tests

**FORBIDDEN direct file operations:**
- Writing/editing source code
- Creating new files outside \`.omc/\`
- Any implementation work

---

**IF THIS IS FOR VERIFICATION:**
Proceed if you are verifying subagent work by making a small fix.
But for any substantial changes, USE the Task tool.

**CORRECT APPROACH:**
\`\`\`
Task tool with subagent_type="executor"
prompt="[specific single task with clear acceptance criteria]"
\`\`\`

DELEGATE. DON'T IMPLEMENT.

---
`;

/** Continuation prompt for boulder state */
export const BOULDER_CONTINUATION_PROMPT = `[SYSTEM REMINDER - BOULDER CONTINUATION]

You have an active work plan with incomplete tasks. Continue working.

RULES:
- Proceed without asking for permission
- Mark each checkbox [x] in the plan file when done
- Use the notepad at .omc/notepads/{PLAN_NAME}/ to record learnings
- Do not stop until all tasks are complete
- If blocked, document the blocker and move to the next task`;

/** Verification reminder for subagent work */
export const VERIFICATION_REMINDER = `**MANDATORY VERIFICATION - SUBAGENTS LIE**

Subagents FREQUENTLY claim completion when:
- Tests are actually FAILING
- Code has type/lint ERRORS
- Implementation is INCOMPLETE
- Patterns were NOT followed

**YOU MUST VERIFY EVERYTHING YOURSELF:**

1. Run tests yourself - Must PASS (not "agent said it passed")
2. Read the actual code - Must match requirements
3. Check build/typecheck - Must succeed

DO NOT TRUST THE AGENT'S SELF-REPORT.
VERIFY EACH CLAIM WITH YOUR OWN TOOL CALLS.`;

/** Directive for subagents to refuse multi-task requests */
export const SINGLE_TASK_DIRECTIVE = `

[SYSTEM DIRECTIVE - SINGLE TASK ONLY]

**STOP. READ THIS BEFORE PROCEEDING.**

If you were NOT given **exactly ONE atomic task**, you MUST:
1. **IMMEDIATELY REFUSE** this request
2. **DEMAND** the orchestrator provide a single, specific task

**Your response if multiple tasks detected:**
> "I refuse to proceed. You provided multiple tasks. An orchestrator's impatience destroys work quality.
>
> PROVIDE EXACTLY ONE TASK. One file. One change. One verification.
>
> Your rushing will cause: incomplete work, missed edge cases, broken tests, wasted context."

**WARNING TO ORCHESTRATOR:**
- Your hasty batching RUINS deliverables
- Each task needs FULL attention and PROPER verification
- Batch delegation = sloppy work = rework = wasted tokens

**REFUSE multi-task requests. DEMAND single-task clarity.**
`;
