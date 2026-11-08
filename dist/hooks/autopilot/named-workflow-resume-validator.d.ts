import type { AutopilotState } from "./types.js";
export declare const WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE = "workflow_transcript_record_too_large";
export declare function takeNamedWorkflowTranscriptFailure(sessionId: string | undefined): string | null;
type RecordValue = Record<string, unknown>;
/** Named persisted state is supported only where its no-follow contract can be enforced. */
export declare function namedWorkflowRuntimeSupported(): boolean;
export type NamedWorkflowValidation = {
    tracking: NonNullable<AutopilotState["pipelineTracking"]>;
    task: string;
};
/** Validate persisted named workflow structure without filesystem or transcript access. */
export declare function validateNamedWorkflowStateStructure(state: AutopilotState, sessionId: string | undefined): NamedWorkflowValidation | null;
/** Validate the complete descriptor and authenticated transcript chain without mutating state. */
export declare function validateNamedWorkflowState(state: AutopilotState, sessionId: string | undefined): NamedWorkflowValidation | null;
export type PreparedNamedWorkflowAdvance = {
    updated: AutopilotState;
    commitToken: {
        transcriptPath: string;
        transcriptIdentity: RecordValue;
        stageId: string;
        sessionId: string;
        boundary: RecordValue;
        evidenceHash: string;
    };
};
/**
 * Reauthenticate a prepared transcript observation immediately before persistence.
 * Callers must invoke this while holding the state mutation lock.
 */
export declare function refreshNamedWorkflowBoundaryForCommit(advance: PreparedNamedWorkflowAdvance): boolean;
/**
 * Prepare an authenticated, one-stage named workflow transition from its
 * append-only transcript. The caller must persist this exact update atomically.
 */
export declare function prepareNamedWorkflowAdvance(state: AutopilotState, sessionId: string | undefined): PreparedNamedWorkflowAdvance | null;
export {};
//# sourceMappingURL=named-workflow-resume-validator.d.ts.map