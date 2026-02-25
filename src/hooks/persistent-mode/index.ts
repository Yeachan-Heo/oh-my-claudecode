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

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { getClaudeConfigDir } from '../../utils/paths.js';
import {
  readUltraworkState,
  writeUltraworkState,
  incrementReinforcement,
  deactivateUltrawork,
  getUltraworkPersistenceMessage,
  type UltraworkState
} from '../ultrawork/index.js';
import { resolveToWorktreeRoot, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import {
  readRalphState,
  writeRalphState,
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
import { checkIncompleteTodos, getNextPendingTodo, StopContext, isUserAbort, isContextLimitStop, isRateLimitStop, isExplicitCancelCommand } from '../todo-continuation/index.js';
import { TODO_CONTINUATION_PROMPT } from '../../installer/hooks.js';
import {
  isAutopilotActive
} from '../autopilot/index.js';
import { checkAutopilot } from '../autopilot/enforcement.js';
import { readTeamPipelineState } from '../team-pipeline/state.js';
import type { TeamPipelinePhase } from '../team-pipeline/types.js';

export interface ToolErrorState {
  tool_name: string;
  tool_input_preview?: string;
  error: string;
  timestamp: string;
  retry_count: number;
}

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
    toolError?: ToolErrorState;
  };
}

/** Maximum todo-continuation attempts before giving up (prevents infinite loops) */
const MAX_TODO_CONTINUATION_ATTEMPTS = 5;
const CANCEL_SIGNAL_TTL_MS = 30_000;

/** Track todo-continuation attempts per session to prevent infinite loops */
const todoContinuationAttempts = new Map<string, number>();

/**
 * Check whether this session is in an explicit cancel window.
 * Used to prevent stop-hook re-enforcement races during /cancel.
 */
function isSessionCancelInProgress(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false;

  let cancelSignalPath: string;
  try {
    cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, directory);
  } catch {
    return false;
  }

  if (!existsSync(cancelSignalPath)) {
    return false;
  }

  try {
    const raw = JSON.parse(readFileSync(cancelSignalPath, 'utf-8')) as {
      requested_at?: string;
      expires_at?: string;
    };

    const now = Date.now();
    const expiresAt = raw.expires_at ? new Date(raw.expires_at).getTime() : NaN;
    const requestedAt = raw.requested_at ? new Date(raw.requested_at).getTime() : NaN;
    const fallbackExpiry = Number.isFinite(requestedAt) ? requestedAt + CANCEL_SIGNAL_TTL_MS : NaN;
    const effectiveExpiry = Number.isFinite(expiresAt) ? expiresAt : fallbackExpiry;

    if (!Number.isFinite(effectiveExpiry) || effectiveExpiry <= now) {
      unlinkSync(cancelSignalPath);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Read last tool error from state directory.
 * Returns null if file doesn't exist or error is stale (>60 seconds old).
 */
export function readLastToolError(directory: string): ToolErrorState | null {
  const stateDir = join(directory, '.omc', 'state');
  const errorPath = join(stateDir, 'last-tool-error.json');

  try {
    if (!existsSync(errorPath)) {
      return null;
    }

    const content = readFileSync(errorPath, 'utf-8');
    const toolError = JSON.parse(content) as ToolErrorState;

    if (!toolError || !toolError.timestamp) {
      return null;
    }

    // Check staleness - errors older than 60 seconds are ignored
    const parsedTime = new Date(toolError.timestamp).getTime();
    if (!Number.isFinite(parsedTime)) {
      return null;
    }
    const age = Date.now() - parsedTime;
    if (age > 60000) {
      return null;
    }

    return toolError;
  } catch {
    return null;
  }
}

/**
 * Clear tool error state file atomically.
 */
export function clearToolErrorState(directory: string): void {
  const stateDir = join(directory, '.omc', 'state');
  const errorPath = join(stateDir, 'last-tool-error.json');

  try {
    if (existsSync(errorPath)) {
      unlinkSync(errorPath);
    }
  } catch {
    // Ignore errors - file may have been removed already
  }
}

/**
 * Generate retry guidance message for tool errors.
 * After 5+ retries, suggests alternative approaches.
 */
export function getToolErrorRetryGuidance(toolError: ToolErrorState | null): string {
  if (!toolError) {
    return '';
  }

  const retryCount = toolError.retry_count || 1;
  const toolName = toolError.tool_name || 'unknown';
  const error = toolError.error || 'Unknown error';

  if (retryCount >= 5) {
    return `[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]
The "${toolName}" operation has failed ${retryCount} times.

STOP RETRYING THE SAME APPROACH. Instead:
1. Try a completely different command or approach
2. Check if the environment/dependencies are correct
3. Consider breaking down the task differently
4. If stuck, ask the user for guidance

`;
  }

  return `[TOOL ERROR - RETRY REQUIRED]
The previous "${toolName}" operation failed.

Error: ${error}

REQUIRED ACTIONS:
1. Analyze why the command failed
2. Fix the issue (wrong path? permission? syntax? missing dependency?)
3. RETRY the operation with corrected parameters
4. Continue with your original task after success

Do NOT skip this step. Do NOT move on without fixing the error.

`;
}

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
 * Read the session-idle notification cooldown in seconds from ~/.omc/config.json.
 * Default: 60 seconds. 0 = disabled (no cooldown).
 */
export function getIdleNotificationCooldownSeconds(): number {
  const configPath = join(homedir(), '.omc', 'config.json');
  try {
    if (!existsSync(configPath)) return 60;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const cooldown = (config?.notificationCooldown as Record<string, unknown> | undefined);
    const val = cooldown?.sessionIdleSeconds;
    if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, val);
  } catch {
    // ignore parse errors
  }
  return 60;
}

function getIdleNotificationCooldownPath(stateDir: string, sessionId?: string): string {
  // Keep session segments filesystem-safe; fall back to legacy global path otherwise.
  if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    return join(stateDir, 'sessions', sessionId, 'idle-notif-cooldown.json');
  }
  return join(stateDir, 'idle-notif-cooldown.json');
}

