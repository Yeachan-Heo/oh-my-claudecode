import type { WorkerBackend, WorkerCapability } from './types.js';
export interface UnifiedTeamMember {
    name: string;
    agentId: string;
    backend: WorkerBackend;
    model: string;
    capabilities: WorkerCapability[];
    joinedAt: number;
    status: 'active' | 'idle' | 'dead' | 'quarantined' | 'unknown';
    currentTaskId: string | null;
}
/**
 * Get all team members from both Claude native teams and MCP workers.
 */
export declare function getTeamMembers(teamName: string, workingDirectory: string): UnifiedTeamMember[];
//# sourceMappingURL=unified-team.d.ts.map