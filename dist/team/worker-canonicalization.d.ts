import type { TeamConfig, WorkerInfo } from './types.js';
export interface WorkerCanonicalizationResult {
    workers: WorkerInfo[];
    duplicateNames: string[];
}
export declare function canonicalizeWorkers(workers: WorkerInfo[]): WorkerCanonicalizationResult;
export declare function canonicalizeTeamConfigWorkers(config: TeamConfig): TeamConfig;
//# sourceMappingURL=worker-canonicalization.d.ts.map