/**
 * Check whether the session-idle notification cooldown has elapsed.
 * Returns true if the notification should be sent.
 */
export function shouldSendIdleNotification(stateDir: string, sessionId?: string): boolean {
  const cooldownSecs = getIdleNotificationCooldownSeconds();
  if (cooldownSecs === 0) return true; // cooldown disabled

  const cooldownPath = getIdleNotificationCooldownPath(stateDir, sessionId);
  try {
    if (!existsSync(cooldownPath)) return true;
    const data = JSON.parse(readFileSync(cooldownPath, 'utf-8')) as Record<string, unknown>;
    if (data?.lastSentAt && typeof data.lastSentAt === 'string') {
      const elapsed = (Date.now() - new Date(data.lastSentAt).getTime()) / 1000;
      if (Number.isFinite(elapsed) && elapsed < cooldownSecs) return false;
    }
  } catch {
    // ignore — treat as no cooldown file
  }
  return true;
}

/**
 * Record that the session-idle notification was sent at the current timestamp.
 */
export function recordIdleNotificationSent(stateDir: string, sessionId?: string): void {
  const cooldownPath = getIdleNotificationCooldownPath(stateDir, sessionId);
  try {
    const dir = dirname(cooldownPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: new Date().toISOString() }, null, 2));
  } catch {
    // ignore write errors
  }
}

/**
 * Check for architect approval in session transcript
 */
