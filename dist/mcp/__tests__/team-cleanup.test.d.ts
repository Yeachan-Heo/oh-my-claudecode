/**
 * Tests for team MCP cleanup hardening (plan: team-mcp-cleanup-4.4.0.md)
 *
 * Coverage:
 * - killOwnedWorkerPane: immutable ownership, strict membership, and leader guard
 * - killTeamSession: never kill-session on split-pane (':'), leader-pane skip
 * - validateJobId regex logic (inline, since function is internal to team-server.ts)
 * - exit-code mapping: runtime-cli exitCodeFor logic (no dedicated timeout exit code)
 */
export {};
//# sourceMappingURL=team-cleanup.test.d.ts.map