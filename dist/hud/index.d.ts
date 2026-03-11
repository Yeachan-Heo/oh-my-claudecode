#!/usr/bin/env node
/**
 * OMC HUD - Main Entry Point
 *
 * Statusline command that visualizes oh-my-claudecode state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */
/**
 * Main HUD entry point
 * @param watchMode - true when called from the --watch polling loop (stdin is TTY)
 */
declare function main(watchMode?: boolean, skipInit?: boolean): Promise<void>;
export { main };
//# sourceMappingURL=index.d.ts.map