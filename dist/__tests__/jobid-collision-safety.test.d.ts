/**
 * Regression tests for race condition bug fixes.
 *
 * BUG 1: shared-state updateSharedTask has no file locking
 * BUG 2: git-worktree removeWorkerWorktree has unlocked metadata update
 * BUG 3: team-ops teamCreateTask has race on task ID generation
 * BUG 4: generateJobId not collision-safe
 */
export {};
//# sourceMappingURL=jobid-collision-safety.test.d.ts.map