/**
 * EXECUTION Stage Adapter
 *
 * Wraps team-based and solo execution into the pipeline stage adapter interface.
 *
 * When execution='team', delegates to the /team orchestrator for multi-worker execution.
 * When execution='solo', uses direct executor agents in the current session.
 */
import type { PipelineStageAdapter } from '../pipeline-types.js';
export declare const EXECUTION_COMPLETION_SIGNAL = "PIPELINE_EXECUTION_COMPLETE";
export declare const executionAdapter: PipelineStageAdapter;
//# sourceMappingURL=execution-adapter.d.ts.map