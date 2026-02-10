// src/team/capabilities.ts

/**
 * Capability tagging system for worker fitness scoring.
 *
 * Maps worker backends to default capabilities and provides
 * scoring functions for task-worker matching.
 */

import type { WorkerBackend, WorkerCapability } from './types.js';
import type { UnifiedTeamMember } from './unified-team.js';

/** Default capabilities by worker backend */
const DEFAULT_CAPABILITIES: Record<WorkerBackend, WorkerCapability[]> = {
  'claude-native': ['code-edit', 'testing', 'general'],
  'mcp-codex': ['code-review', 'security-review', 'architecture', 'refactoring'],
  'mcp-gemini': ['ui-design', 'documentation', 'research', 'code-edit'],
};

/**
 * Get default capabilities for a worker backend.
 */
export function getDefaultCapabilities(backend: WorkerBackend): WorkerCapability[] {
  return [...(DEFAULT_CAPABILITIES[backend] || ['general'])];
}

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
export function scoreWorkerFitness(
  worker: UnifiedTeamMember,
  requiredCapabilities: WorkerCapability[]
): number {
  if (requiredCapabilities.length === 0) return 1.0; // No requirements = everyone fits

  let score = 0;
  const workerCaps = new Set(worker.capabilities);

  for (const req of requiredCapabilities) {
    if (workerCaps.has(req)) {
      score += 1.0;
    } else if (workerCaps.has('general')) {
      score += 0.5;
    }
  }

  return score / requiredCapabilities.length;
}

/**
 * Find the best available workers for a set of required capabilities.
 * Returns workers sorted by fitness score (descending).
 * Only includes workers with score > 0.
 */
export function rankWorkersForTask(
  workers: UnifiedTeamMember[],
  requiredCapabilities: WorkerCapability[]
): UnifiedTeamMember[] {
  const scored = workers
    .map(w => ({ worker: w, score: scoreWorkerFitness(w, requiredCapabilities) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.worker);
}
