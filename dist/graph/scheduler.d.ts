/**
 * Graph Core pure deterministic scheduler (stage-04 contract).
 *
 * Contract-authored from the ralplan stage-04 revision (`pending-approval.md`);
 * oracle `99ffe31` used only for behavioral cross-checks. Scheduler accepts only
 * `SealedGraphDescriptor`; projections are descriptor-bound; record-bearing
 * mutations are replay-fenced; begin/release commit nothing.
 */
import type { ApplyHumanApprovalInput, ApplyNodeResultInput, BeginActivationAttemptInput, GraphActivation, GraphEdge, GraphSchedulerErrorCode, GraphSchedulerProjection, ReleaseAttemptForRetryInput, ResolveJoinInput, SchedulerApplyResult, SealedGraphDescriptor } from "./types.js";
export declare class GraphSchedulerError extends Error {
    readonly code: GraphSchedulerErrorCode;
    constructor(code: GraphSchedulerErrorCode, message: string);
}
/** Create the initial descriptor-bound projection with entry activations. */
export declare function initializeGraphProjection(descriptor: SealedGraphDescriptor, entryActivationIds: Readonly<Record<string, string>>): GraphSchedulerProjection;
/** Plain projection transform; commits no transition record. */
export declare function beginActivationAttempt(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection, input: BeginActivationAttemptInput): GraphSchedulerProjection;
/**
 * Atomic final-budget release: if `attempt_no >= node.max_attempts` at release
 * time the activation goes terminal `failed` (never an unstartable ready state);
 * otherwise it returns to `ready`. Plain projection transform; no record.
 */
export declare function releaseAttemptForRetry(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection, input: ReleaseAttemptForRetryInput): GraphSchedulerProjection;
/** Record-bearing mutation for agent/command completion (replay-fenced). */
export declare function applyNodeResult(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection, input: ApplyNodeResultInput): SchedulerApplyResult;
/**
 * Dedicated human-approval transition. `approved` follows the node's single
 * fixed outgoing edge; `denied` terminal-fails the activation. Records carry
 * `output_summary` (never `summary`) and no `attempt_id`; both outcomes require
 * at least one evidence reference. Replay-fenced.
 */
export declare function applyHumanApproval(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection, input: ApplyHumanApprovalInput): SchedulerApplyResult;
/** Resolve a join: consume cohort + tokens exactly once, create the next activation. */
export declare function resolveJoin(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection, input: ResolveJoinInput): SchedulerApplyResult;
/** Per-lineage traversal counter key (pure helper; no descriptor). */
export declare function traversalCounterKey(activation: GraphActivation, edge: GraphEdge): string;
/** Hash-fenced read: ready agent/command activations in code-unit order. */
export declare function listReadyExecutableActivations(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection): readonly GraphActivation[];
/** Hash-fenced read: ready human-approval activations in code-unit order. */
export declare function listReadyApprovalActivations(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection): readonly GraphActivation[];
/** Hash-fenced read: ready join activations in code-unit order. */
export declare function listReadyJoinActivations(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection): readonly GraphActivation[];
/**
 * Hash-fenced read: true iff at least one terminal verification activation
 * completed with a succeeded, evidence-bearing transition, every activation is
 * completed, and every cohort is consumed.
 */
export declare function isGraphSucceeded(descriptor: SealedGraphDescriptor, projection: GraphSchedulerProjection): boolean;
//# sourceMappingURL=scheduler.d.ts.map