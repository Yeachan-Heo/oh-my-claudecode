/**
 * Capability tagging system for worker fitness scoring.
 *
 * Maps worker backends to default capabilities and provides
 * scoring functions for task-worker matching.
 */
import type { WorkerBackend, WorkerCapability } from './types.js';
import type { UnifiedTeamMember } from './unified-team.js';
/**
 * Get default capabilities for a worker backend.
 */
export declare function getDefaultCapabilities(backend: WorkerBackend): WorkerCapability[];
/**
 * Score a worker's fitness for a task based on capabilities.
 * Higher score = better fit.
 *
 * Scoring:
 * - Each matching capability = 1.0 point
 * - 'general' capability = 0.5 points for any requirement (wildcard)
 * - Score normalized to 0-1 range based on total required capabilities
 * - Workers with 0 matching capabilities score 0
 */
export declare function scoreWorkerFitness(worker: UnifiedTeamMember, requiredCapabilities: WorkerCapability[]): number;
/**
 * Find the best available workers for a set of required capabilities.
 * Returns workers sorted by fitness score (descending).
 * Only includes workers with score > 0.
 */
export declare function rankWorkersForTask(workers: UnifiedTeamMember[], requiredCapabilities: WorkerCapability[]): UnifiedTeamMember[];
//# sourceMappingURL=capabilities.d.ts.map