/**
 * Verification test: ensures no raw herdr child_process calls exist outside
 * herdr-session.ts.
 *
 * Every herdr call in the codebase must go through the centralized runner
 * (runHerdr/runHerdrRaw) defined in src/team/herdr-session.ts, mirroring the
 * tmux centralization guard. This test enforces that invariant.
 */
export {};
//# sourceMappingURL=herdr-no-raw-calls.test.d.ts.map