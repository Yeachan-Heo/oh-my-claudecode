import { type GraphState } from './runtime-types.js';
import type { GraphEvidenceReference, GraphSchedulerProjection, SealedGraphDescriptor } from './types.js';
export declare class GraphRevisionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface ReplacePendingDraftInput {
    descriptor: SealedGraphDescriptor;
    replaced_at: string;
}
export declare function replacePendingDraft(stateInput: GraphState, input: ReplacePendingDraftInput): GraphState;
export interface ApprovePendingGraphRevisionInput {
    revision_id: string;
    revision_hash: string;
    approved_at: string;
    approval_evidence: GraphEvidenceReference;
}
export type InitializeApprovedProjection = (descriptor: SealedGraphDescriptor) => GraphSchedulerProjection;
export declare function approvePendingGraphRevision(stateInput: GraphState, input: ApprovePendingGraphRevisionInput, initializeProjection: InitializeApprovedProjection): GraphState;
export interface ProposeGraphPatchInput {
    proposal_id: string;
    base_revision_id: string;
    base_revision_hash: string;
    proposed_descriptor: SealedGraphDescriptor;
    invalidated_node_ids: string[];
    proposal_evidence: GraphEvidenceReference[];
    proposed_at: string;
}
export declare function proposeGraphPatch(stateInput: GraphState, input: ProposeGraphPatchInput): GraphState;
export interface ApproveGraphPatchInput {
    proposal_id: string;
    base_revision_id: string;
    base_revision_hash: string;
    proposed_revision_hash: string;
    invalidated_node_ids: string[];
    approval_evidence: GraphEvidenceReference;
    approved_at: string;
}
export type RecomputeProjectionForRevision = (projection: GraphSchedulerProjection, descriptor: SealedGraphDescriptor, invalidatedNodeIds: ReadonlySet<string>) => GraphSchedulerProjection;
export declare function approveGraphPatch(stateInput: GraphState, input: ApproveGraphPatchInput, recomputeProjection: RecomputeProjectionForRevision): GraphState;
//# sourceMappingURL=revisions.d.ts.map