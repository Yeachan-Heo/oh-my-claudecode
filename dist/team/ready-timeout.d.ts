/**
 * OMC_TEAM_READY_TIMEOUT_MS parsing shared by scale-up (scaling.ts) and the
 * startup inbox wait (tmux-session.ts). Kept dependency-free because
 * scaling.ts already imports tmux-session.ts.
 */
export declare const READY_TIMEOUT_ENV = "OMC_TEAM_READY_TIMEOUT_MS";
/**
 * The variable as an exact integer, or undefined when it is unset, blank, or
 * not an integer (`abc`, `1.5`, `NaN`, `Infinity`). Rejecting before any
 * clamp matters: `Math.max(30000, NaN)` is NaN.
 */
export declare function parseReadyTimeoutMs(env: NodeJS.ProcessEnv): number | undefined;
/** Startup wait: the variable clamped to 30000..120000ms, else 30000ms. */
export declare function resolveStartupReadyTimeoutMs(env: NodeJS.ProcessEnv): number;
/**
 * One-line note on what the variable was set to and the wait the caller used.
 */
export declare function describeStartupReadyTimeout(env: NodeJS.ProcessEnv, effectiveMs: number): string;
//# sourceMappingURL=ready-timeout.d.ts.map