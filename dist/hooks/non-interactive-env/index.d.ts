import type { ShellHook } from "./types.js";
export * from "./constants.js";
export * from "./detector.js";
export * from "./types.js";
/**
 * Non-interactive environment hook for Claude Code.
 *
 * Detects and handles non-interactive environments (CI, cron, etc.) by:
 * - Warning about banned interactive commands (vim, less, etc.)
 * - Injecting environment variables to prevent git/tools from prompting
 * - Prepending export statements to git commands to block editors/pagers
 */
export declare const nonInteractiveEnvHook: ShellHook;
//# sourceMappingURL=index.d.ts.map