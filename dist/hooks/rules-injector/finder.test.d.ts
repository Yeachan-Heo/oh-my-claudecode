/**
 * Regression tests for issue #3653: rules-injector unbounded upward walk
 * when no project root exists.
 *
 * findRuleFiles(projectRoot, currentFile) used to ascend from the current
 * file's directory all the way to the filesystem root whenever projectRoot
 * was null, so unrelated ancestor .cursor/rules, .claude/rules, and
 * .github/instructions directories were treated as project rules. With no
 * project root, only the current file's own directory's project-rule
 * subdirectories are in scope; the explicit user-level
 * [$CLAUDE_CONFIG_DIR|~/.claude]/rules lookup is separate and unchanged.
 */
export {};
//# sourceMappingURL=finder.test.d.ts.map