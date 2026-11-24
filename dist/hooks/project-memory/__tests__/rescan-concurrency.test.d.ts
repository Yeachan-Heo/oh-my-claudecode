/**
 * Regression tests: a stale rescan must not overwrite concurrent locked writes.
 *
 * registerProjectMemoryContext and rescanProjectEnvironment both rescan project
 * memory. Detection is slow, so a locked writer (addCustomNote,
 * learnFromToolOutput) can persist user data between the rescan's initial read
 * and its save. These tests gate the detector to reproduce that window
 * deterministically and assert the concurrent user data survives the rescan.
 */
export {};
//# sourceMappingURL=rescan-concurrency.test.d.ts.map