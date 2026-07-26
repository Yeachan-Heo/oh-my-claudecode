/**
 * Compact, public-only Graph runtime status.
 */
export type ActiveGraphStatus = 'awaiting_approval' | 'running' | 'waiting_human' | 'waiting_patch_approval' | 'reconciling' | 'unreadable';
export interface GraphStateForHud {
    status: ActiveGraphStatus;
    completedActivations: number;
    totalActivations: number;
    readyActivations: number;
    liveClaims: number;
    unresolvedReconciliations: number;
    revisionHashShort: string;
}
export declare function renderGraph(state: GraphStateForHud | null | undefined): string | null;
//# sourceMappingURL=graph.d.ts.map