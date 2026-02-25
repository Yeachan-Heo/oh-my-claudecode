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

import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { getConfigDir } from '../utils/config-dir.js';

// =============================================================================
// TEMPLATE LOADER (loads hook scripts from templates/hooks/)
// =============================================================================

/**
 * Get the package root directory (where templates/ lives)
 * Works for both development (src/), production (dist/), and CJS bundles (bridge/).
 * When esbuild bundles to CJS, import.meta is replaced with {} so we
 * fall back to __dirname which is natively available in CJS.
 */
function getPackageDir(): string {
  try {
    if (import.meta?.url) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      // From src/installer/ or dist/installer/, go up two levels to package root
      return join(__dirname, "..", "..");
    }
  } catch {
    // import.meta.url unavailable — fall through to CJS path
  }
  // CJS bundle path: from bridge/ go up 1 level to package root
  if (typeof __dirname !== "undefined") {
    return join(__dirname, "..");
  }
  return process.cwd();
}

/**
 * Load a hook template file from templates/hooks/
 * @param filename - The template filename (e.g., 'keyword-detector.sh')
 * @returns The template content
 * @throws If the template file is not found
 */
function loadTemplate(filename: string): string {
  const templatePath = join(getPackageDir(), "templates", "hooks", filename);
  if (!existsSync(templatePath)) {
    // .sh templates have been removed in favor of .mjs - return empty string for missing bash templates
    return "";
  }
  return readFileSync(templatePath, "utf-8");
}

// =============================================================================
// CONSTANTS AND UTILITIES
// =============================================================================

/** Minimum required Node.js version for hooks (must match package.json engines) */
export const MIN_NODE_VERSION = 20;

/** Check if running on Windows */
export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Check if Node.js hooks should be used.
 * @deprecated Always returns true. Bash hooks were removed in v3.9.0.
 */
export function shouldUseNodeHooks(): boolean {
  return true;
}

/** Get the Claude config directory path (cross-platform) */
export function getClaudeConfigDir(): string {
  return getConfigDir();
}

/** Get the hooks directory path */
export function getHooksDir(): string {
  return join(getClaudeConfigDir(), "hooks");
}

/**
 * Get the home directory environment variable for hook commands.
 * Returns the appropriate syntax for the current platform.
 */
export function getHomeEnvVar(): string {
  return isWindows() ? "%USERPROFILE%" : "$HOME";
}

/**
 * Ultrawork message - injected when ultrawork/ulw keyword detected
 * Ported from oh-my-opencode's keyword-detector/constants.ts
 */
