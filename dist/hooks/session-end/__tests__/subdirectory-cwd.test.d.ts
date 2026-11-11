/**
 * Tests for issue #891: MCP state tools and stop hook resolve .omc/state/
 * differently when cwd is a subdirectory.
 *
 * processSessionEnd must normalize input.cwd to the git worktree root before
 * building any .omc/ paths, so it always operates on the same directory that
 * the MCP state tools write to.
 */
export {};
//# sourceMappingURL=subdirectory-cwd.test.d.ts.map