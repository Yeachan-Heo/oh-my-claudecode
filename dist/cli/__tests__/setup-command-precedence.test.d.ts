/**
 * Real commander-pipeline tests for `omc setup --plugin-dir-mode` and the
 * OMC_PLUGIN_ROOT auto-detection precedence.
 *
 * These tests drive the *actual* commander program built by `src/cli/index.ts`
 * (via the exported `buildProgram()` helper) and assert on the `InstallOptions`
 * passed into `install()`. The installer module is mocked at module level so
 * nothing touches the filesystem.
 *
 * Cases (mirroring src/installer/__tests__/plugin-dir-mode.test.ts which
 * previously re-implemented this precedence logic in the test file itself):
 *
 *   1. --plugin-dir-mode flag                       → opts.pluginDirMode === true
 *   2. OMC_PLUGIN_ROOT env, no flag                 → opts.pluginDirMode === true + auto-detect log
 *   3. neither                                      → opts.pluginDirMode === false
 *   4. --plugin-dir-mode --no-plugin                → pluginDirMode=false, noPlugin=true, conflict warning
 *   5. OMC_PLUGIN_ROOT + --no-plugin                → pluginDirMode=false, noPlugin=true, conflict warning
 *   6. --plugin-dir-mode --force                    → pluginDirMode=true, force=true
 */
export {};
//# sourceMappingURL=setup-command-precedence.test.d.ts.map