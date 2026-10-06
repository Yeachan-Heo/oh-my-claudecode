/**
 * E2E crash-recovery tests (AC-2 kill/resume, AC-3 replay determinism).
 *
 * Spawns REAL child processes through the built CLI entry
 * (`node dist/cli/index.js graph run <fixture> --runs-root <tmp>`), kills the
 * child mid-run once a node completion is journaled, then re-spawns and proves:
 * - the resumed run completes exit 0,
 * - journaled nodes are NOT re-executed (replay line + no activation_started
 *   for them in stdout + single journal record + marker mtime unchanged),
 * - the resumed final projection equals a clean direct run's projection under
 *   canonicalJson equality (epoch-bearing envelope fields excluded).
 */
export {};
//# sourceMappingURL=e2e-crash-recovery.test.d.ts.map