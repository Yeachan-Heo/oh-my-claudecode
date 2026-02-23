#!/usr/bin/env node
/**
 * Team MCP Server - tmux CLI worker runtime tools
 *
 * Exposes three tools for running tmux-based teams (claude/codex/gemini workers):
 *   omc_run_team_start  - spawn workers in background, return jobId immediately
 *   omc_run_team_status - non-blocking poll for job completion
 *   omc_run_team_wait   - blocking wait: polls internally, returns when done (one call instead of N)
 *
 * __dirname in the CJS bundle (bridge/team-mcp.cjs) points to the bridge/
 * directory, where runtime-cli.cjs is co-located — works for all install paths.
 *
 * Built by: scripts/build-team-server.mjs → bridge/team-mcp.cjs
 */
export {};
//# sourceMappingURL=team-server.d.ts.map