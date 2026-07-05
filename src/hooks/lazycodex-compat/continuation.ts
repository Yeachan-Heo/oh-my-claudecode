import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { z } from 'zod';
import type { LazyCodexCompatDecision } from './types.js';

export interface ContinuationCheck {
  readonly decision: LazyCodexCompatDecision;
  readonly message?: string;
}

const BoulderWorkSchema = z.object({
  active_plan: z.string(),
  plan_name: z.string().optional(),
  session_ids: z.array(z.string()).optional(),
  status: z.string().optional(),
}).passthrough();

const BoulderSchema = z.object({
  active_work_id: z.string(),
  works: z.record(BoulderWorkSchema),
}).passthrough();

function countUncheckedTodos(planText: string): number {
  return planText
    .split('\n')
    .filter((line) => /^- \[ \]\s+/.test(line.trim()))
    .length;
}

function needsEvidence(reason: string): ContinuationCheck {
  return {
    decision: {
      behavior: 'start-work-continuation',
      decision: 'needs-evidence',
      reason,
    },
    message: `LazyCodex start-work continuation needs evidence: ${reason}. Inspect .lazycodex/boulder.json and active plan state before stopping.`,
  };
}

function idle(reason: string): ContinuationCheck {
  return {
    decision: {
      behavior: 'start-work-continuation',
      decision: 'idle',
      remainingCount: 0,
      reason,
    },
  };
}

function readBoulderState(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { malformed: 'invalid-json' };
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { malformed: 'missing-boulder' };
    }
    throw error;
  }
}

function readPlanText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function normalizeCurrentSessionId(sessionId: string): string {
  return `codex:${sessionId}`;
}

function normalizeTrackedSessionId(sessionId: string): string {
  return sessionId.includes(':') ? sessionId : `opencode:${sessionId}`;
}

function isCurrentSessionWork(sessionIds: readonly string[] | undefined, sessionId: string): boolean {
  const normalizedSessionId = normalizeCurrentSessionId(sessionId);
  return (sessionIds ?? [])
    .map((trackedSessionId) => normalizeTrackedSessionId(trackedSessionId))
    .includes(normalizedSessionId);
}

function resolvePlanPath(cwd: string, activePlan: string): string {
  return isAbsolute(activePlan) ? activePlan : resolve(cwd, activePlan);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function checkStartWorkContinuation(cwd: string, sessionId: string): ContinuationCheck {
  const boulderPath = join(cwd, '.lazycodex', 'boulder.json');
  if (!existsSync(boulderPath)) {
    return {
      decision: idle('no Boulder state for current project').decision,
    };
  }

  const parsed = BoulderSchema.safeParse(readBoulderState(boulderPath));
  if (!parsed.success) {
    return needsEvidence('malformed .lazycodex/boulder.json');
  }

  const activeWork = parsed.data.works[parsed.data.active_work_id];
  if (!activeWork || activeWork.status === 'completed') {
    return idle('no active Boulder work for current session');
  }

  if (!isCurrentSessionWork(activeWork.session_ids, sessionId)) {
    return idle(`active Boulder work is not owned by ${normalizeCurrentSessionId(sessionId)}`);
  }

  const planPath = resolvePlanPath(cwd, activeWork.active_plan);
  const planText = readPlanText(planPath);
  if (planText === null) {
    return needsEvidence(`missing active plan: ${activeWork.active_plan}`);
  }

  const remainingCount = countUncheckedTodos(planText);
  if (remainingCount === 0) {
    return {
      decision: {
        behavior: 'start-work-continuation',
        decision: 'complete',
        remainingCount,
      },
    };
  }

  const planName = activeWork.plan_name ?? parsed.data.active_work_id;
  return {
    decision: {
      behavior: 'start-work-continuation',
      decision: 'continue',
      remainingCount,
    },
    message: `LazyCodex start-work continuation: ${planName} has ${remainingCount} unfinished top-level todo(s). Continue the plan before stopping.`,
  };
}