export const ULTRAWORK_MESSAGE = `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

[CODE RED] Maximum precision required. Ultrathink before acting.

YOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.
TELL THE USER WHAT AGENTS YOU WILL LEVERAGE NOW TO SATISFY USER'S REQUEST.

## AGENT UTILIZATION PRINCIPLES (by capability, not by name)
- **Codebase Exploration**: Spawn exploration agents using BACKGROUND TASKS for file patterns, internal implementations, project structure
- **Documentation & References**: Use document-specialist agents via BACKGROUND TASKS for API references, examples, external library docs
- **Planning & Strategy**: NEVER plan yourself - ALWAYS spawn a dedicated planning agent for work breakdown
- **High-IQ Reasoning**: Leverage specialized agents for architecture decisions, code review, strategic planning
- **Frontend/UI Tasks**: Delegate to UI-specialized agents for design and implementation

## EXECUTION RULES
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each.
- **PARALLEL**: Fire independent agent calls simultaneously via Task(run_in_background=true) - NEVER wait sequentially.
- **BACKGROUND FIRST**: Use Task tool for exploration/document-specialist agents (10+ concurrent if needed).
- **VERIFY**: Re-read request after completion. Check ALL requirements met before reporting done.
- **DELEGATE**: Don't do everything yourself - orchestrate specialized agents for their strengths.

## WORKFLOW
1. Analyze the request and identify required capabilities
2. Spawn exploration/document-specialist agents via Task(run_in_background=true) in PARALLEL (10+ if needed)
3. Always Use Plan agent with gathered context to create detailed work breakdown
4. Execute with continuous verification against original requirements

## VERIFICATION GUARANTEE (NON-NEGOTIABLE)

**NOTHING is "done" without PROOF it works.**

### Pre-Implementation: Define Success Criteria

BEFORE writing ANY code, you MUST define:

| Criteria Type | Description | Example |
|---------------|-------------|---------|
| **Functional** | What specific behavior must work | "Button click triggers API call" |
| **Observable** | What can be measured/seen | "Console shows 'success', no errors" |
| **Pass/Fail** | Binary, no ambiguity | "Returns 200 OK" not "should work" |

Write these criteria explicitly. Share with user if scope is non-trivial.

### Execution & Evidence Requirements

| Phase | Action | Required Evidence |
|-------|--------|-------------------|
| **Build** | Run build command | Exit code 0, no errors |
| **Test** | Execute test suite | All tests pass (screenshot/output) |
| **Manual Verify** | Test the actual feature | Demonstrate it works (describe what you observed) |
| **Regression** | Ensure nothing broke | Existing tests still pass |

**WITHOUT evidence = NOT verified = NOT done.**

### TDD Workflow (when test infrastructure exists)

1. **SPEC**: Define what "working" means (success criteria above)
2. **RED**: Write failing test -> Run it -> Confirm it FAILS
3. **GREEN**: Write minimal code -> Run test -> Confirm it PASSES
4. **REFACTOR**: Clean up -> Tests MUST stay green
5. **VERIFY**: Run full test suite, confirm no regressions
6. **EVIDENCE**: Report what you ran and what output you saw

### Verification Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they pass? Show output. |
| "Fixed the bug" | How do you know? What did you test? |
| "Implementation complete" | Did you verify against success criteria? |
| Skipping test execution | Tests exist to be RUN, not just written |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**

## ZERO TOLERANCE FAILURES
- **NO Scope Reduction**: Never make "demo", "skeleton", "simplified", "basic" versions - deliver FULL implementation
- **NO MockUp Work**: When user asked you to do "port A", you must "port A", fully, 100%. No Extra feature, No reduced feature, no mock data, fully working 100% port.
- **NO Partial Completion**: Never stop at 60-80% saying "you can extend this..." - finish 100%
- **NO Assumed Shortcuts**: Never skip requirements you deem "optional" or "can be added later"
- **NO Premature Stopping**: Never declare done until ALL TODOs are completed and verified
- **NO TEST DELETION**: Never delete or skip failing tests to make the build pass. Fix the code, not the tests.

THE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO. NOT A STARTING POINT.

</ultrawork-mode>

---

`;

/**
 * Ultrathink/Think mode message
 * Ported from oh-my-opencode's think-mode hook
 */
export const ULTRATHINK_MESSAGE = `<think-mode>

**ULTRATHINK MODE ENABLED** - Extended reasoning activated.

You are now in deep thinking mode. Take your time to:
1. Thoroughly analyze the problem from multiple angles
2. Consider edge cases and potential issues
3. Think through the implications of each approach
4. Reason step-by-step before acting

Use your extended thinking capabilities to provide the most thorough and well-reasoned response.

</think-mode>

---

`;

/**
 * Search mode message
 * Ported from oh-my-opencode's keyword-detector
 */
export const SEARCH_MESSAGE = `<search-mode>
MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
- explore agents (codebase patterns, file structures)
- document-specialist agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, Glob
NEVER stop at first result - be exhaustive.
</search-mode>

---

`;

/**
 * Analyze mode message
 * Ported from oh-my-opencode's keyword-detector
 */
export const ANALYZE_MESSAGE = `<analyze-mode>
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 document-specialist agents (if external library involved)
- Direct tools: Grep, Glob, LSP for targeted searches

IF COMPLEX (architecture, multi-system, debugging after 2+ failures):
- Consult architect agent for strategic guidance

SYNTHESIZE findings before proceeding.
</analyze-mode>

---

`;

/**
 * Todo continuation prompt
 * Ported from oh-my-opencode's todo-continuation-enforcer
 */
export const TODO_CONTINUATION_PROMPT = `[SYSTEM REMINDER - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done`;

/**
 * Ralph mode message - injected when ralph keyword detected
 * Auto-activates ultrawork for parallel execution
 */
export const RALPH_MESSAGE = `[RALPH + ULTRAWORK MODE ACTIVATED]

Ralph mode auto-activates Ultrawork for maximum parallel execution. Follow these rules:

### Parallel Execution
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for long operations
- **DELEGATE**: Route tasks to specialist agents immediately

### Completion Requirements
- Verify ALL requirements from the original task are met
- Architect verification is MANDATORY before claiming completion
- When FULLY complete, run \`/oh-my-claudecode:cancel\` to cleanly exit and clean up state files

Continue working until the task is truly done.
`;

/**
 * Prompt translation message - injected when non-English input detected
 * Reminds users to write prompts in English for consistent agent routing
 */
