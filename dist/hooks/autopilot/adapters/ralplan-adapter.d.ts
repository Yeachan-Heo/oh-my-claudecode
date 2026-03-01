/**
 * RALPLAN Stage Adapter
 *
 * Wraps the existing ralplan (consensus planning) and direct planning modules
 * into the pipeline stage adapter interface.
 *
 * This stage handles: spec creation + implementation plan creation.
 * When planning='ralplan', uses consensus-driven planning with Planner/Architect/Critic.
 * When planning='direct', uses the simpler Architect+Critic approach.
 */
import type { PipelineStageAdapter } from '../pipeline-types.js';
export declare const RALPLAN_COMPLETION_SIGNAL = "PIPELINE_RALPLAN_COMPLETE";
export declare const ralplanAdapter: PipelineStageAdapter;
//# sourceMappingURL=ralplan-adapter.d.ts.map