/**
 * Persistent Mode Hook
 *
 * Unified handler for persistent work modes: ultrawork, ralph, and todo-continuation.
 * This hook intercepts Stop events and enforces work continuation based on:
 * 1. Active ultrawork mode with pending todos
 * 2. Active ralph loop (until cancelled via /oh-my-claudecode:cancel)
 * 3. Any pending todos (general enforcement)
 *
 * Priority order: Ralph > Ultrawork > Todo Continuation
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readUltraworkState,
  incrementReinforcement,
  deactivateUltrawork,
  getUltraworkPersistenceMessage
} from '../ultrawork/index.js';
import {
  readRalphState,
  incrementRalphIteration,
  clearRalphState,
  getPrdCompletionStatus,
  getRalphContext,
  readVerificationState,
  recordArchitectFeedback,
  getArchitectVerificationPrompt,
  getArchitectRejectionContinuationPrompt,
  detectArchitectApproval,
  detectArchitectRejection,
  clearVerificationState
} from '../ralph/index.js';
import { checkIncompleteTodos, getNextPendingTodo, StopContext, isUserAbort, isContextLimitStop } from '../todo-continuation/index.js';
import { TODO_CONTINUATION_PROMPT } from '../../installer/hooks.js';
import {
  isAutopilotActive
} from '../autopilot/index.js';
import { checkAutopilot } from '../autopilot/enforcement.js';

export interface PersistentModeResult {
  /** Whether to block the stop event */
  shouldBlock: boolean;
  /** Message to inject into context */
  message: string;
  /** Which mode triggered the block */
  mode: 'ralph' | 'ultrawork' | 'todo-continuation' | 'autopilot' | 'none';
  /** Additional metadata */
  metadata?: {
    todoCount?: number;
    iteration?: number;
    maxIterations?: number;
    reinforcementCount?: number;
    todoContinuationAttempts?: number;
    phase?: string;
    tasksCompleted?: number;
    tasksTotal?: number;
  };
}

/** Maximum todo-continuation attempts before giving up (prevents infinite loops) */
const MAX_TODO_CONTINUATION_ATTEMPTS = 5;

/** Track todo-continuation attempts per session to prevent infinite loops */
const todoContinuationAttempts = new Map<string, number>();

/**
 * Get or increment todo-continuation attempt counter
 */
function trackTodoContinuationAttempt(sessionId: string): number {
  const current = todoContinuationAttempts.get(sessionId) || 0;
  const next = current + 1;
  todoContinuationAttempts.set(sessionId, next);
  return next;
}

/**
 * Reset todo-continuation attempt counter (call when todos actually change)
 */
export function resetTodoContinuationAttempts(sessionId: string): void {
  todoContinuationAttempts.delete(sessionId);
}

/**
 * Check for architect approval in session transcript
 */
