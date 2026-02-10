import type { McpWorkerMember, ConfigProbeResult } from './types.js';
/** Read cached probe result. Returns null if not probed yet. */
export declare function readProbeResult(workingDirectory: string): ConfigProbeResult | null;
/** Write probe result cache */
export declare function writeProbeResult(workingDirectory: string, result: ConfigProbeResult): void;
/**
 * Determine registration strategy: 'config' (direct) or 'shadow' (fallback).
 * Based on cached probe result. Defaults to 'shadow' if not probed.
 */
export declare function getRegistrationStrategy(workingDirectory: string): 'config' | 'shadow';
/**
 * Register an MCP worker in the team.
 *
 * Strategy auto-selected based on cached probe result:
 * - 'config': Write member to config.json (preferred)
 * - 'shadow': Write member to .omc/state/team-mcp-workers.json (fallback)
 *
 * Both paths use atomic write (temp + rename) to prevent corruption.
 */
export declare function registerMcpWorker(teamName: string, workerName: string, provider: 'codex' | 'gemini', model: string, tmuxTarget: string, cwd: string, workingDirectory: string): void;
/**
 * Unregister an MCP worker from the team.
 * Removes from config.json and shadow registry.
 */
export declare function unregisterMcpWorker(teamName: string, workerName: string, workingDirectory: string): void;
/** Check if a member entry is an MCP worker */
export declare function isMcpWorker(member: Record<string, unknown>): boolean;
/** List all MCP workers for a team (reads from both config.json and shadow registry) */
export declare function listMcpWorkers(teamName: string, workingDirectory: string): McpWorkerMember[];
//# sourceMappingURL=team-registration.d.ts.map