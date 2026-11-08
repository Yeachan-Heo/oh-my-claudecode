/**
 * Tests for `--plugin-dir` capture in `omc` launch.
 *
 * Plan: binary-weaving-mountain — HUD wrapper resolves the active plugin root
 * from `process.env.OMC_PLUGIN_ROOT`, set by the `omc` CLI when the user
 * passes `--plugin-dir <path>`. The flag must NOT be consumed (it still
 * forwards to Claude Code's plugin loader untouched).
 */
export {};
//# sourceMappingURL=plugin-dir-capture.test.d.ts.map