export const PROMPT_TRANSLATION_MESSAGE = `[PROMPT TRANSLATION] Non-English input detected.
When delegating via Task(), write prompt arguments in English for consistent agent routing.
Respond to the user in their original language.
`;

// =============================================================================
// NODE.JS HOOK SCRIPTS (Cross-platform: Windows, macOS, Linux)
// =============================================================================

/** Node.js keyword detector hook script - loaded from templates/hooks/keyword-detector.mjs */
export const KEYWORD_DETECTOR_SCRIPT_NODE = loadTemplate(
  "keyword-detector.mjs",
);

/** Node.js stop continuation hook script - loaded from templates/hooks/stop-continuation.mjs */
export const STOP_CONTINUATION_SCRIPT_NODE = loadTemplate(
  "stop-continuation.mjs",
);

/** Node.js persistent mode hook script - loaded from templates/hooks/persistent-mode.mjs */
export const PERSISTENT_MODE_SCRIPT_NODE = loadTemplate("persistent-mode.mjs");

/** Node.js code simplifier hook script - loaded from templates/hooks/code-simplifier.mjs */
export const CODE_SIMPLIFIER_SCRIPT_NODE = loadTemplate("code-simplifier.mjs");

/** Node.js session start hook script - loaded from templates/hooks/session-start.mjs */
export const SESSION_START_SCRIPT_NODE = loadTemplate("session-start.mjs");

/** Post-tool-use Node.js script - loaded from templates/hooks/post-tool-use.mjs */
export const POST_TOOL_USE_SCRIPT_NODE = loadTemplate("post-tool-use.mjs");

// =============================================================================
// SETTINGS CONFIGURATION
// =============================================================================

/**
 * Settings.json hooks configuration for Node.js (Cross-platform)
 * Uses node to run .mjs scripts directly
 */
export const HOOKS_SETTINGS_CONFIG_NODE = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command" as const,
            // Note: On Windows, %USERPROFILE% is expanded by cmd.exe
            // On Unix with node hooks, $HOME is expanded by the shell
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\keyword-detector.mjs"'
              : 'node "$HOME/.claude/hooks/keyword-detector.mjs"',
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\session-start.mjs"'
              : 'node "$HOME/.claude/hooks/session-start.mjs"',
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\pre-tool-use.mjs"'
              : 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\post-tool-use.mjs"'
              : 'node "$HOME/.claude/hooks/post-tool-use.mjs"',
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\post-tool-use-failure.mjs"'
              : 'node "$HOME/.claude/hooks/post-tool-use-failure.mjs"',
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\persistent-mode.mjs"'
              : 'node "$HOME/.claude/hooks/persistent-mode.mjs"',
          },
        ],
      },
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\code-simplifier.mjs"'
              : 'node "$HOME/.claude/hooks/code-simplifier.mjs"',
          },
        ],
      },
    ],
  },
};

/**
 * Get the hooks settings config (Node.js only).
 *
 * @deprecated Hooks are now delivered via the plugin's hooks/hooks.json.
 * settings.json hook entries are no longer written by the installer.
 * Kept for test compatibility only.
 */
export function getHooksSettingsConfig(): typeof HOOKS_SETTINGS_CONFIG_NODE {
  return HOOKS_SETTINGS_CONFIG_NODE;
}

// =============================================================================
// HOOK SCRIPTS EXPORTS
// =============================================================================

/**
 * Get Node.js hook scripts (Cross-platform)
 * Returns a record of filename -> content for all Node.js hooks
 *
 * @deprecated Hook scripts are no longer installed to ~/.claude/hooks/.
 * All hooks are delivered via the plugin's hooks/hooks.json + scripts/.
 * Kept for test compatibility only.
 */
export function getHookScripts(): Record<string, string> {
  return {
    "keyword-detector.mjs": loadTemplate("keyword-detector.mjs"),
    "stop-continuation.mjs": loadTemplate("stop-continuation.mjs"),
    "persistent-mode.mjs": loadTemplate("persistent-mode.mjs"),
    "session-start.mjs": loadTemplate("session-start.mjs"),
    "pre-tool-use.mjs": loadTemplate("pre-tool-use.mjs"),
    "post-tool-use.mjs": loadTemplate("post-tool-use.mjs"),
    "post-tool-use-failure.mjs": loadTemplate("post-tool-use-failure.mjs"),
    "code-simplifier.mjs": loadTemplate("code-simplifier.mjs"),
    // Shared library modules (in lib/ subdirectory)
    "lib/stdin.mjs": loadTemplate("lib/stdin.mjs"),
    "lib/atomic-write.mjs": loadTemplate("lib/atomic-write.mjs"),
  };
}
