import * as fs from 'fs';
import * as path from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
const SAFE_PATTERNS = [
    /^git (status|diff|log|branch|show|fetch)/,
    /^npm (test|run (test|lint|build|check|typecheck))/,
    /^pnpm (test|run (test|lint|build|check|typecheck))/,
    /^yarn (test|run (test|lint|build|check|typecheck))/,
    /^tsc( |$)/,
    /^eslint /,
    /^prettier /,
    /^cargo (test|check|clippy|build)/,
    /^pytest/,
    /^python -m pytest/,
    /^ls( |$)/,
    // REMOVED: cat, head, tail - they allow reading arbitrary files
];
// Shell metacharacters that enable command chaining and injection
// See GitHub Issue #146 for full list of dangerous characters
// Note: Quotes ("') intentionally excluded - they're needed for paths with spaces
// and command substitution is already caught by $ detection
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\r\t\0\\{}\[\]*?~!#]/;
// Heredoc operator detection (<<, <<-, <<~, with optional quoting of delimiter)
const HEREDOC_PATTERN = /<<[-~]?\s*['"]?\w+['"]?/;
/**
 * Patterns that are safe to auto-allow even when they contain heredoc content.
 * Matched against the first line of the command (before the heredoc body).
 * Issue #608: Prevents full heredoc body from being stored in settings.local.json.
 */
const SAFE_HEREDOC_PATTERNS = [
    /^git commit\b/,
    /^git tag\b/,
];
/**
 * Check if a command matches safe patterns
 */
export function isSafeCommand(command) {
    const trimmed = command.trim();
    // SECURITY: Reject ANY command with shell metacharacters
    // These allow command chaining that bypasses safe pattern checks
    if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
        return false;
    }
    return SAFE_PATTERNS.some(pattern => pattern.test(trimmed));
}
/**
 * Check if a command is a heredoc command with a safe base command.
 * Issue #608: Heredoc commands contain shell metacharacters (<<, \n, $, etc.)
 * that cause isSafeCommand() to reject them. When they fall through to Claude
 * Code's native permission flow and the user approves "Always allow", the entire
 * heredoc body (potentially hundreds of lines) gets stored in settings.local.json.
 *
 * This function detects heredoc commands and checks whether the base command
 * (first line) matches known-safe patterns, allowing auto-approval without
 * polluting settings.local.json.
 */
export function isHeredocWithSafeBase(command) {
    const trimmed = command.trim();
    // Heredoc commands from Claude Code are always multi-line
    if (!trimmed.includes('\n')) {
        return false;
    }
    // Must contain a heredoc operator
    if (!HEREDOC_PATTERN.test(trimmed)) {
        return false;
    }
    // Extract the first line as the base command
    const firstLine = trimmed.split('\n')[0].trim();
    // Check if the first line starts with a safe pattern
    return SAFE_HEREDOC_PATTERNS.some(pattern => pattern.test(firstLine));
}
/**
 * Check if an active mode (autopilot/ultrawork/ralph/team) is running
 */
export function isActiveModeRunning(directory) {
    const stateDir = path.join(getOmcRoot(directory), 'state');
    if (!fs.existsSync(stateDir)) {
        return false;
    }
    const activeStateFiles = [
        'autopilot-state.json',
        'ralph-state.json',
        'ultrawork-state.json',
        'team-state.json',
    ];
    for (const stateFile of activeStateFiles) {
        const statePath = path.join(stateDir, stateFile);
        if (fs.existsSync(statePath)) {
            // JSON state files: check active/status fields
            try {
                const content = fs.readFileSync(statePath, 'utf-8');
                const state = JSON.parse(content);
                // Check if mode is active
                if (state.active === true || state.status === 'running' || state.status === 'active') {
                    return true;
                }
            }
            catch (_error) {
                // Ignore parse errors, continue checking
                continue;
            }
        }
    }
    return false;
}
/**
 * Process permission request and decide whether to auto-allow
 */
export function processPermissionRequest(input) {
    // Only process Bash tool for command auto-approval
    // Normalize tool name - handle both proxy_ prefixed and unprefixed versions
    const toolName = input.tool_name.replace(/^proxy_/, '');
    if (toolName !== 'Bash') {
        return { continue: true };
    }
    const command = input.tool_input.command;
    if (!command || typeof command !== 'string') {
        return { continue: true };
    }
    // Auto-allow safe commands
    if (isSafeCommand(command)) {
        return {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    reason: 'Safe read-only or test command',
                },
            },
        };
    }
    // Auto-allow heredoc commands with safe base commands (Issue #608)
    // This prevents the full heredoc body from being stored in settings.local.json
    if (isHeredocWithSafeBase(command)) {
        return {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    reason: 'Safe command with heredoc content',
                },
            },
        };
    }
    // Default: let normal permission flow handle it
    return { continue: true };
}
/**
 * Main hook entry point
 */
export async function handlePermissionRequest(input) {
    return processPermissionRequest(input);
}
//# sourceMappingURL=index.js.map