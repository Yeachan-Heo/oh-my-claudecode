/**
 * Interop CLI Command - Split-pane tmux session with OMC and OMX
 *
 * Creates a tmux split-pane layout with Claude Code (OMC) on the left
 * and Codex CLI (OMX) on the right, with shared interop state.
 */
export type InteropMode = 'off' | 'observe' | 'active';
export interface InteropRuntimeFlags {
    enabled: boolean;
    mode: InteropMode;
    omcInteropToolsEnabled: boolean;
    failClosed: boolean;
}
export declare function readInteropRuntimeFlags(env?: NodeJS.ProcessEnv): InteropRuntimeFlags;
export declare function validateInteropRuntimeFlags(flags: InteropRuntimeFlags): {
    ok: boolean;
    reason?: string;
};
/**
 * Launch interop session with split tmux panes
 */
export declare function launchInteropSession(cwd?: string): void;
/**
 * CLI entry point for interop command
 */
export declare function interopCommand(options?: {
    cwd?: string;
}): void;
//# sourceMappingURL=interop.d.ts.map