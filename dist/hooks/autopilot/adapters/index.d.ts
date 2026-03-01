/**
 * Pipeline Stage Adapters
 *
 * Barrel export for all stage adapters. Each adapter wraps an existing module
 * (ralplan, team, ralph, ultraqa) into the PipelineStageAdapter interface.
 */
export { ralplanAdapter, RALPLAN_COMPLETION_SIGNAL } from './ralplan-adapter.js';
export { executionAdapter, EXECUTION_COMPLETION_SIGNAL } from './execution-adapter.js';
export { ralphAdapter, RALPH_COMPLETION_SIGNAL } from './ralph-adapter.js';
export { qaAdapter, QA_COMPLETION_SIGNAL } from './qa-adapter.js';
import type { PipelineStageAdapter } from '../pipeline-types.js';
/**
 * All stage adapters in canonical execution order.
 * The pipeline orchestrator iterates through these in sequence,
 * skipping any that are disabled by configuration.
 */
export declare const ALL_ADAPTERS: readonly PipelineStageAdapter[];
/**
 * Look up an adapter by stage ID.
 */
export declare function getAdapterById(id: string): PipelineStageAdapter | undefined;
//# sourceMappingURL=index.d.ts.map