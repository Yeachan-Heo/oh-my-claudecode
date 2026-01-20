/**
 * Hook Scripts for Claude Code
 * Hook system inspired by oh-my-opencode, adapted for Claude Code's native hooks
 *
 * Claude Code hooks are configured in settings.json and run as shell commands.
 * These scripts receive JSON input via stdin and output JSON to modify behavior.
 *
 * This module provides DUAL implementations:
 * - Bash scripts (.sh) for Unix-like systems (macOS, Linux)
 * - Node.js scripts (.mjs) for cross-platform support (Windows, macOS, Linux)
 *
 * The platform is detected at install time, or can be overridden with:
 *   OMC_USE_NODE_HOOKS=1  - Force Node.js hooks on any platform
 *   OMC_USE_BASH_HOOKS=1  - Force Bash hooks (Unix only)
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

// =============================================================================
// TEMPLATE LOADER (loads hook scripts from templates/hooks/)
// =============================================================================

/**
 * Get the package root directory (where templates/ lives)
 * Works for both development (src/) and production (dist/)
 */
function getPackageDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From src/installer/ or dist/installer/, go up two levels to package root
  return join(__dirname, '..', '..');
}

/**
 * Load a hook template file from templates/hooks/
 * @param filename - The template filename (e.g., 'keyword-detector.sh')
 * @returns The template content
 * @throws If the template file is not found
 */
function loadTemplate(filename: string): string {
  const templatePath = join(getPackageDir(), 'templates', 'hooks', filename);
  if (!existsSync(templatePath)) {
    console.error(`FATAL: Hook template not found: ${templatePath}`);
    process.exit(1);
  }
  return readFileSync(templatePath, 'utf-8');
}

// =============================================================================
// CONSTANTS AND UTILITIES
// =============================================================================

/** Minimum required Node.js version for hooks */
export const MIN_NODE_VERSION = 18;

/** Check if running on Windows */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Check if Node.js hooks should be used (env override or Windows) */
export function shouldUseNodeHooks(): boolean {
  // Environment variable overrides
  if (process.env.OMC_USE_NODE_HOOKS === '1') {
    return true;
  }
  if (process.env.OMC_USE_BASH_HOOKS === '1') {
    return false;
  }
  // Default: use Node.js on Windows, Bash elsewhere
  return isWindows();
}

/** Get the Claude config directory path (cross-platform) */
export function getClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

/** Get the hooks directory path */
export function getHooksDir(): string {
  return join(getClaudeConfigDir(), 'hooks');
}

/**
 * Get the home directory environment variable for hook commands.
 * Returns the appropriate syntax for the current platform.
 */
export function getHomeEnvVar(): string {
  return isWindows() ? '%USERPROFILE%' : '$HOME';
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
- **Documentation & References**: Use researcher-type agents via BACKGROUND TASKS for API references, examples, external library docs
- **Planning & Strategy**: NEVER plan yourself - ALWAYS spawn a dedicated planning agent for work breakdown
- **High-IQ Reasoning**: Leverage specialized agents for architecture decisions, code review, strategic planning
- **Frontend/UI Tasks**: Delegate to UI-specialized agents for design and implementation

## EXECUTION RULES
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each.
- **PARALLEL**: Fire independent agent calls simultaneously via Task(run_in_background=true) - NEVER wait sequentially.
- **BACKGROUND FIRST**: Use Task tool for exploration/research agents (10+ concurrent if needed).
- **VERIFY**: Re-read request after completion. Check ALL requirements met before reporting done.
- **DELEGATE**: Don't do everything yourself - orchestrate specialized agents for their strengths.

## WORKFLOW
1. Analyze the request and identify required capabilities
2. Spawn exploration/researcher agents via Task(run_in_background=true) in PARALLEL (10+ if needed)
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
- researcher agents (remote repos, official docs, GitHub examples)
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
- 1-2 researcher agents (if external library involved)
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

/** Keyword detector hook script - loaded from templates/hooks/keyword-detector.sh */
export const KEYWORD_DETECTOR_SCRIPT = loadTemplate('keyword-detector.sh');

/** Stop continuation hook script - loaded from templates/hooks/stop-continuation.sh */
export const STOP_CONTINUATION_SCRIPT = loadTemplate('stop-continuation.sh');

// =============================================================================
// NODE.JS HOOK SCRIPTS (Cross-platform: Windows, macOS, Linux)
// =============================================================================

/** Node.js keyword detector hook script - loaded from templates/hooks/keyword-detector.mjs */
export const KEYWORD_DETECTOR_SCRIPT_NODE = loadTemplate('keyword-detector.mjs');

/** Node.js stop continuation hook script - loaded from templates/hooks/stop-continuation.mjs */
export const STOP_CONTINUATION_SCRIPT_NODE = loadTemplate('stop-continuation.mjs');

// =============================================================================
// PERSISTENT MODE HOOK SCRIPTS
// =============================================================================

/** Persistent mode Bash script - loaded from templates/hooks/persistent-mode.sh */
export const PERSISTENT_MODE_SCRIPT = loadTemplate('persistent-mode.sh');

/** Session start Bash script - loaded from templates/hooks/session-start.sh */
export const SESSION_START_SCRIPT = loadTemplate('session-start.sh');

/** Node.js persistent mode hook script - loaded from templates/hooks/persistent-mode.mjs */
export const PERSISTENT_MODE_SCRIPT_NODE = loadTemplate('persistent-mode.mjs');

/** Node.js session start hook script - loaded from templates/hooks/session-start.mjs */
export const SESSION_START_SCRIPT_NODE = loadTemplate('session-start.mjs');

// =============================================================================
// POST-TOOL-USE HOOK (Remember Tag Processing)
// =============================================================================

/** Post-tool-use Bash script - loaded from templates/hooks/post-tool-use.sh */
export const POST_TOOL_USE_SCRIPT = loadTemplate('post-tool-use.sh');

/** Post-tool-use Node.js script - loaded from templates/hooks/post-tool-use.mjs */
export const POST_TOOL_USE_SCRIPT_NODE = loadTemplate('post-tool-use.mjs');

// =============================================================================
// SETTINGS CONFIGURATION (Platform-aware)
// =============================================================================

/**
 * Settings.json hooks configuration for Bash (Unix)
 * Configures Claude Code to run our bash hook scripts
 */
export const HOOKS_SETTINGS_CONFIG_BASH = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command" as const,
            command: "bash $HOME/.claude/hooks/keyword-detector.sh"
          }
        ]
      }
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command" as const,
            command: "bash $HOME/.claude/hooks/session-start.sh"
          }
        ]
      }
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command" as const,
            command: "bash $HOME/.claude/hooks/post-tool-use.sh"
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command" as const,
            command: "bash $HOME/.claude/hooks/persistent-mode.sh"
          }
        ]
      }
    ]
  }
};

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
              : 'node "$HOME/.claude/hooks/keyword-detector.mjs"'
          }
        ]
      }
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\session-start.mjs"'
              : 'node "$HOME/.claude/hooks/session-start.mjs"'
          }
        ]
      }
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\post-tool-use.mjs"'
              : 'node "$HOME/.claude/hooks/post-tool-use.mjs"'
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command" as const,
            command: isWindows()
              ? 'node "%USERPROFILE%\\.claude\\hooks\\persistent-mode.mjs"'
              : 'node "$HOME/.claude/hooks/persistent-mode.mjs"'
          }
        ]
      }
    ]
  }
};

