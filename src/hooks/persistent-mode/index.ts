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

import { existsSync, readFileSync, unlinkSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { join } from 'path';
import { getHardMaxIterations } from '../../lib/security-config.js';
import { getClaudeConfigDir, getGlobalOmcConfigCandidates } from '../../utils/paths.js';
import {
  readUltraworkState,
  writeUltraworkState,
  incrementReinforcement,
  deactivateUltrawork,
  getUltraworkPersistenceMessage,
  type UltraworkState
} from '../ultrawork/index.js';
import { resolveToWorktreeRoot, resolveSessionStatePath, getOmcRoot } from '../../lib/worktree-paths.js';
import { readModeState } from '../../lib/mode-state-io.js';
import {
  readRalphState,
  writeRalphState,
  incrementRalphIteration,
  clearRalphState,
  getPrdCompletionStatus,
  getRalphContext,
  readVerificationState,
  startVerification,
  recordArchitectFeedback,
  getArchitectVerificationPrompt,
  getArchitectRejectionContinuationPrompt,
  detectArchitectApproval,
  detectArchitectRejection,
  clearVerificationState,
} from '../ralph/index.js';
import { checkIncompleteTodos, getNextPendingTodo, StopContext, isUserAbort, isContextLimitStop, isRateLimitStop, isExplicitCancelCommand, isAuthenticationError } from '../todo-continuation/index.js';
import { TODO_CONTINUATION_PROMPT } from '../../installer/hooks.js';
import {
  isAutopilotActive
} from '../autopilot/index.js';
import { checkAutopilot } from '../autopilot/enforcement.js';
import { readTeamPipelineState } from '../team-pipeline/state.js';
import type { TeamPipelinePhase } from '../team-pipeline/types.js';
import { getActiveAgentSnapshot } from '../subagent-tracker/index.js';

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
  mode: 'ralph' | 'ultrawork' | 'todo-continuation' | 'autopilot' | 'team' | 'ralplan' | 'none';
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
  const stateDir = join(getOmcRoot(directory), 'state');
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
  const stateDir = join(getOmcRoot(directory), 'state');
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
  if (todoContinuationAttempts.size > 200) todoContinuationAttempts.clear();
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
 * Read the session-idle notification cooldown in seconds from global OMC config.
 * Default: 60 seconds. 0 = disabled (no cooldown).
 */
export function getIdleNotificationCooldownSeconds(): number {
  for (const configPath of getGlobalOmcConfigCandidates('config.json')) {
    try {
      if (!existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const cooldown = (config?.notificationCooldown as Record<string, unknown> | undefined);
      const val = cooldown?.sessionIdleSeconds;
      if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, val);
      return 60;
    } catch {
      return 60;
    }
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
    atomicWriteJsonSync(cooldownPath, { lastSentAt: new Date().toISOString() });
  } catch {
    // ignore write errors
  }
}

/** Max bytes to read from the tail of a transcript for architect approval detection. */
const TRANSCRIPT_TAIL_BYTES = 32 * 1024; // 32 KB
const CRITICAL_CONTEXT_STOP_PERCENT = 95;

/**
 * Read the tail of a potentially large transcript file.
 * Architect approval/rejection markers appear near the end of the conversation,
 * so reading only the last N bytes avoids loading megabyte-sized transcripts.
 */
function readTranscriptTail(transcriptPath: string): string {
  const size = statSync(transcriptPath).size;
  if (size <= TRANSCRIPT_TAIL_BYTES) {
    return readFileSync(transcriptPath, 'utf-8');
  }
  const fd = openSync(transcriptPath, 'r');
  try {
    const offset = size - TRANSCRIPT_TAIL_BYTES;
    const buf = Buffer.allocUnsafe(TRANSCRIPT_TAIL_BYTES);
    const bytesRead = readSync(fd, buf, 0, TRANSCRIPT_TAIL_BYTES, offset);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function estimateTranscriptContextPercent(transcriptPath?: string): number {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return 0;
  }

  try {
    const content = readTranscriptTail(transcriptPath);
    const windowMatches = [...content.matchAll(/"context_window"\s{0,5}:\s{0,5}(\d+)/g)];
    const inputMatches = [...content.matchAll(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g)];
    const lastWindow = windowMatches.at(-1)?.[1];
    const lastInput = inputMatches.at(-1)?.[1];

    if (!lastWindow || !lastInput) {
      return 0;
    }

    const contextWindow = parseInt(lastWindow, 10);
    const inputTokens = parseInt(lastInput, 10);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(inputTokens)) {
      return 0;
    }

    return Math.round((inputTokens / contextWindow) * 100);
  } catch {
    return 0;
  }
}

function isCriticalContextStop(stopContext?: StopContext): boolean {
  if (isContextLimitStop(stopContext)) {
    return true;
  }

  const transcriptPath = stopContext?.transcript_path ?? stopContext?.transcriptPath;
  return estimateTranscriptContextPercent(transcriptPath) >= CRITICAL_CONTEXT_STOP_PERCENT;
}

function isAwaitingConfirmation(state: unknown): boolean {
  return Boolean(
    state &&
    typeof state === 'object' &&
    (state as Record<string, unknown>).awaiting_confirmation === true
  );
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
        const content = readTranscriptTail(transcriptPath);
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
        const content = readTranscriptTail(transcriptPath);
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
  directory?: string,
  cancelInProgress?: boolean
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

  if (isAwaitingConfirmation(state)) {
    return null;
  }

  // Explicit cancellation window: never re-arm Ralph internals while cancel is in progress.
  // Uses cached cancel signal from checkPersistentModes to avoid TOCTOU re-reads.
  if (cancelInProgress) {
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
        const criticLabel = verificationState.critic_mode === 'codex'
          ? 'Codex critic'
          : verificationState.critic_mode === 'critic'
            ? 'Critic'
            : 'Architect';
        return {
          shouldBlock: false,
          message: `[RALPH LOOP VERIFIED COMPLETE] ${criticLabel} verified task completion after ${state.iteration} iteration(s). Excellent work!`,
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

    // Verification still pending - remind to run the selected reviewer
    // Get current story for story-aware verification
    const prdInfo = getPrdCompletionStatus(workingDir);
    const currentStory = prdInfo.nextStory ?? undefined;
    const verificationPrompt = getArchitectVerificationPrompt(verificationState, currentStory);
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

  // Check for PRD-based completion (all stories have passes: true).
  // Enter a verification phase instead of clearing Ralph immediately.
  const prdStatus = getPrdCompletionStatus(workingDir);
  if (prdStatus.hasPrd && prdStatus.allComplete) {
    const startedVerification = startVerification(
      workingDir,
      `All ${prdStatus.status?.total || 0} PRD stories are marked passes: true.`,
      state.prompt,
      state.critic_mode,
      sessionId
    );

    return {
      shouldBlock: true,
      message: getArchitectVerificationPrompt(startedVerification),
      mode: 'ralph',
      metadata: {
        iteration: state.iteration,
        maxIterations: state.max_iterations
      }
    };
  }

  // Check max iterations (cancel already checked at function entry via cached flag)
  if (state.iteration >= state.max_iterations) {
    const hardMax = getHardMaxIterations();
    if (hardMax > 0 && state.max_iterations >= hardMax) {
      // Hard limit reached — auto-disable to prevent unbounded execution
      state.active = false;
      writeRalphState(workingDir, state, sessionId);
      return {
        shouldBlock: true,
        message: `[RALPH - HARD LIMIT] Reached hard max iterations (${hardMax}). Mode auto-disabled. Restart with /oh-my-claudecode:ralph if needed.`,
        mode: 'ralph',
        metadata: { iteration: state.iteration, maxIterations: state.max_iterations }
      };
    }
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
    ? `2. Check prd.json - verify the current story's acceptance criteria are met, then mark it passes: true. Are ALL stories complete?`
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
4. When FULLY complete (after ${state.critic_mode === 'codex' ? 'Codex critic' : state.critic_mode === 'critic' ? 'Critic' : 'Architect'} verification), run \`/oh-my-claudecode:cancel\` to cleanly exit and clean up state files. If cancel fails, retry with \`/oh-my-claudecode:cancel --force\`.
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

// ---------------------------------------------------------------------------
// Stop Breaker helpers (shared by team pipeline and ralplan)
// ---------------------------------------------------------------------------

interface StopBreakerState {
  count: number;
  updated_at: string;
}

function readStopBreaker(directory: string, name: string, sessionId?: string, ttlMs?: number): number {
  const stateDir = sessionId
    ? join(getOmcRoot(directory), 'state', 'sessions', sessionId)
    : join(getOmcRoot(directory), 'state');
  const breakerPath = join(stateDir, `${name}-stop-breaker.json`);

  try {
    if (!existsSync(breakerPath)) return 0;
    const raw = JSON.parse(readFileSync(breakerPath, 'utf-8')) as StopBreakerState;
    if (ttlMs && raw.updated_at) {
      const updatedAt = new Date(raw.updated_at).getTime();
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > ttlMs) {
        unlinkSync(breakerPath);
        return 0;
      }
    }
    return typeof raw.count === 'number' ? raw.count : 0;
  } catch {
    return 0;
  }
}

function writeStopBreaker(directory: string, name: string, count: number, sessionId?: string): void {
  const stateDir = sessionId
    ? join(getOmcRoot(directory), 'state', 'sessions', sessionId)
    : join(getOmcRoot(directory), 'state');

  try {
    mkdirSync(stateDir, { recursive: true });
    const breakerPath = join(stateDir, `${name}-stop-breaker.json`);
    const data: StopBreakerState = { count, updated_at: new Date().toISOString() };
    atomicWriteJsonSync(breakerPath, data);
  } catch {
    // Ignore write errors — fail-open
  }
}

// ---------------------------------------------------------------------------
// Team Pipeline enforcement (standalone team mode)
// ---------------------------------------------------------------------------

const TEAM_PIPELINE_STOP_BLOCKER_MAX = 20;
const TEAM_PIPELINE_STOP_BLOCKER_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Check Team Pipeline state for standalone team mode enforcement.
 * When team runs WITHOUT ralph, this provides the stop-hook blocking.
 * When team runs WITH ralph, checkRalphLoop() handles it (higher priority).
 */
async function checkTeamPipeline(
  sessionId?: string,
  directory?: string,
  cancelInProgress?: boolean
): Promise<PersistentModeResult | null> {
  const workingDir = resolveToWorktreeRoot(directory);
  const teamState = readTeamPipelineState(workingDir, sessionId);

  if (!teamState) {
    return null;
  }

  if (!teamState.active) {
    writeStopBreaker(workingDir, 'team-pipeline', 0, sessionId);
    return {
      shouldBlock: false,
      message: '',
      mode: 'team'
    };
  }


  // Session isolation: readTeamPipelineState already checks session_id match
  // and returns null on mismatch (team-pipeline/state.ts:81)

  // Cancel-in-progress bypass
  if (cancelInProgress) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'team'
    };
  }

  // Read phase from canonical team-pipeline/current_phase shape first,
  // then fall back to bridge.ts / legacy stage fields for compatibility.
  const rawPhase = teamState.phase
    ?? (teamState as unknown as Record<string, unknown>).current_phase
    ?? (teamState as unknown as Record<string, unknown>).currentStage
    ?? (teamState as unknown as Record<string, unknown>).current_stage
    ?? (teamState as unknown as Record<string, unknown>).stage;

  if (typeof rawPhase !== 'string') {
    // Fail-open but still claim mode='team' so bridge.ts defers to this result
    // instead of running its own team enforcement (which could falsely block).
    return { shouldBlock: false, message: '', mode: 'team' };
  }
  const phase = rawPhase.trim().toLowerCase();

  // Terminal phases — allow stop
  if (phase === 'complete' || phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'canceled' || phase === 'cancel') {
    writeStopBreaker(workingDir, 'team-pipeline', 0, sessionId);
    return {
      shouldBlock: false,
      message: '',
      mode: 'team'
    };
  }

  // Fail-open: only known active phases should block.
  // Missing, malformed, or unknown phases do not block (safety principle).
  const KNOWN_ACTIVE_PHASES = new Set(['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix']);
  if (!KNOWN_ACTIVE_PHASES.has(phase)) {
    // Still claim mode='team' so bridge.ts defers
    return { shouldBlock: false, message: '', mode: 'team' };
  }

  // Status-level terminal check (bridge.ts format uses `status` field)
  const rawStatus = (teamState as unknown as Record<string, unknown>).status;
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : null;
  if (status === 'cancelled' || status === 'canceled' || status === 'cancel' || status === 'failed' || status === 'complete' || status === 'completed') {
    writeStopBreaker(workingDir, 'team-pipeline', 0, sessionId);
    return {
      shouldBlock: false,
      message: '',
      mode: 'team'
    };
  }

  // Cancel requested on team state — allow stop
  if (teamState.cancel?.requested) {
    writeStopBreaker(workingDir, 'team-pipeline', 0, sessionId);
    return {
      shouldBlock: false,
      message: '',
      mode: 'team'
    };
  }

  // Circuit breaker
  const breakerCount = readStopBreaker(workingDir, 'team-pipeline', sessionId, TEAM_PIPELINE_STOP_BLOCKER_TTL_MS) + 1;
  if (breakerCount > TEAM_PIPELINE_STOP_BLOCKER_MAX) {
    writeStopBreaker(workingDir, 'team-pipeline', 0, sessionId);
    return {
      shouldBlock: false,
      message: `[TEAM PIPELINE CIRCUIT BREAKER] Stop enforcement exceeded ${TEAM_PIPELINE_STOP_BLOCKER_MAX} reinforcements. Allowing stop to prevent infinite blocking.`,
      mode: 'team'
    };
  }
  writeStopBreaker(workingDir, 'team-pipeline', breakerCount, sessionId);

  return {
    shouldBlock: true,
    message: `<team-pipeline-continuation>

[TEAM PIPELINE - PHASE: ${phase.toUpperCase()} | REINFORCEMENT ${breakerCount}/${TEAM_PIPELINE_STOP_BLOCKER_MAX}]

The team pipeline is active in phase "${phase}". Continue working on the team workflow.
Do not stop until the pipeline reaches a terminal state (complete/failed/cancelled).
When done, run \`/oh-my-claudecode:cancel\` to cleanly exit.

</team-pipeline-continuation>

---

`,
    mode: 'team',
    metadata: {
      phase,
      tasksCompleted: teamState.execution?.tasks_completed,
      tasksTotal: teamState.execution?.tasks_total,
    }
  };
}

// ---------------------------------------------------------------------------
// Ralplan enforcement (standalone consensus planning)
// ---------------------------------------------------------------------------

const RALPLAN_STOP_BLOCKER_MAX = 30;
const RALPLAN_STOP_BLOCKER_TTL_MS = 45 * 60 * 1000; // 45 min
const RALPLAN_ACTIVE_AGENT_RECENCY_WINDOW_MS = 5_000;

interface RalplanState {
  active: boolean;
  session_id?: string;
}

/**
 * Check Ralplan state for standalone ralplan mode enforcement.
 * Ralplan state is written by the MCP state_write tool.
 * Only `active` and `session_id` are used for blocking decisions.
 */
async function checkRalplan(
  sessionId?: string,
  directory?: string,
  cancelInProgress?: boolean
): Promise<PersistentModeResult | null> {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readModeState<RalplanState>('ralplan', workingDir, sessionId);

  if (!state || !state.active) {
    return null;
  }

  // Session isolation
  if (sessionId && state.session_id && state.session_id !== sessionId) {
    return null;
  }

  if (isAwaitingConfirmation(state)) {
    return null;
  }

  // Terminal phase detection — allow stop when ralplan has completed
  const currentPhase = (state as unknown as Record<string, unknown>).current_phase;
  if (typeof currentPhase === 'string') {
    const terminal = ['complete', 'completed', 'failed', 'cancelled', 'done'];
    if (terminal.includes(currentPhase.toLowerCase())) {
      writeStopBreaker(workingDir, 'ralplan', 0, sessionId);
      return { shouldBlock: false, message: '', mode: 'ralplan' };
    }
  }


  // Cancel-in-progress bypass
  if (cancelInProgress) {
    return {
      shouldBlock: false,
      message: '',
      mode: 'ralplan'
    };
  }

  // Orchestrators are allowed to go idle while delegated work is still active,
  // but the raw running-agent count can lag behind the real lifecycle because
  // SubagentStop/post-tool-use bookkeeping lands after the stop event. Only
  // trust the bypass when the tracker itself was updated recently enough to
  // look live; otherwise fail closed and keep consensus enforcement active.
  const activeAgents = getActiveAgentSnapshot(workingDir);
  const activeAgentStateUpdatedAt = activeAgents.lastUpdatedAt ? new Date(activeAgents.lastUpdatedAt).getTime() : NaN;
  const hasFreshActiveAgentState =
    Number.isFinite(activeAgentStateUpdatedAt)
    && Date.now() - activeAgentStateUpdatedAt <= RALPLAN_ACTIVE_AGENT_RECENCY_WINDOW_MS;

  if (activeAgents.count > 0 && hasFreshActiveAgentState) {
    writeStopBreaker(workingDir, 'ralplan', 0, sessionId);
    return {
      shouldBlock: false,
      message: '',
      mode: 'ralplan',
    };
  }

  // Circuit breaker
  const breakerCount = readStopBreaker(workingDir, 'ralplan', sessionId, RALPLAN_STOP_BLOCKER_TTL_MS) + 1;
  if (breakerCount > RALPLAN_STOP_BLOCKER_MAX) {
    writeStopBreaker(workingDir, 'ralplan', 0, sessionId);
    return {
      shouldBlock: false,
      message: `[RALPLAN CIRCUIT BREAKER] Stop enforcement exceeded ${RALPLAN_STOP_BLOCKER_MAX} reinforcements. Allowing stop to prevent infinite blocking.`,
      mode: 'ralplan'
    };
  }
  writeStopBreaker(workingDir, 'ralplan', breakerCount, sessionId);

  return {
    shouldBlock: true,
    message: `<ralplan-continuation>

[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${breakerCount}/${RALPLAN_STOP_BLOCKER_MAX}]

The ralplan consensus workflow is active. Continue the Planner/Architect/Critic loop.
Do not stop until consensus is reached or the workflow completes.
When done, run \`/oh-my-claudecode:cancel\` to cleanly exit.

</ralplan-continuation>

---

`,
    mode: 'ralplan',
  };
}

/**
 * Check Ultrawork state and determine if it should reinforce
 */
async function checkUltrawork(
  sessionId?: string,
  directory?: string,
  _hasIncompleteTodos?: boolean,
  cancelInProgress?: boolean
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

  if (isAwaitingConfirmation(state)) {
    return null;
  }

  // Uses cached cancel signal from checkPersistentModes to avoid TOCTOU re-reads.
  if (cancelInProgress) {
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

  // CRITICAL: Never block context-limit/critical-context stops.
  // Blocking these causes a deadlock where Claude Code cannot compact or exit.
  // See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
  if (isCriticalContextStop(stopContext)) {
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
  // Cache once and pass to sub-functions to avoid TOCTOU re-reads (issue #1058).
  const cancelInProgress = isSessionCancelInProgress(workingDir, sessionId);
  if (cancelInProgress) {
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

  // CRITICAL: Never block authentication/authorization failures.
  // Expired OAuth/unauthorized responses can otherwise trigger an infinite
  // continuation loop (especially with staged Team mode prompts).
  // Fix for: issue #1308
  if (isAuthenticationError(stopContext)) {
    return {
      shouldBlock: false,
      message: '[PERSISTENT MODE PAUSED - AUTHENTICATION ERROR] Authentication failure detected (for example 401/403 or expired OAuth token). Re-authenticate, then resume manually.',
      mode: 'none'
    };
  }

  // First, check for incomplete todos (we need this info for ultrawork)
  // Note: stopContext already checked above, but pass it for consistency
  const todoResult = await checkIncompleteTodos(sessionId, workingDir, stopContext);
  const hasIncompleteTodos = todoResult.count > 0;

  // Priority 1: Ralph (explicit loop mode)
  const ralphResult = await checkRalphLoop(sessionId, workingDir, cancelInProgress);
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

  // Priority 1.7: Team Pipeline (standalone team mode)
  // When team runs without ralph, this provides stop-hook blocking.
  // When team runs with ralph, checkRalphLoop() handles it (Priority 1).
  // Return ANY non-null result (including circuit breaker shouldBlock=false with message).
  const teamResult = await checkTeamPipeline(sessionId, workingDir, cancelInProgress);
  if (teamResult) {
    return teamResult;
  }

  // Priority 1.8: Ralplan (standalone consensus planning)
  // Ralplan consensus loops (Planner/Architect/Critic) need hard-blocking.
  // When ralplan runs under ralph, checkRalphLoop() handles it (Priority 1).
  // Return ANY non-null result (including circuit breaker shouldBlock=false with message).
  const ralplanResult = await checkRalplan(sessionId, workingDir, cancelInProgress);
  if (ralplanResult) {
    return ralplanResult;
  }

  // Priority 2: Ultrawork Mode (performance mode with persistence)
  const ultraworkResult = await checkUltrawork(sessionId, workingDir, hasIncompleteTodos, cancelInProgress);
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
 * Create hook output for Claude Code.
 * Returns `continue: false` when `shouldBlock` is true to hard-block the stop event.
 * Returns `continue: true` for terminal states, escape hatches, and errors.
 */
export function createHookOutput(result: PersistentModeResult): {
  continue: boolean;
  message?: string;
} {
  return {
    continue: !result.shouldBlock,
    message: result.message || undefined
  };
}
