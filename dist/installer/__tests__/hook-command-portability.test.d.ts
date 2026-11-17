/**
 * Hook Command Portability Tests (Contracts 7-8)
 *
 * Guards against issues #2084 and #2348:
 *   - Hook commands must work across environments (no hardcoded home dirs)
 *   - Hook commands must not contain absolute node binary paths
 *   - Hook commands must reference files that actually exist in templates
 *
 * Tests the exported getHooksSettingsConfig() function which is the public API
 * for standalone hook configuration. Uses vi.resetModules() + dynamic import
 * because HOOKS_SETTINGS_CONFIG_NODE is a module-level constant evaluated at
 * import time based on CLAUDE_CONFIG_DIR.
 */
export {};
//# sourceMappingURL=hook-command-portability.test.d.ts.map