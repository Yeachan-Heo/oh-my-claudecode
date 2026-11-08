/**
 * Setup Contract Regression Tests
 *
 * Guards against recurring setup violations found in issues #2155, #2084, #2348, #2347.
 * Two core contracts:
 *   1. Never hardcode paths — use getClaudeConfigDir() or CLAUDE_CONFIG_DIR env var
 *   2. Never install to root ~/.claude when CLAUDE_CONFIG_DIR is set to a custom path
 *
 * Scanning approach: narrow construction-pattern matching (not broad string literals)
 * to avoid false positives and allowlist bloat.
 */
export {};
//# sourceMappingURL=setup-contracts-regression.test.d.ts.map