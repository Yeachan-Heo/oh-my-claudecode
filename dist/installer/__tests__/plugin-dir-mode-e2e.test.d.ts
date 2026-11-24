/**
 * End-to-end filesystem tests for `--plugin-dir-mode`.
 *
 * Unlike `plugin-dir-mode.test.ts`, which exercises the CLI precedence helper
 * in isolation, this suite calls the real `install()` function from
 * `src/installer/index.ts` against a throwaway `CLAUDE_CONFIG_DIR` and asserts
 * the resulting on-disk shape matches the documented contract.
 *
 * Scope: installer contract only. The CLI auto-detection log message and the
 * `--no-plugin` / `--plugin-dir-mode` conflict warning live in `src/cli/index.ts`
 * and are exercised by Slice C's CLI tests.
 */
export {};
//# sourceMappingURL=plugin-dir-mode-e2e.test.d.ts.map