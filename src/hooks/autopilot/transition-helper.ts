/**
 * Transactional Transition Helper
 *
 * Executes a series of steps atomically: if any step fails,
 * all previously completed steps are rolled back in reverse order.
 */

export interface TransitionStep {
  name: string;
  execute: () => Promise<void>;
  rollback: () => Promise<void>;
}

export interface TransitionResult {
  success: boolean;
  failedStep?: string;
  error?: string;
}

/**
 * Execute a sequence of transition steps transactionally.
 * If any step fails, all previously completed steps are rolled back in reverse order.
 */
export async function executeTransition(steps: TransitionStep[]): Promise<TransitionResult> {
  const completed: TransitionStep[] = [];
  for (const step of steps) {
    try {
      await step.execute();
      completed.push(step);
    } catch (error) {
      // Rollback in reverse order
      for (const done of completed.reverse()) {
        try { await done.rollback(); } catch { /* best-effort rollback */ }
      }
      return { success: false, failedStep: step.name, error: String(error) };
    }
  }
  return { success: true };
}
