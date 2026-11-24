/**
 * Regression tests for issue #2577: context window bloat
 *
 * Three bugs fixed:
 *  Bug 1 – Skill-injector fallback used an in-memory Map that reset on every
 *           process spawn.  Fixed by persisting state to a JSON file.
 *  Bug 2 – Rules-injector module was never wired into hooks.json.
 *           Fixed by adding post-tool-rules-injector.mjs to PostToolUse.
 *  Bug 3 – In a git worktree nested inside the parent repo, rules from the
 *           parent repo could bleed into the worktree session.
 *           Fixed: projectRoot is derived from the accessed FILE's path via
 *           findProjectRoot, not from data.cwd, so the .git FILE at the
 *           worktree root terminates the upward walk before the parent.
 */
export {};
//# sourceMappingURL=context-bloat-2577.test.d.ts.map