/**
 * Get the appropriate hooks settings config for the current platform
 */
export function getHooksSettingsConfig(): typeof HOOKS_SETTINGS_CONFIG_BASH {
  return shouldUseNodeHooks() ? HOOKS_SETTINGS_CONFIG_NODE : HOOKS_SETTINGS_CONFIG_BASH;
}

/**
 * Legacy: Settings.json hooks configuration (Bash)
 * @deprecated Use getHooksSettingsConfig() for cross-platform support
 */
export const HOOKS_SETTINGS_CONFIG = HOOKS_SETTINGS_CONFIG_BASH;

// =============================================================================
// HOOK SCRIPTS EXPORTS (Platform-aware)
// =============================================================================

/**
 * Get Bash hook scripts (Unix only)
 * Returns a record of filename -> content for all bash hooks
 */
export function getHookScriptsBash(): Record<string, string> {
  return {
    'keyword-detector.sh': loadTemplate('keyword-detector.sh'),
    'stop-continuation.sh': loadTemplate('stop-continuation.sh'),
    'persistent-mode.sh': loadTemplate('persistent-mode.sh'),
    'session-start.sh': loadTemplate('session-start.sh'),
    'post-tool-use.sh': loadTemplate('post-tool-use.sh')
  };
}

/**
 * Get Node.js hook scripts (Cross-platform)
 * Returns a record of filename -> content for all Node.js hooks
 */
export function getHookScriptsNode(): Record<string, string> {
  return {
    'keyword-detector.mjs': loadTemplate('keyword-detector.mjs'),
    'stop-continuation.mjs': loadTemplate('stop-continuation.mjs'),
    'persistent-mode.mjs': loadTemplate('persistent-mode.mjs'),
    'session-start.mjs': loadTemplate('session-start.mjs'),
    'post-tool-use.mjs': loadTemplate('post-tool-use.mjs')
  };
}

/**
 * Get the appropriate hook scripts for the current platform
 */
export function getHookScripts(): Record<string, string> {
  return shouldUseNodeHooks() ? getHookScriptsNode() : getHookScriptsBash();
}

// Legacy exports for backward compatibility (these call the loader functions)
/** @deprecated Use getHookScriptsBash() instead */
export const HOOK_SCRIPTS_BASH: Record<string, string> = getHookScriptsBash();

/** @deprecated Use getHookScriptsNode() instead */
export const HOOK_SCRIPTS_NODE: Record<string, string> = getHookScriptsNode();

/** @deprecated Use getHookScripts() for cross-platform support */
export const HOOK_SCRIPTS: Record<string, string> = HOOK_SCRIPTS_BASH;
