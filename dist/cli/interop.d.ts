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
 * Launch interop session with split tmux panes (or a Herdr side-by-side tab
 * when running inside Herdr / the herdr backend is elected)
 */
export declare function launchInteropSession(cwd?: string): Promise<void>;
/**
 * CLI entry point for interop command
 */
export declare function interopCommand(options?: {
    cwd?: string;
}): Promise<void>;
//# sourceMappingURL=interop.d.ts.map