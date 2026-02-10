/**
 * OMC Orchestrator Hook
 *
 * Enforces orchestrator behavior - delegation over direct implementation.
 * When an orchestrator agent tries to directly modify files outside .omc/,
 * this hook injects reminders to delegate to subagents instead.
 *
 * Adapted from oh-my-opencode's omc-orchestrator hook for shell-based hooks.
 */
export * from './constants.js';
export type EnforcementLevel = 'off' | 'warn' | 'strict';
/**
 * Clear enforcement level cache (for testing)
 * @internal
 */
export declare function clearEnforcementCache(): void;
/**
 * Input for tool execution hooks
 */
export interface ToolExecuteInput {
    toolName: string;
    toolInput?: Record<string, unknown>;
    sessionId?: string;
    directory?: string;
}
/**
 * Output for tool execution hooks
 */
export interface ToolExecuteOutput {
    continue: boolean;
    message?: string;
    reason?: string;
    modifiedOutput?: string;
}
/**
 * Git file change statistics
 */
interface GitFileStat {
    path: string;
    added: number;
    removed: number;
    status: 'modified' | 'added' | 'deleted';
}
/**
 * Check if a file path is allowed for direct orchestrator modification
 */
export declare function isAllowedPath(filePath: string, directory?: string): boolean;
/**
 * Check if a file path is a source file that should trigger delegation warning
 */
export declare function isSourceFile(filePath: string): boolean;
/**
 * Check if a tool is a write/edit tool
 */
export declare function isWriteEditTool(toolName: string): boolean;
/**
 * Get git diff statistics for the working directory
 */
export declare function getGitDiffStats(directory: string): GitFileStat[];
/**
 * Format file changes for display
 */
export declare function formatFileChanges(stats: GitFileStat[]): string;
/**
 * Build verification reminder with session context
 */
export declare function buildVerificationReminder(sessionId?: string): string;
/**
 * Build orchestrator reminder with plan progress
 */
export declare function buildOrchestratorReminder(planName: string, progress: {
    total: number;
    completed: number;
}, sessionId?: string): string;
/**
 * Build boulder continuation message
 */
export declare function buildBoulderContinuation(planName: string, remaining: number, total: number): string;
/**
 * Process pre-tool-use hook for orchestrator
 * Returns warning message if orchestrator tries to modify non-allowed paths
 */
export declare function processOrchestratorPreTool(input: ToolExecuteInput): ToolExecuteOutput;
/**
 * Process post-tool-use hook for orchestrator
 * Adds reminders after file modifications and Task delegations
 */
export declare function processOrchestratorPostTool(input: ToolExecuteInput, output: string): ToolExecuteOutput;
/**
 * Check if boulder has incomplete tasks and build continuation prompt
 */
export declare function checkBoulderContinuation(directory: string): {
    shouldContinue: boolean;
    message?: string;
};
/**
 * Create omc orchestrator hook handlers
 */
export declare function createSisyphusOrchestratorHook(directory: string): {
    /**
     * Hook name identifier
     */
    name: string;
    /**
     * Pre-tool execution handler
     */
    preTool: (toolName: string, toolInput: Record<string, unknown>) => ToolExecuteOutput;
    /**
     * Post-tool execution handler
     */
    postTool: (toolName: string, toolInput: Record<string, unknown>, output: string) => ToolExecuteOutput;
    /**
     * Check for boulder continuation on session idle
     */
    checkContinuation: () => {
        shouldContinue: boolean;
        message?: string;
    };
    /**
     * Get single task directive for subagent prompts
     */
    getSingleTaskDirective: () => string;
};
//# sourceMappingURL=index.d.ts.map