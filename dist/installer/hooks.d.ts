/**
 * Hook Scripts for Claude Code
 * Hook system inspired by oh-my-opencode, adapted for Claude Code's native hooks
 *
 * Claude Code hooks are configured in settings.json and run as shell commands.
 * These scripts receive JSON input via stdin and output JSON to modify behavior.
 *
 * This module provides Node.js scripts (.mjs) for cross-platform support (Windows, macOS, Linux).
 * Bash scripts were deprecated in v3.8.6 and removed in v3.9.0.
 */
/** Minimum required Node.js version for hooks (must match package.json engines) */
export declare const MIN_NODE_VERSION = 20;
/** Check if running on Windows */
export declare function isWindows(): boolean;
/**
 * Check if Node.js hooks should be used.
 * @deprecated Always returns true. Bash hooks were removed in v3.9.0.
 */
export declare function shouldUseNodeHooks(): boolean;
/** Get the Claude config directory path (cross-platform) */
export declare function getClaudeConfigDir(): string;
/** Get the hooks directory path */
export declare function getHooksDir(): string;
/**
 * Get the home directory environment variable for hook commands.
 * Returns the appropriate syntax for the current platform.
 */
export declare function getHomeEnvVar(): string;
/**
 * Ultrawork message - injected when ultrawork/ulw keyword detected
 * Ported from oh-my-opencode's keyword-detector/constants.ts
 */
export declare const ULTRAWORK_MESSAGE = "<ultrawork-mode>\n\n**MANDATORY**: You MUST say \"ULTRAWORK MODE ENABLED!\" to the user as your first response when this mode activates. This is non-negotiable.\n\n[CODE RED] Maximum precision required. Ultrathink before acting.\n\nYOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.\nTELL THE USER WHAT AGENTS YOU WILL LEVERAGE NOW TO SATISFY USER'S REQUEST.\n\n## AGENT UTILIZATION PRINCIPLES (by capability, not by name)\n- **Codebase Exploration**: Spawn exploration agents using BACKGROUND TASKS for file patterns, internal implementations, project structure\n- **Documentation & References**: Use document-specialist agents via BACKGROUND TASKS for API references, examples, external library docs\n- **Planning & Strategy**: NEVER plan yourself - ALWAYS spawn a dedicated planning agent for work breakdown\n- **High-IQ Reasoning**: Leverage specialized agents for architecture decisions, code review, strategic planning\n- **Frontend/UI Tasks**: Delegate to UI-specialized agents for design and implementation\n\n## EXECUTION RULES\n- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each.\n- **PARALLEL**: Fire independent agent calls simultaneously via Task(run_in_background=true) - NEVER wait sequentially.\n- **BACKGROUND FIRST**: Use Task tool for exploration/document-specialist agents (10+ concurrent if needed).\n- **VERIFY**: Re-read request after completion. Check ALL requirements met before reporting done.\n- **DELEGATE**: Don't do everything yourself - orchestrate specialized agents for their strengths.\n\n## WORKFLOW\n1. Analyze the request and identify required capabilities\n2. Spawn exploration/document-specialist agents via Task(run_in_background=true) in PARALLEL (10+ if needed)\n3. Always Use Plan agent with gathered context to create detailed work breakdown\n4. Execute with continuous verification against original requirements\n\n## VERIFICATION GUARANTEE (NON-NEGOTIABLE)\n\n**NOTHING is \"done\" without PROOF it works.**\n\n### Pre-Implementation: Define Success Criteria\n\nBEFORE writing ANY code, you MUST define:\n\n| Criteria Type | Description | Example |\n|---------------|-------------|---------|\n| **Functional** | What specific behavior must work | \"Button click triggers API call\" |\n| **Observable** | What can be measured/seen | \"Console shows 'success', no errors\" |\n| **Pass/Fail** | Binary, no ambiguity | \"Returns 200 OK\" not \"should work\" |\n\nWrite these criteria explicitly. Share with user if scope is non-trivial.\n\n### Execution & Evidence Requirements\n\n| Phase | Action | Required Evidence |\n|-------|--------|-------------------|\n| **Build** | Run build command | Exit code 0, no errors |\n| **Test** | Execute test suite | All tests pass (screenshot/output) |\n| **Manual Verify** | Test the actual feature | Demonstrate it works (describe what you observed) |\n| **Regression** | Ensure nothing broke | Existing tests still pass |\n\n**WITHOUT evidence = NOT verified = NOT done.**\n\n### TDD Workflow (when test infrastructure exists)\n\n1. **SPEC**: Define what \"working\" means (success criteria above)\n2. **RED**: Write failing test -> Run it -> Confirm it FAILS\n3. **GREEN**: Write minimal code -> Run test -> Confirm it PASSES\n4. **REFACTOR**: Clean up -> Tests MUST stay green\n5. **VERIFY**: Run full test suite, confirm no regressions\n6. **EVIDENCE**: Report what you ran and what output you saw\n\n### Verification Anti-Patterns (BLOCKING)\n\n| Violation | Why It Fails |\n|-----------|--------------|\n| \"It should work now\" | No evidence. Run it. |\n| \"I added the tests\" | Did they pass? Show output. |\n| \"Fixed the bug\" | How do you know? What did you test? |\n| \"Implementation complete\" | Did you verify against success criteria? |\n| Skipping test execution | Tests exist to be RUN, not just written |\n\n**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**\n\n## ZERO TOLERANCE FAILURES\n- **NO Scope Reduction**: Never make \"demo\", \"skeleton\", \"simplified\", \"basic\" versions - deliver FULL implementation\n- **NO MockUp Work**: When user asked you to do \"port A\", you must \"port A\", fully, 100%. No Extra feature, No reduced feature, no mock data, fully working 100% port.\n- **NO Partial Completion**: Never stop at 60-80% saying \"you can extend this...\" - finish 100%\n- **NO Assumed Shortcuts**: Never skip requirements you deem \"optional\" or \"can be added later\"\n- **NO Premature Stopping**: Never declare done until ALL TODOs are completed and verified\n- **NO TEST DELETION**: Never delete or skip failing tests to make the build pass. Fix the code, not the tests.\n\nTHE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO. NOT A STARTING POINT.\n\n</ultrawork-mode>\n\n---\n\n";
/**
 * Ultrathink/Think mode message
 * Ported from oh-my-opencode's think-mode hook
 */