function checkArchitectApprovalInTranscript(sessionId: string): boolean {
  const claudeDir = join(homedir(), '.claude');
  const possiblePaths = [
    join(claudeDir, 'sessions', sessionId, 'transcript.md'),
    join(claudeDir, 'sessions', sessionId, 'messages.json'),
    join(claudeDir, 'transcripts', `${sessionId}.md`)
  ];

  for (const transcriptPath of possiblePaths) {
    if (existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        if (detectArchitectApproval(content)) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Check for architect rejection in session transcript
 */
function checkArchitectRejectionInTranscript(sessionId: string): { rejected: boolean; feedback: string } {
  const claudeDir = join(homedir(), '.claude');
  const possiblePaths = [
    join(claudeDir, 'sessions', sessionId, 'transcript.md'),
    join(claudeDir, 'sessions', sessionId, 'messages.json'),
    join(claudeDir, 'transcripts', `${sessionId}.md`)
  ];

  for (const transcriptPath of possiblePaths) {
    if (existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        const result = detectArchitectRejection(content);
        if (result.rejected) {
          return result;
        }
      } catch {
        continue;
      }
    }
  }
  return { rejected: false, feedback: '' };
}

/**
 * Check Ralph Loop state and determine if it should continue
 * Now includes Architect verification for completion claims
 */
async function checkRalphLoop(
  sessionId?: string,
  directory?: string
): Promise<PersistentModeResult | null> {
  const workingDir = directory || process.cwd();
  const state = readRalphState(workingDir);

  if (!state || !state.active) {
    return null;
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return null;
  }

  // Check for PRD-based completion (all stories have passes: true)
  const prdStatus = getPrdCompletionStatus(workingDir);
  if (prdStatus.hasPrd && prdStatus.allComplete) {
    // All PRD stories complete - allow completion
    clearRalphState(workingDir);
    clearVerificationState(workingDir);
    deactivateUltrawork(workingDir);
    return {
      shouldBlock: false,
      message: `[RALPH LOOP COMPLETE - PRD] All ${prdStatus.status?.total || 0} stories are complete! Great work!`,
      mode: 'none'
    };
  }

  // Check for existing verification state (architect verification in progress)
  const verificationState = readVerificationState(workingDir);

  if (verificationState?.pending) {
    // Verification is in progress - check for architect's response
    if (sessionId) {
      // Check for architect approval
      if (checkArchitectApprovalInTranscript(sessionId)) {
        // Architect approved - truly complete
        // Also deactivate ultrawork if it was active alongside ralph
        clearVerificationState(workingDir);
        clearRalphState(workingDir);
        deactivateUltrawork(workingDir);
        return {
          shouldBlock: false,
          message: `[RALPH LOOP VERIFIED COMPLETE] Architect verified task completion after ${state.iteration} iteration(s). Excellent work!`,
          mode: 'none'
        };
      }

      // Check for architect rejection
      const rejection = checkArchitectRejectionInTranscript(sessionId);
      if (rejection.rejected) {
        // Architect rejected - continue with feedback
        recordArchitectFeedback(workingDir, false, rejection.feedback);
        const updatedVerification = readVerificationState(workingDir);

        if (updatedVerification) {
          const continuationPrompt = getArchitectRejectionContinuationPrompt(updatedVerification);
          return {
            shouldBlock: true,
            message: continuationPrompt,
            mode: 'ralph',
            metadata: {
              iteration: state.iteration,
              maxIterations: state.max_iterations
            }
          };
        }
      }
    }

    // Verification still pending - remind to spawn architect
    const verificationPrompt = getArchitectVerificationPrompt(verificationState);
    return {
      shouldBlock: true,
      message: verificationPrompt,
      mode: 'ralph',
      metadata: {
        iteration: state.iteration,
        maxIterations: state.max_iterations
      }
    };
  }

  // Check max iterations
  if (state.iteration >= state.max_iterations) {
    // Also deactivate ultrawork if it was active alongside ralph
    clearRalphState(workingDir);
    clearVerificationState(workingDir);
    deactivateUltrawork(workingDir);
    return {
      shouldBlock: false,
      message: `[RALPH LOOP STOPPED] Max iterations (${state.max_iterations}) reached without completion. Consider reviewing the task requirements.`,
      mode: 'none'
    };
  }

  // Increment and continue
  const newState = incrementRalphIteration(workingDir);
  if (!newState) {
    return null;
  }

  // Get PRD context for injection
  const ralphContext = getRalphContext(workingDir);
  const prdInstruction = prdStatus.hasPrd
    ? `2. Check prd.json - are ALL stories marked passes: true?`
    : `2. Check your todo list - are ALL items marked complete?`;

  const continuationPrompt = `<ralph-continuation>

[RALPH - ITERATION ${newState.iteration}/${newState.max_iterations}]

The task is NOT complete yet. Continue working.
${ralphContext}
CRITICAL INSTRUCTIONS:
1. Review your progress and the original task
${prdInstruction}
3. Continue from where you left off
4. When FULLY complete (after Architect verification), run \`/oh-my-claudecode:cancel\` to cleanly exit and clean up state files. If cancel fails, retry with \`/oh-my-claudecode:cancel --force\`.
5. Do NOT stop until the task is truly done

${newState.prompt ? `Original task: ${newState.prompt}` : ''}

</ralph-continuation>

---

`;

  return {
    shouldBlock: true,
    message: continuationPrompt,
    mode: 'ralph',
    metadata: {
      iteration: newState.iteration,
      maxIterations: newState.max_iterations
    }
  };
}

/**
 * Check Ultrawork state and determine if it should reinforce
 */
async function checkUltrawork(
  sessionId?: string,
  directory?: string,
  hasIncompleteTodos?: boolean
): Promise<PersistentModeResult | null> {
  const state = readUltraworkState(directory);

  if (!state || !state.active) {
    return null;
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return null;
  }

  // Reinforce ultrawork mode - ALWAYS continue while active.
  // This prevents false stops from bash errors, transient failures, etc.
  const newState = incrementReinforcement(directory);
  if (!newState) {
    return null;
  }

  const message = getUltraworkPersistenceMessage(newState);

  return {
    shouldBlock: true,
    message,
    mode: 'ultrawork',
    metadata: {
      reinforcementCount: newState.reinforcement_count
    }
  };
}

/**
 * Check for incomplete todos (baseline enforcement)
 * Includes max-attempts counter to prevent infinite loops when agent is stuck
 */
async function checkTodoContinuation(
  sessionId?: string,
  directory?: string
): Promise<PersistentModeResult | null> {
  const result = await checkIncompleteTodos(sessionId, directory);

  if (result.count === 0) {
    // Reset counter when todos are cleared
    if (sessionId) {
      resetTodoContinuationAttempts(sessionId);
    }
    return null;
  }

  // Track continuation attempts to prevent infinite loops
  const attemptCount = sessionId ? trackTodoContinuationAttempt(sessionId) : 1;

  // Use dynamic label based on source (Tasks vs todos)
  const sourceLabel = result.source === 'task' ? 'Tasks' : 'todos';
  const sourceLabelLower = result.source === 'task' ? 'tasks' : 'todos';

  if (attemptCount > MAX_TODO_CONTINUATION_ATTEMPTS) {
    // Too many attempts - agent appears stuck, allow stop but warn
    return {
      shouldBlock: false,
      message: `[TODO CONTINUATION LIMIT] Attempted ${MAX_TODO_CONTINUATION_ATTEMPTS} continuations without progress. ${result.count} ${sourceLabelLower} remain incomplete. Consider reviewing the stuck ${sourceLabelLower} or asking the user for guidance.`,
      mode: 'none',
      metadata: {
        todoCount: result.count,
        todoContinuationAttempts: attemptCount
      }
    };
  }

  const nextTodo = getNextPendingTodo(result);
  const nextTaskInfo = nextTodo
    ? `\n\nNext ${result.source === 'task' ? 'Task' : 'todo'}: "${nextTodo.content}" (${nextTodo.status})`
    : '';

  const attemptInfo = attemptCount > 1
    ? `\n[Continuation attempt ${attemptCount}/${MAX_TODO_CONTINUATION_ATTEMPTS}]`
    : '';

  const message = `<todo-continuation>

${TODO_CONTINUATION_PROMPT}

[Status: ${result.count} of ${result.total} ${sourceLabelLower} remaining]${nextTaskInfo}${attemptInfo}

</todo-continuation>

---

`;

  return {
    shouldBlock: true,
    message,
    mode: 'todo-continuation',
    metadata: {
      todoCount: result.count,
      todoContinuationAttempts: attemptCount
    }
  };
}

/**
 * Main persistent mode checker
 * Checks all persistent modes in priority order and returns appropriate action
 */
export async function checkPersistentModes(
  sessionId?: string,
  directory?: string,
  stopContext?: StopContext  // NEW: from todo-continuation types
): Promise<PersistentModeResult> {
  const workingDir = directory || process.cwd();

  // CRITICAL: Never block context-limit stops.
  // Blocking these causes a deadlock where Claude Code cannot compact.
  // See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
  if (isContextLimitStop(stopContext)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  // Check for user abort - skip all continuation enforcement
  if (isUserAbort(stopContext)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  // First, check for incomplete todos (we need this info for ultrawork)
  // Note: stopContext already checked above, but pass it for consistency
  const todoResult = await checkIncompleteTodos(sessionId, workingDir, stopContext);
  const hasIncompleteTodos = todoResult.count > 0;

  // Priority 1: Ralph (explicit loop mode)
  const ralphResult = await checkRalphLoop(sessionId, workingDir);
  if (ralphResult?.shouldBlock) {
    return ralphResult;
  }

  // Priority 1.5: Autopilot (full orchestration mode - higher than ultrawork, lower than ralph)
  if (isAutopilotActive(workingDir)) {
    const autopilotResult = await checkAutopilot(sessionId, workingDir);
    if (autopilotResult?.shouldBlock) {
      return {
        shouldBlock: true,
        message: autopilotResult.message,
        mode: 'autopilot',
        metadata: {
          iteration: autopilotResult.metadata?.iteration,
          maxIterations: autopilotResult.metadata?.maxIterations,
          phase: autopilotResult.phase,
          tasksCompleted: autopilotResult.metadata?.tasksCompleted,
          tasksTotal: autopilotResult.metadata?.tasksTotal
        }
      };
    }
  }

  // Priority 2: Ultrawork Mode (performance mode with persistence)
  const ultraworkResult = await checkUltrawork(sessionId, workingDir, hasIncompleteTodos);
  if (ultraworkResult?.shouldBlock) {
    return ultraworkResult;
  }

  // NOTE: Priority 3 (Todo Continuation) removed to prevent false positives.
  // Only explicit modes (ralph, autopilot, ultrawork, etc.) trigger continuation enforcement.

  // No blocking needed
  return {
    shouldBlock: false,
    message: '',
    mode: 'none'
  };
}

/**
 * Create hook output for Claude Code
 * NOTE: Always returns continue: true with soft enforcement via message injection.
 * Never returns continue: false to avoid blocking user intent.
 */
export function createHookOutput(result: PersistentModeResult): {
  continue: boolean;
  message?: string;
} {
  // Always allow stop, but inject message for soft enforcement
  return {
    continue: true,
    message: result.message || undefined
  };
}
