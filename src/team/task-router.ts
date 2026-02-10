// src/team/task-router.ts

/**
 * Smart task routing based on worker capabilities and availability.
 *
 * Assigns unassigned tasks to the best available workers by combining:
 * - Capability fitness scoring
 * - Worker availability (not dead, not quarantined)
 * - Current load (prefer idle workers)
 */

import type { TaskFile, WorkerCapability, WorkerBackend } from './types.js';
import type { UnifiedTeamMember } from './unified-team.js';
import { getTeamMembers } from './unified-team.js';
import { scoreWorkerFitness } from './capabilities.js';

export interface TaskRoutingDecision {
  taskId: string;
  assignedTo: string;
  backend: WorkerBackend;
  reason: string;
  confidence: number; // 0-1
}

/**
 * Automatically assign tasks to the best available workers.
 * Uses capability scoring + worker availability + current load.
 *
 * @param teamName - Team identifier
 * @param workingDirectory - Working directory for team data
 * @param unassignedTasks - Tasks without an owner
 * @param requiredCapabilities - Optional map of taskId -> required capabilities
 * @returns Array of routing decisions
 */
export function routeTasks(
  teamName: string,
  workingDirectory: string,
  unassignedTasks: TaskFile[],
  requiredCapabilities?: Record<string, WorkerCapability[]>
): TaskRoutingDecision[] {
  if (unassignedTasks.length === 0) return [];

  const allMembers = getTeamMembers(teamName, workingDirectory);

  // Filter to available workers (not dead, not quarantined)
  const available = allMembers.filter(
    m => m.status !== 'dead' && m.status !== 'quarantined'
  );

  if (available.length === 0) return [];

  const decisions: TaskRoutingDecision[] = [];
  // Track assignments to balance load
  const assignmentCounts = new Map<string, number>();
  for (const m of available) {
    // Count existing in-progress tasks
    assignmentCounts.set(m.name, m.currentTaskId ? 1 : 0);
  }

  for (const task of unassignedTasks) {
    const caps = requiredCapabilities?.[task.id] || ['general'];

    // Score each available worker
    const scored = available
      .map(worker => {
        const fitnessScore = scoreWorkerFitness(worker, caps);
        const currentLoad = assignmentCounts.get(worker.name) || 0;
        // Penalize busy workers: each assigned task reduces score by 0.2
        const loadPenalty = currentLoad * 0.2;
        // Prefer idle workers
        const idleBonus = worker.status === 'idle' ? 0.1 : 0;
        // Ensure final score stays in 0-1 range
        const finalScore = Math.min(1, Math.max(0, fitnessScore - loadPenalty + idleBonus));

        return { worker, score: finalScore, fitnessScore };
      })
      .filter(s => s.fitnessScore > 0) // Must have at least some capability match
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      decisions.push({
        taskId: task.id,
        assignedTo: best.worker.name,
        backend: best.worker.backend,
        reason: `Best fitness score (${best.fitnessScore.toFixed(2)}) for capabilities [${caps.join(', ')}]`,
        confidence: best.score,
      });

      // Track the assignment
      assignmentCounts.set(
        best.worker.name,
        (assignmentCounts.get(best.worker.name) || 0) + 1
      );
    }
  }

  return decisions;
}
