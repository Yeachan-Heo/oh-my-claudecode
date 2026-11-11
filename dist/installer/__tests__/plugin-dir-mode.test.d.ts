/**
 * Tests for `--plugin-dir-mode` setup flag and `OMC_PLUGIN_ROOT` auto-detection.
 *
 * Behavior under test (from src/installer/index.ts and src/cli/index.ts):
 *   1. `pluginDirMode: true` → install() does NOT copy legacy agents and does NOT
 *      install bundled skills, but still installs HUD/hooks/CLAUDE.md.
 *   2. `OMC_PLUGIN_ROOT` env var (set by `omc --plugin-dir`) → CLI auto-detects
 *      and behaves as if `--plugin-dir-mode` were passed.
 *   3. No flag, no env var → existing behavior (legacy agents + bundled skills
 *      still copied when no plugin is enabled).
 *   4. `--no-plugin` + `--plugin-dir-mode` → `--no-plugin` wins (skills copied).
 *   5. Real OMC plugin enabled → existing skip behavior unchanged (independent
 *      of pluginDirMode).
 *
 * These tests run install() against a throwaway CLAUDE_CONFIG_DIR and assert on
 * the resulting filesystem layout. Module imports are reset between tests so
 * each call picks up the isolated config dir.
 */
export {};
//# sourceMappingURL=plugin-dir-mode.test.d.ts.map