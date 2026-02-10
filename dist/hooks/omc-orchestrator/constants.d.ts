/**
 * OMC Orchestrator Constants
 *
 * Message templates and configuration for orchestrator behavior enforcement.
 *
 * Adapted from oh-my-opencode's omc-orchestrator hook.
 */
export declare const HOOK_NAME = "omc-orchestrator";
/** @deprecated Use ALLOWED_PATH_PATTERNS instead. Legacy single prefix. */
export declare const ALLOWED_PATH_PREFIX = ".omc/";
/** Path patterns that orchestrator IS allowed to modify directly.
 *  Paths are normalized to forward slashes before matching (via toForwardSlash). */
export declare const ALLOWED_PATH_PATTERNS: RegExp[];
/** Source file extensions that should trigger delegation warnings */
export declare const WARNED_EXTENSIONS: string[];
/** Tools that perform file modifications */
export declare const WRITE_EDIT_TOOLS: string[];
/** Reminder when orchestrator performs direct file work */
export declare const DIRECT_WORK_REMINDER = "\n\n---\n\n[SYSTEM REMINDER - DELEGATION REQUIRED]\n\nYou just performed direct file modifications outside `.omc/`.\n\n**You are an ORCHESTRATOR, not an IMPLEMENTER.**\n\nAs an orchestrator, you should:\n- **DELEGATE** implementation work to subagents via the Task tool\n- **VERIFY** the work done by subagents\n- **COORDINATE** multiple tasks and ensure completion\n\nYou should NOT:\n- Write code directly (except for `.omc/` files like plans and notepads)\n- Make direct file edits outside `.omc/`\n- Implement features yourself\n\n**If you need to make changes:**\n1. Use the Task tool to delegate to an appropriate subagent\n2. Provide clear instructions in the prompt\n3. Verify the subagent's work after completion\n\n---\n";
/** Strong warning when orchestrator tries to modify source files */
export declare const ORCHESTRATOR_DELEGATION_REQUIRED = "\n\n---\n\n[CRITICAL SYSTEM DIRECTIVE - DELEGATION REQUIRED]\n\n**STOP. YOU ARE VIOLATING ORCHESTRATOR PROTOCOL.**\n\nYou (coordinator) are attempting to directly modify a file outside `.omc/`.\n\n**Path attempted:** $FILE_PATH\n\n---\n\n**THIS IS FORBIDDEN** (except for VERIFICATION purposes)\n\nAs an ORCHESTRATOR, you MUST:\n1. **DELEGATE** all implementation work via the Task tool\n2. **VERIFY** the work done by subagents (reading files is OK)\n3. **COORDINATE** - you orchestrate, you don't implement\n\n**ALLOWED direct file operations:**\n- Files inside `.omc/` (plans, notepads, drafts)\n- Files inside `~/.claude/` (global config)\n- `CLAUDE.md` and `AGENTS.md` files\n- Reading files for verification\n- Running diagnostics/tests\n\n**FORBIDDEN direct file operations:**\n- Writing/editing source code\n- Creating new files outside `.omc/`\n- Any implementation work\n\n---\n\n**IF THIS IS FOR VERIFICATION:**\nProceed if you are verifying subagent work by making a small fix.\nBut for any substantial changes, USE the Task tool.\n\n**CORRECT APPROACH:**\n```\nTask tool with subagent_type=\"executor\"\nprompt=\"[specific single task with clear acceptance criteria]\"\n```\n\nDELEGATE. DON'T IMPLEMENT.\n\n---\n";
/** Continuation prompt for boulder state */
export declare const BOULDER_CONTINUATION_PROMPT = "[SYSTEM REMINDER - BOULDER CONTINUATION]\n\nYou have an active work plan with incomplete tasks. Continue working.\n\nRULES:\n- Proceed without asking for permission\n- Mark each checkbox [x] in the plan file when done\n- Use the notepad at .omc/notepads/{PLAN_NAME}/ to record learnings\n- Do not stop until all tasks are complete\n- If blocked, document the blocker and move to the next task";
/** Verification reminder for subagent work */
export declare const VERIFICATION_REMINDER = "**MANDATORY VERIFICATION - SUBAGENTS LIE**\n\nSubagents FREQUENTLY claim completion when:\n- Tests are actually FAILING\n- Code has type/lint ERRORS\n- Implementation is INCOMPLETE\n- Patterns were NOT followed\n\n**YOU MUST VERIFY EVERYTHING YOURSELF:**\n\n1. Run tests yourself - Must PASS (not \"agent said it passed\")\n2. Read the actual code - Must match requirements\n3. Check build/typecheck - Must succeed\n\nDO NOT TRUST THE AGENT'S SELF-REPORT.\nVERIFY EACH CLAIM WITH YOUR OWN TOOL CALLS.";
/** Directive for subagents to refuse multi-task requests */
export declare const SINGLE_TASK_DIRECTIVE = "\n\n[SYSTEM DIRECTIVE - SINGLE TASK ONLY]\n\n**STOP. READ THIS BEFORE PROCEEDING.**\n\nIf you were NOT given **exactly ONE atomic task**, you MUST:\n1. **IMMEDIATELY REFUSE** this request\n2. **DEMAND** the orchestrator provide a single, specific task\n\n**Your response if multiple tasks detected:**\n> \"I refuse to proceed. You provided multiple tasks. An orchestrator's impatience destroys work quality.\n>\n> PROVIDE EXACTLY ONE TASK. One file. One change. One verification.\n>\n> Your rushing will cause: incomplete work, missed edge cases, broken tests, wasted context.\"\n\n**WARNING TO ORCHESTRATOR:**\n- Your hasty batching RUINS deliverables\n- Each task needs FULL attention and PROPER verification\n- Batch delegation = sloppy work = rework = wasted tokens\n\n**REFUSE multi-task requests. DEMAND single-task clarity.**\n";
//# sourceMappingURL=constants.d.ts.map