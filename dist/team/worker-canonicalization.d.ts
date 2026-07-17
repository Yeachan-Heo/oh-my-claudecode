import type { TeamConfig, WorkerInfo } from './types.js';
export interface WorkerCanonicalizationResult {
    workers: WorkerInfo[];
    duplicateNames: string[];
}
/**
 * Legacy aggregation only. Persisted config rows must be validated before this
 * function is called; it intentionally retains historical trim-and-merge behavior.
 */
export declare function canonicalizeWorkers(workers: WorkerInfo[]): WorkerCanonicalizationResult;
export declare function canonicalizeTeamConfigWorkers(config: TeamConfig): TeamConfig;
//# sourceMappingURL=worker-canonicalization.d.ts.map