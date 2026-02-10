export interface TokscaleLaunchOptions {
    view?: 'overview' | 'models' | 'daily' | 'stats';
    claude?: boolean;
}
/**
 * Check if tokscale CLI is available via bunx
 */
export declare function isTokscaleCLIAvailable(): Promise<boolean>;
/**
 * Launch tokscale interactive TUI
 *
 * tokscale subcommands:
 * - tui: default interactive view
 * - models: model breakdown view (also launches TUI)
 * - monthly: monthly report view (also launches TUI)
 *
 * Note: 'daily' and 'stats' views are not supported by tokscale,
 * so we fall back to 'tui' for those.
 */
export declare function launchTokscaleTUI(options?: TokscaleLaunchOptions): Promise<void>;
/**
 * Get installation instructions for tokscale
 */
export declare function getInstallInstructions(): string;
//# sourceMappingURL=tokscale-launcher.d.ts.map