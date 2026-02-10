import type { TaskTool, BeadsContextConfig } from './types.js';
export type { TaskTool, BeadsContextConfig } from './types.js';
export { BEADS_INSTRUCTIONS, BEADS_RUST_INSTRUCTIONS } from './constants.js';
/**
 * Get beads instructions for the given tool variant.
 */
export declare function getBeadsInstructions(tool: Exclude<TaskTool, 'builtin'>): string;
/**
 * Read beads context config from omc-config.json.
 */
export declare function getBeadsContextConfig(): BeadsContextConfig;
/**
 * Register beads context for a session.
 * Called from setup hook on session init.
 */
export declare function registerBeadsContext(sessionId: string): boolean;
/**
 * Clear beads context for a session.
 */
export declare function clearBeadsContext(sessionId: string): void;
//# sourceMappingURL=index.d.ts.map