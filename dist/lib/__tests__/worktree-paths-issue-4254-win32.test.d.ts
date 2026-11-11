/**
 * Regression for #4254: a session started in a SUBDIRECTORY of a git repo must
 * resolve the HUD working directory the same way a session started at the repo
 * root does. On Windows, git reports the toplevel as `D:/repo` while Node paths
 * use `D:\repo`, so raw string comparisons of the two rejected the repo's own
 * root as a cross-repository path.
 *
 * Uses a real git repository and no probe mocks so the Windows CI job
 * (ci.yml `test-windows`) exercises real git output and real realpath results.
 */
export {};
//# sourceMappingURL=worktree-paths-issue-4254-win32.test.d.ts.map