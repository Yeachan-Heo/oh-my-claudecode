/**
 * Regression tests for issue #2508:
 * PSM tmux sessions stalling on approval/confirm prompts.
 *
 * These are contract tests: they read the shell script source and assert that
 * the fix is in place. A reversion to bare `claude` (no trust flag) or removal
 * of the initial-context handling will immediately break these tests.
 */
export {};
//# sourceMappingURL=psm-launch-trust.test.d.ts.map