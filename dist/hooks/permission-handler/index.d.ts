export interface PermissionRequestInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'PermissionRequest';
    tool_name: string;
    tool_input: {
        command?: string;
        file_path?: string;
        content?: string;
        [key: string]: unknown;
    };
    tool_use_id: string;
}
export interface HookOutput {
    continue: boolean;
    hookSpecificOutput?: {
        hookEventName: string;
        decision?: {
            behavior: 'allow' | 'deny' | 'ask';
            reason?: string;
        };
    };
}
export declare function getClaudePermissionAllowEntries(directory: string): string[];
export declare function hasClaudePermissionApproval(directory: string, toolName: 'Edit' | 'Write' | 'Bash', command?: string): boolean;
export declare function getClaudePermissionAskEntries(directory: string): string[];
export declare function hasClaudePermissionAsk(directory: string, toolName: 'Edit' | 'Write' | 'Bash', command?: string): boolean;
export interface BackgroundPermissionFallbackResult {
    shouldFallback: boolean;
    missingTools: string[];
}
export declare function getBackgroundTaskPermissionFallback(directory: string, subagentType?: string): BackgroundPermissionFallbackResult;
export declare function getBackgroundBashPermissionFallback(directory: string, command?: string): BackgroundPermissionFallbackResult;
export declare function isSafeRepoInspectionCommand(command: string, cwd: string): boolean;
export declare function isSafeAutoApprovedCommand(command: string, cwd: string): boolean;
/**
 * Check if a command matches safe patterns
 */
export declare function isSafeCommand(command: string): boolean;
/**
 * Check if an active supported mode is running
 */
export declare function isActiveModeRunning(directory: string): boolean;
/**
 * Process permission request and decide whether to auto-allow
 */
export declare function processPermissionRequest(input: PermissionRequestInput): HookOutput;
/**
 * Main hook entry point
 */
export declare function handlePermissionRequest(input: PermissionRequestInput): Promise<HookOutput>;
//# sourceMappingURL=index.d.ts.map