import type { ApplyNodeResultInput, BeginActivationAttemptInput, GraphActivation, GraphBackEdge, GraphDescriptor, GraphSchedulerProjection, ReleaseAttemptForRetryInput, ResolveJoinInput, SchedulerApplyResult } from './types.js';
export declare class GraphSchedulerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function initializeGraphProjection(descriptor: GraphDescriptor, entryActivationIds: Record<string, string>): GraphSchedulerProjection;
export declare function beginActivationAttempt(projection: GraphSchedulerProjection, input: BeginActivationAttemptInput): GraphSchedulerProjection;
export declare function releaseAttemptForRetry(projection: GraphSchedulerProjection, input: ReleaseAttemptForRetryInput): GraphSchedulerProjection;
export declare function traversalCounterKey(activation: Pick<GraphActivation, 'traversal_owner_id'>, edge: Pick<GraphBackEdge, 'id'>): string;
export declare function applyNodeResult(descriptor: GraphDescriptor, projection: GraphSchedulerProjection, rawInput: ApplyNodeResultInput): SchedulerApplyResult;
export declare function resolveJoin(descriptor: GraphDescriptor, projection: GraphSchedulerProjection, input: ResolveJoinInput): SchedulerApplyResult;
export declare function listReadyExecutableActivations(descriptor: GraphDescriptor, projection: GraphSchedulerProjection): GraphActivation[];
export declare function listReadyJoinActivations(descriptor: GraphDescriptor, projection: GraphSchedulerProjection): GraphActivation[];
export declare function isGraphSucceeded(descriptor: GraphDescriptor, projection: GraphSchedulerProjection): boolean;
//# sourceMappingURL=scheduler.d.ts.map