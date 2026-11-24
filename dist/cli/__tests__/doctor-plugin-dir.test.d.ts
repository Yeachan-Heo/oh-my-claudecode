/**
 * Tests for --plugin-dir support in `omc doctor` and `omc doctor conflicts`.
 *
 * Section 1 (applyPluginDirOption unit tests): tests the helper directly.
 * Section 2 (Commander integration tests): constructs the actual program via
 *   buildProgram() and calls parseAsync() to verify the flag is wired end-to-end.
 *
 * OMC_CLI_SKIP_PARSE prevents index.ts from calling program.parse() at import
 * time (which would trigger launchCommand → process.exit inside the test
 * worker that inherits CLAUDECODE from the parent Claude Code session).
 */
export {};
//# sourceMappingURL=doctor-plugin-dir.test.d.ts.map