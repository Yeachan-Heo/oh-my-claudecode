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
/**
 * Check if a command matches safe patterns
 */
export declare function isSafeCommand(command: string): boolean;
/**
 * Check if an active mode (autopilot/ultrawork/ralph/swarm) is running
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