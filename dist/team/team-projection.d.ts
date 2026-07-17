import { type OwnerFence } from './team-owner-epoch.js';
export type ProjectionRepairResult = {
    classification: 'synced';
    revision: number;
} | {
    classification: 'repair_required';
    revision: number | null;
    reason: 'fence_lost' | 'config_changed' | 'recovery_changed' | 'invalid_config' | 'io_error';
};
export interface ProjectionRepairOptions {
    fence: OwnerFence;
    recoveryId?: string;
    maxAttempts?: number;
}
/**
 * Repair the mutable manifest projection only while the owner fence and source revision remain
 * current. A delayed repair stages a new temp after every mismatch and therefore cannot rename
 * a revision N+1 projection over a committed N+2 projection.
 */
export declare function repairTeamProjection(cwd: string, teamName: string, options: ProjectionRepairOptions): ProjectionRepairResult;
//# sourceMappingURL=team-projection.d.ts.map