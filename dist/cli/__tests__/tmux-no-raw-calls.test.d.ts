/**
 * Verification test: ensures no raw tmux child_process calls exist outside tmux-utils.ts.
 *
 * Every tmux call in the codebase must go through the centralized wrappers
 * (tmuxExec, tmuxExecAsync, tmuxShell, tmuxShellAsync, tmuxSpawn, tmuxCmdAsync)
 * defined in src/cli/tmux-utils.ts. This test enforces that invariant.
 */
export {};
//# sourceMappingURL=tmux-no-raw-calls.test.d.ts.map