/**
 * Regression tests for issue #2532: centralized OMC_STATE_DIR state-root resolution.
 *
 * Verifies that:
 *   1. Default behavior (no OMC_STATE_DIR) is unchanged — state lives in {dir}/.omc/
 *   2. session-start.mjs reads session state from the custom OMC_STATE_DIR location
 *   3. persistent-mode.cjs (stop hook) reads mode state from the custom OMC_STATE_DIR
 *      location and correctly blocks the stop when an active mode is present there
 *   4. pre-tool-enforcer.mjs (PreToolUse hook) reads team-state and writes
 *      skill-active-state through the centralized OMC_STATE_DIR location
 */
export {};
//# sourceMappingURL=state-root-resolution.test.d.ts.map