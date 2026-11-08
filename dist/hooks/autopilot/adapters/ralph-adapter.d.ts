/**
 * RALPH Stage Adapter
 *
 * Wraps the existing ralph verification module into the pipeline stage adapter interface.
 *
 * The ralph stage performs iterative verification of the implementation:
 * - Functional completeness review
 * - Security review
 * - Code quality review
 * - Fixes issues found and re-verifies
 */
import type { PipelineStageAdapter } from '../pipeline-types.js';
export declare const RALPH_COMPLETION_SIGNAL = "PIPELINE_RALPH_COMPLETE";
export declare const ralphAdapter: PipelineStageAdapter;
//# sourceMappingURL=ralph-adapter.d.ts.map