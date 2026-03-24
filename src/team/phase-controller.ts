// src/team/phase-controller.ts

export type TeamPhase =
  | 'initializing'
  | 'planning'
  | 'executing'
  | 'fixing'
  | 'completed'
  | 'failed';

export interface PhaseableTask {
  status: string;
  metadata?: {
    permanentlyFailed?: boolean;
    retryCount?: number;
    maxRetries?: number;
  };
}

/**
 * Infer current team phase from task status distribution.
 *
 * Rules (evaluated in order):
 * 1. Empty task list → 'initializing'
 * 2. Any in_progress → 'executing'
 * 3. All pending, no completed, no failed → 'planning'
 * 4. Mixed completed + pending (no in_progress) → 'executing' (some done, others queued)
 * 5. Tasks with metadata.permanentlyFailed === true are counted as FAILED (not completed)
 * 6. Any failed (including permanentlyFailed) AND retries remaining → 'fixing'
 * 7. All tasks failed (including permanentlyFailed) AND retries exhausted → 'failed'
 * 8. All completed AND zero permanentlyFailed → 'completed'
 * 9. Fallback → 'executing'
 */
export function inferPhase(tasks: PhaseableTask[]): TeamPhase {
  if (tasks.length === 0) return 'initializing';

  // Categorize tasks
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending');
  // CRITICAL: permanentlyFailed tasks have status='completed' but are actually failed
  const permanentlyFailed = tasks.filter(
    t => t.status === 'completed' && t.metadata?.permanentlyFailed === true
  );
  const genuinelyCompleted = tasks.filter(
    t => t.status === 'completed' && !t.metadata?.permanentlyFailed
  );
  const explicitlyFailed = tasks.filter(t => t.status === 'failed');
  const allFailed = [...permanentlyFailed, ...explicitlyFailed];

  // Rule 2: Any in_progress → executing
  if (inProgress.length > 0) return 'executing';

  // Rule 3: All pending, nothing else → planning
  if (
    pending.length === tasks.length &&
    genuinelyCompleted.length === 0 &&
    allFailed.length === 0
  ) {
    return 'planning';
  }

  // Rule 4: Mixed completed + pending (no in_progress, no failures) → executing
  if (pending.length > 0 && genuinelyCompleted.length > 0 && inProgress.length === 0 && allFailed.length === 0) {
    return 'executing';
  }

  // Rules 6 & 7: Handle failures
  if (allFailed.length > 0) {
    // Check if any failed task has retries remaining
    const hasRetriesRemaining = allFailed.some(t => {
      const retryCount = t.metadata?.retryCount ?? 0;
      const maxRetries = t.metadata?.maxRetries ?? 3;
      return retryCount < maxRetries;
    });

    // Rule 7: All tasks are failed and no retries remain
    if (
      (allFailed.length === tasks.length && !hasRetriesRemaining) ||
      (pending.length === 0 && inProgress.length === 0 && genuinelyCompleted.length === 0 && !hasRetriesRemaining)
    ) {
      return 'failed';
    }

    // Rule 6: Some failed but retries available
    if (hasRetriesRemaining) return 'fixing';
  }

  // Rule 8: All genuinely completed, no failures
  if (
    genuinelyCompleted.length === tasks.length &&
    allFailed.length === 0
  ) {
    return 'completed';
  }

  // Rule 9: Fallback
  return 'executing';
}

/**
 * Get a human-readable log message for a phase transition.
 */
export function getPhaseTransitionLog(prev: TeamPhase, next: TeamPhase): string {
  if (prev === next) return `Phase unchanged: ${next}`;
  return `Phase transition: ${prev} → ${next}`;
}

/**
 * Check if a phase is terminal (no further transitions expected).
 */
export function isTerminalPhase(phase: TeamPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}