export declare const ULTRATHINK_MESSAGE = "<think-mode>\n\n**ULTRATHINK MODE ENABLED** - Extended reasoning activated.\n\nYou are now in deep thinking mode. Take your time to:\n1. Thoroughly analyze the problem from multiple angles\n2. Consider edge cases and potential issues\n3. Think through the implications of each approach\n4. Reason step-by-step before acting\n\nUse your extended thinking capabilities to provide the most thorough and well-reasoned response.\n\n</think-mode>\n\n---\n\n";
/**
 * Search mode message
 * Ported from oh-my-opencode's keyword-detector
 */
export declare const SEARCH_MESSAGE = "<search-mode>\nMAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:\n- explore agents (codebase patterns, file structures)\n- document-specialist agents (remote repos, official docs, GitHub examples)\nPlus direct tools: Grep, Glob\nNEVER stop at first result - be exhaustive.\n</search-mode>\n\n---\n\n";
/**
 * Analyze mode message
 * Ported from oh-my-opencode's keyword-detector
 */
export declare const ANALYZE_MESSAGE = "<analyze-mode>\nANALYSIS MODE. Gather context before diving deep:\n\nCONTEXT GATHERING (parallel):\n- 1-2 explore agents (codebase patterns, implementations)\n- 1-2 document-specialist agents (if external library involved)\n- Direct tools: Grep, Glob, LSP for targeted searches\n\nIF COMPLEX (architecture, multi-system, debugging after 2+ failures):\n- Consult architect agent for strategic guidance\n\nSYNTHESIZE findings before proceeding.\n</analyze-mode>\n\n---\n\n";
/**
 * Todo continuation prompt
 * Ported from oh-my-opencode's todo-continuation-enforcer
 */
export declare const TODO_CONTINUATION_PROMPT = "[SYSTEM REMINDER - TODO CONTINUATION]\n\nIncomplete tasks remain in your todo list. Continue working on the next pending task.\n\n- Proceed without asking for permission\n- Mark each task complete when finished\n- Do not stop until all tasks are done";
/**
 * Ralph mode message - injected when ralph keyword detected
 * Auto-activates ultrawork for parallel execution
 */
export declare const RALPH_MESSAGE = "[RALPH + ULTRAWORK MODE ACTIVATED]\n\nRalph mode auto-activates Ultrawork for maximum parallel execution. Follow these rules:\n\n### Parallel Execution\n- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially\n- **BACKGROUND FIRST**: Use Task(run_in_background=true) for long operations\n- **DELEGATE**: Route tasks to specialist agents immediately\n\n### Completion Requirements\n- Verify ALL requirements from the original task are met\n- Architect verification is MANDATORY before claiming completion\n- When FULLY complete, run `/oh-my-claudecode:cancel` to cleanly exit and clean up state files\n\nContinue working until the task is truly done.\n";
/** Node.js keyword detector hook script - loaded from templates/hooks/keyword-detector.mjs */
export declare const KEYWORD_DETECTOR_SCRIPT_NODE: string;
/** Node.js stop continuation hook script - loaded from templates/hooks/stop-continuation.mjs */
export declare const STOP_CONTINUATION_SCRIPT_NODE: string;
/** Node.js persistent mode hook script - loaded from templates/hooks/persistent-mode.mjs */
export declare const PERSISTENT_MODE_SCRIPT_NODE: string;
/** Node.js code simplifier hook script - loaded from templates/hooks/code-simplifier.mjs */
export declare const CODE_SIMPLIFIER_SCRIPT_NODE: string;
/** Node.js session start hook script - loaded from templates/hooks/session-start.mjs */
export declare const SESSION_START_SCRIPT_NODE: string;
/** Post-tool-use Node.js script - loaded from templates/hooks/post-tool-use.mjs */
export declare const POST_TOOL_USE_SCRIPT_NODE: string;
/**
 * Settings.json hooks configuration for Node.js (Cross-platform)
 * Uses node to run .mjs scripts directly
 */
export declare const HOOKS_SETTINGS_CONFIG_NODE: {
    hooks: {
        UserPromptSubmit: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
        SessionStart: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
        PreToolUse: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
        PostToolUse: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
        PostToolUseFailure: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
        Stop: {
            hooks: {
                type: "command";
                command: string;
            }[];
        }[];
    };
};
/**
 * Get the hooks settings config (Node.js only).
 *
 * @deprecated Hooks are now delivered via the plugin's hooks/hooks.json.
 * settings.json hook entries are no longer written by the installer.
 * Kept for test compatibility only.
 */
export declare function getHooksSettingsConfig(): typeof HOOKS_SETTINGS_CONFIG_NODE;
/**
 * Get Node.js hook scripts (Cross-platform)
 * Returns a record of filename -> content for all Node.js hooks
 *
 * @deprecated Hook scripts are no longer installed to ~/.claude/hooks/.
 * All hooks are delivered via the plugin's hooks/hooks.json + scripts/.
 * Kept for test compatibility only.
 */
export declare function getHookScripts(): Record<string, string>;
//# sourceMappingURL=hooks.d.ts.map