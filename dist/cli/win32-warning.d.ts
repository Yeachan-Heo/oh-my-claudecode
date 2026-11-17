/**
 * Warn if running on native Windows (win32) without tmux available.
 * Called at CLI startup from src/cli/index.ts.
 * If a tmux-compatible binary (e.g. psmux) is on PATH, the warning is skipped.
 */
export declare function warnIfWin32(): void;
//# sourceMappingURL=win32-warning.d.ts.map