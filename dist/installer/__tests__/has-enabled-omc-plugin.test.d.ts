/**
 * Regression tests for `hasEnabledOmcPlugin()` settings format detection.
 *
 * Background: prior to this fix, the function read `settings.plugins`, but
 * Claude Code 1.x writes the canonical field as `settings.enabledPlugins`.
 * As a result, `omc update`/`omc setup` invoked from a regular shell (where
 * `CLAUDE_PLUGIN_ROOT` is unset) saw "no plugin enabled" and bypassed the
 * `prunePluginDuplicateSkills` branch entirely, leaving every user with a
 * Claude Code 1.x settings.json permanently stuck in the duplicate-skill
 * state from #2252.
 *
 * These tests pin both the modern (`enabledPlugins`) and the legacy
 * (`plugins`) detection paths so a future patch cannot regress either
 * surface.
 */
export {};
//# sourceMappingURL=has-enabled-omc-plugin.test.d.ts.map