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
    /** Optional agent name context for routing prompt variants */
    agentName?: string;
    /** Optional model identifier context for routing prompt variants */
    model?: string;
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
type SerializableHookOutput = HookOutput & {
    suppressOutput?: boolean;
    systemMessage?: string;
    hookSpecificOutput?: Record<string, unknown>;
};
/**
 * Strip empty hook text fields before serializing to Claude Code.
 *
 * Some hook handlers use empty strings as internal sentinels. Passing those
 * through to the shell hook protocol can create empty system-message/context
 * injections on the next turn, which is especially risky after Task/Agent
 * completion when Claude is deciding whether to continue.
 */
export declare function sanitizeHookOutputForSerialization(output: SerializableHookOutput): SerializableHookOutput;
/**
 * Hook types that can be processed
 */
export type HookType = "keyword-detector" | "stop-continuation" | "ralph" | "persistent-mode" | "session-start" | "session-end" | "pre-tool-use" | "post-tool-use" | "autopilot" | "subagent-start" | "subagent-stop" | "pre-compact" | "setup-init" | "setup-maintenance" | "permission-request" | "code-simplifier";
/**
 * Fire-and-forget notification for AskUserQuestion (issue #597).
 * Extracted for testability; the dynamic import makes direct assertion
 * on the notify() call timing-sensitive, so tests spy on this wrapper instead.
 */
export declare function dispatchAskUserQuestionNotification(sessionId: string, directory: string, toolInput: unknown): void;
/** @internal Object wrapper so tests can spy on the dispatch call. */
export declare const _notify: {
    askUserQuestion: typeof dispatchAskUserQuestionNotification;
};
/**
 * @internal Object wrapper for OpenClaw gateway dispatch.
 * Mirrors the _notify pattern for testability (tests spy on _openclaw.wake
 * instead of mocking dynamic imports).
 *
 * Fire-and-forget: the lazy import + double .catch() ensures OpenClaw
 * never blocks hooks or surfaces errors.
 */
export declare const _openclaw: {
    wake: (event: import("../openclaw/types.js").OpenClawHookEvent, context: import("../openclaw/types.js").OpenClawContext) => void;
};
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
export {};
//# sourceMappingURL=bridge.d.ts.map