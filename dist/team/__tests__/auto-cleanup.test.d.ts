/**
 * Auto-Cleanup Tests for MCP Team Bridge
 *
 * Tests the auto-cleanup detection logic introduced in mcp-team-bridge.ts:
 * when getTeamStatus reports pending === 0 && inProgress === 0, the worker
 * should self-terminate. When inProgress > 0 or pending > 0, it must NOT.
 *
 * Because handleShutdown involves tmux and process teardown, we test the
 * condition that gates it: getTeamStatus().taskSummary reflects the correct
 * counts so the bridge can make the right decision.
 */
export {};
//# sourceMappingURL=auto-cleanup.test.d.ts.map