/**
 * QA Stage Adapter
 *
 * Wraps the existing UltraQA module into the pipeline stage adapter interface.
 *
 * The QA stage runs build/lint/test cycling until all checks pass
 * or the maximum number of cycles is reached.
 */
import type { PipelineStageAdapter } from '../pipeline-types.js';
export declare const QA_COMPLETION_SIGNAL = "PIPELINE_QA_COMPLETE";
export declare const qaAdapter: PipelineStageAdapter;
//# sourceMappingURL=qa-adapter.d.ts.map