function checkArchitectApprovalInTranscript(sessionId: string): boolean {
  const claudeDir = getClaudeConfigDir();
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
  const claudeDir = getClaudeConfigDir();
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
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readRalphState(workingDir, sessionId);

  if (!state || !state.active) {
    return null;
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return null;
  }

  // Explicit cancellation window: never re-arm Ralph internals while cancel is in progress.
  if (isSessionCancelInProgress(workingDir, sessionId)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  // Self-heal linked ultrawork: if ralph is active and marked linked but ultrawork
  // state is missing, recreate it so stop reinforcement cannot silently disappear.
  if (state.linked_ultrawork) {
    const ultraworkState = readUltraworkState(workingDir, sessionId);
    if (!ultraworkState?.active) {
      const now = new Date().toISOString();
      const restoredState: UltraworkState = {
        active: true,
        started_at: state.started_at || now,
        original_prompt: state.prompt || 'Ralph loop task',
        session_id: sessionId,
        project_path: workingDir,
        reinforcement_count: 0,
        last_checked_at: now,
        linked_to_ralph: true
      };
      writeUltraworkState(restoredState, workingDir, sessionId);
    }
  }

  // Check team pipeline state coordination
  // When team mode is active alongside ralph, respect team phase transitions
  const teamState = readTeamPipelineState(workingDir, sessionId);
  if (teamState && teamState.active !== undefined) {
    const teamPhase: TeamPipelinePhase = teamState.phase;

    // If team pipeline reached a terminal state, ralph should also complete
    if (teamPhase === 'complete') {
      clearRalphState(workingDir, sessionId);
      clearVerificationState(workingDir, sessionId);
      deactivateUltrawork(workingDir, sessionId);
      return {
        shouldBlock: false,
        message: `[RALPH LOOP COMPLETE - TEAM] Team pipeline completed successfully. Ralph loop ending after ${state.iteration} iteration(s).`,
        mode: 'none'
      };
    }
    if (teamPhase === 'failed') {
      clearRalphState(workingDir, sessionId);
      clearVerificationState(workingDir, sessionId);
      deactivateUltrawork(workingDir, sessionId);
      return {
        shouldBlock: false,
        message: `[RALPH LOOP STOPPED - TEAM FAILED] Team pipeline failed. Ralph loop ending after ${state.iteration} iteration(s).`,
        mode: 'none'
      };
    }
    if (teamPhase === 'cancelled') {
      clearRalphState(workingDir, sessionId);
      clearVerificationState(workingDir, sessionId);
      deactivateUltrawork(workingDir, sessionId);
      return {
        shouldBlock: false,
        message: `[RALPH LOOP CANCELLED - TEAM] Team pipeline was cancelled. Ralph loop ending after ${state.iteration} iteration(s).`,
        mode: 'none'
      };
    }
  }

  // Check for PRD-based completion (all stories have passes: true)
  const prdStatus = getPrdCompletionStatus(workingDir);
  if (prdStatus.hasPrd && prdStatus.allComplete) {
    // All PRD stories complete - allow completion
    clearRalphState(workingDir, sessionId);
    clearVerificationState(workingDir, sessionId);
    deactivateUltrawork(workingDir, sessionId);
    return {
      shouldBlock: false,
      message: `[RALPH LOOP COMPLETE - PRD] All ${prdStatus.status?.total || 0} stories are complete! Great work!`,
      mode: 'none'
    };
  }

  // Check for existing verification state (architect verification in progress)
  const verificationState = readVerificationState(workingDir, sessionId);

  if (verificationState?.pending) {
    // Verification is in progress - check for architect's response
    if (sessionId) {
      // Check for architect approval
      if (checkArchitectApprovalInTranscript(sessionId)) {
        // Architect approved - truly complete
        // Also deactivate ultrawork if it was active alongside ralph
        clearVerificationState(workingDir, sessionId);
        clearRalphState(workingDir, sessionId);
        deactivateUltrawork(workingDir, sessionId);
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
        recordArchitectFeedback(workingDir, false, rejection.feedback, sessionId);
        const updatedVerification = readVerificationState(workingDir, sessionId);

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
  if (isSessionCancelInProgress(workingDir, sessionId)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  if (state.iteration >= state.max_iterations) {
    // Do not silently stop Ralph with unfinished work.
    // Extend the limit and continue enforcement so user-visible cancellation
    // remains the only explicit termination path.
    state.max_iterations += 10;
    writeRalphState(workingDir, state, sessionId);
  }

  // Read tool error before generating message
  const toolError = readLastToolError(workingDir);
  const errorGuidance = getToolErrorRetryGuidance(toolError);

  // Increment and continue
  const newState = incrementRalphIteration(workingDir, sessionId);
  if (!newState) {
    return null;
  }

  // Get PRD context for injection
  const ralphContext = getRalphContext(workingDir);
  const prdInstruction = prdStatus.hasPrd
    ? `2. Check prd.json - are ALL stories marked passes: true?`
    : `2. Check your todo list - are ALL items marked complete?`;

  const continuationPrompt = `<ralph-continuation>
${errorGuidance ? errorGuidance + '\n' : ''}
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
      maxIterations: newState.max_iterations,
      toolError: toolError || undefined
    }
  };
}

/**
 * Check Ultrawork state and determine if it should reinforce
 */
async function checkUltrawork(
  sessionId?: string,
  directory?: string,
  _hasIncompleteTodos?: boolean
): Promise<PersistentModeResult | null> {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readUltraworkState(workingDir, sessionId);

  if (!state || !state.active) {
    return null;
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return null;
  }

  if (isSessionCancelInProgress(workingDir, sessionId)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  // Reinforce ultrawork mode - ALWAYS continue while active.
  // This prevents false stops from bash errors, transient failures, etc.
  const newState = incrementReinforcement(workingDir, sessionId);
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
async function _checkTodoContinuation(
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
  const _sourceLabel = result.source === 'task' ? 'Tasks' : 'todos';
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
  const workingDir = resolveToWorktreeRoot(directory);

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

  // Explicit /cancel paths must always bypass continuation re-enforcement.
  // This prevents cancel races where stop-hook persistence can re-arm Ralph/Ultrawork
  // (self-heal, max-iteration extension, reinforcement) during shutdown.
  if (isExplicitCancelCommand(stopContext)) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'none'
    };
  }

  // Session-scoped cancel signal from state_clear during /cancel flow.
  // Ensures stop-hook does not re-arm Ralph/Ultrawork while cancellation is in progress.
  if (isSessionCancelInProgress(workingDir, sessionId)) {
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

  // CRITICAL: Never block rate-limit stops.
  // When the API returns 429 / quota-exhausted, Claude Code stops the session.
  // Blocking these stops creates an infinite retry loop: the hook injects a
  // continuation prompt → Claude hits the rate limit again → stops again → loops.
  // Fix for: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/777
  if (isRateLimitStop(stopContext)) {
    return {
      shouldBlock: false,
      message: '[RALPH PAUSED - RATE LIMITED] API rate limit detected. Ralph loop paused until the rate limit resets. Resume manually once the limit clears.',
      mode: 'none'
    };
  }

  // First, check for incomplete todos (we need this info for ultrawork)
  // Note: stopContext already checked above, but pass it for consistency
  const todoResult = await checkIncompleteTodos(sessionId, workingDir, stopContext);
  const hasIncompleteTodos = todoResult.count > 0;

  // Priority 1: Ralph (explicit loop mode)
  const ralphResult = await checkRalphLoop(sessionId, workingDir);
  if (ralphResult) {
    return ralphResult;
  }

  // Priority 1.5: Autopilot (full orchestration mode - higher than ultrawork, lower than ralph)
  if (isAutopilotActive(workingDir, sessionId)) {
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
          tasksTotal: autopilotResult.metadata?.tasksTotal,
          toolError: autopilotResult.metadata?.toolError
        }
      };
    }
  }

  // Priority 2: Ultrawork Mode (performance mode with persistence)
  const ultraworkResult = await checkUltrawork(sessionId, workingDir, hasIncompleteTodos);
  if (ultraworkResult?.shouldBlock) {
    return ultraworkResult;
  }

  // Priority 3: Skill Active State (issue #1033)
  // Skills like code-review, plan, tdd, etc. write skill-active-state.json
  // when invoked via the Skill tool. This prevents premature stops mid-skill.
  try {
    const { checkSkillActiveState } = await import('../skill-state/index.js');
    const skillResult = checkSkillActiveState(workingDir, sessionId);
    if (skillResult.shouldBlock) {
      return {
        shouldBlock: true,
        message: skillResult.message,
        mode: 'ultrawork' as const, // Reuse ultrawork mode type for compatibility
        metadata: {
          phase: `skill:${skillResult.skillName || 'unknown'}`,
        }
      };
    }
  } catch {
    // If skill-state module is unavailable, skip gracefully
  }

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
