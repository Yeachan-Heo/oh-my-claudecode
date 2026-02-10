/**
 * Hook Bridge - TypeScript logic invoked by shell scripts
 *
 * This module provides the main entry point for shell hooks to call TypeScript
 * for complex processing. The shell script reads stdin, passes it to this module,
 * and writes the JSON output to stdout.
 *
 * Usage from shell:
 * ```bash
 * #!/bin/bash
 * INPUT=$(cat)
 * echo "$INPUT" | node ~/.claude/omc/hook-bridge.mjs --hook=keyword-detector
 * ```
 */
/**
 * Returns the required camelCase keys for a given hook type.
 * Centralizes key requirements to avoid drift between normalization and validation.
 */
export declare function requiredKeysForHook(hookType: string): string[];
/**
 * Input format from Claude Code hooks (via stdin)
 */
export interface HookInput {
    /** Session identifier */
    sessionId?: string;
    /** User prompt text */
    prompt?: string;
    /** Message content (alternative to prompt) */
    message?: {
        content?: string;
    };
    /** Message parts (alternative structure) */
    parts?: Array<{
        type: string;
        text?: string;
    }>;
    /** Tool name (for tool hooks) */
    toolName?: string;
    /** Tool input parameters */
    toolInput?: unknown;
    /** Tool output (for post-tool hooks) */
    toolOutput?: unknown;
    /** Working directory */
    directory?: string;
}
/**
 * Output format for Claude Code hooks (to stdout)
 */
export interface HookOutput {
    /** Whether to continue with the operation */
    continue: boolean;
    /** Optional message to inject into context */
    message?: string;
    /** Reason for blocking (when continue=false) */
    reason?: string;
    /** Modified tool input (for pre-tool hooks) */
    modifiedInput?: unknown;
}
/**
 * Hook types that can be processed
 */
export type HookType = "keyword-detector" | "stop-continuation" | "ralph" | "persistent-mode" | "session-start" | "session-end" | "pre-tool-use" | "post-tool-use" | "autopilot" | "subagent-start" | "subagent-stop" | "pre-compact" | "setup-init" | "setup-maintenance" | "permission-request";
/**
 * Reset the skip hooks cache (for testing only)
 */
export declare function resetSkipHooksCache(): void;
/**
 * Main hook processor
 * Routes to specific hook handler based on type
 */
export declare function processHook(hookType: HookType, rawInput: HookInput): Promise<HookOutput>;
/**
 * CLI entry point for shell script invocation
 * Reads JSON from stdin, processes hook, writes JSON to stdout
 */
export declare function main(): Promise<void>;
//# sourceMappingURL=bridge.d.ts.map