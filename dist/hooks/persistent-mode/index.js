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
import { createHash } from 'crypto';
import { existsSync, readFileSync, unlinkSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { join } from 'path';
import { getHardMaxIterations } from '../../lib/security-config.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { getGlobalOmcConfigCandidates } from '../../utils/paths.js';
import { readUltraworkState, writeUltraworkState, incrementReinforcement, deactivateUltrawork, getUltraworkPersistenceMessage } from '../ultrawork/index.js';
import { resolveToWorktreeRoot, resolveSessionStatePath, resolveStatePath, getOmcRoot } from '../../lib/worktree-paths.js';
import { readModeState, writeModeState, withStateFileMutationLock } from '../../lib/mode-state-io.js';
import { readRalphState, writeRalphState, incrementRalphIteration, clearRalphState, findPrdPath, getPrdCompletionStatus, getRalphContext, getStory, markStoryIncomplete, markStoryArchitectVerified, readVerificationState, startVerification, recordArchitectFeedback, getArchitectVerificationPrompt, getArchitectRejectionContinuationPrompt, detectArchitectApproval, detectArchitectRejection, clearVerificationState, } from '../ralph/index.js';
import { checkIncompleteTodos, getNextPendingTodo, isUserAbort, isContextLimitStop, isRateLimitStop, isExplicitCancelCommand, isAuthenticationError, isScheduledWakeupStop, isOversizeToolResultRedirectStop } from '../todo-continuation/index.js';
import { TODO_CONTINUATION_PROMPT } from '../../installer/hooks.js';
import { isAutopilotActive, readAutopilotState, } from '../autopilot/index.js';
import { checkAutopilot } from '../autopilot/enforcement.js';
import { readTeamPipelineState } from '../team-pipeline/state.js';
import { getActiveAgentSnapshot } from '../subagent-tracker/index.js';
import { truncatePromptForEcho } from '../../lib/truncate-prompt.js';
import { isModeActive } from '../mode-registry/index.js';
import { namedWorkflowRuntimeSupported, validateNamedWorkflowState } from '../autopilot/named-workflow-resume-validator.js';
/** Maximum todo-continuation attempts before giving up (prevents infinite loops) */
const MAX_TODO_CONTINUATION_ATTEMPTS = 5;
const CANCEL_SIGNAL_TTL_MS = 30_000;
const CANCEL_SIGNAL_CLOCK_SKEW_MS = 5_000;
const STALE_STATE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const PENDING_ASYNC_STATE_STALE_MS = 24 * 60 * 60 * 1000;
const OVERSIZE_TOOL_RESULT_REDIRECT_STOP_MAX = 3;
const OVERSIZE_TOOL_RESULT_REDIRECT_STOP_TTL_MS = 5 * 60 * 1000;
const TERMINAL_WORKFLOW_SLOT_MODES = new Set(['autopilot', 'ralph', 'ralplan']);
const TERMINAL_WORKFLOW_PHASES = new Set([
    'complete',
    'completed',
    'failed',
    'cancelled',
    'canceled',
    'cancel',
    'done',
    'stopped',
]);
function hasNamedWorkflowMarkers(state) {
    return Boolean(state &&
        typeof state === 'object' &&
        ['workflow', 'workflowRunId', 'pipelineTracking'].some((marker) => Object.prototype.hasOwnProperty.call(state, marker)));
}
function isEnforceableNamedAutopilotState(state, directory, sessionId) {
    if (!state ||
        !sessionId ||
        !hasNamedWorkflowMarkers(state) ||
        state.active !== true ||
        state.session_id !== sessionId ||
        isTerminalWorkflowModeState(state) ||
        typeof state.project_path !== 'string' ||
        !namedWorkflowRuntimeSupported()) {
        return false;
    }
    try {
        return resolveToWorktreeRoot(state.project_path) === resolveToWorktreeRoot(directory)
            && Boolean(validateNamedWorkflowState(state, sessionId));
    }
    catch {
        return false;
    }
}
/** Track todo-continuation attempts per session to prevent infinite loops */
const todoContinuationAttempts = new Map();
export function shouldWriteStateBack(statePath) {
    return Boolean(statePath && existsSync(statePath));
}
function resolveAutopilotTargetPath(directory, sessionId) {
    return sessionId
        ? resolveSessionStatePath('autopilot', sessionId, directory)
        : resolveStatePath('autopilot', directory);
}
function readAutopilotTarget(directory, sessionId) {
    const path = resolveAutopilotTargetPath(directory, sessionId);
    if (!readAutopilotState(directory, sessionId))
        return null;
    try {
        const state = JSON.parse(readFileSync(path, 'utf-8'));
        return state && typeof state === 'object' && !Array.isArray(state)
            ? { path, state: state }
            : null;
    }
    catch {
        return null;
    }
}
function isCurrentAutopilotTarget(state, directory, sessionId) {
    if (state.active !== true ||
        state.session_id !== sessionId ||
        typeof state.project_path !== 'string' ||
        isTerminalWorkflowModeState(state)) {
        return false;
    }
    try {
        return resolveToWorktreeRoot(state.project_path) === resolveToWorktreeRoot(directory);
    }
    catch {
        return false;
    }
}
function isAuthenticatedAutopilotCancelSignal(signal, target) {
    if (signal.active !== true || signal.mode !== 'autopilot' || typeof signal.source !== 'string' || signal.source.length === 0) {
        return false;
    }
    const now = Date.now();
    const requestedAt = typeof signal.requested_at === 'string' ? new Date(signal.requested_at).getTime() : NaN;
    const expiresAt = typeof signal.expires_at === 'string' ? new Date(signal.expires_at).getTime() : NaN;
    if (!Number.isFinite(requestedAt) ||
        requestedAt > now + CANCEL_SIGNAL_CLOCK_SKEW_MS ||
        now - requestedAt > CANCEL_SIGNAL_TTL_MS ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= requestedAt ||
        expiresAt - requestedAt > CANCEL_SIGNAL_TTL_MS ||
        expiresAt <= now) {
        return false;
    }
    const digest = createHash('sha256').update(JSON.stringify(target.state)).digest('hex');
    if (typeof signal.target_state_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(signal.target_state_sha256) ||
        signal.target_state_sha256 !== digest) {
        return false;
    }
    const workflowRunId = target.state.workflowRunId;
    return typeof workflowRunId === 'string'
        ? signal.target_workflow_run_id === workflowRunId
        : signal.target_workflow_run_id === undefined;
}
function isSessionCancelInProgress(directory, sessionId) {
    const autopilotPath = resolveAutopilotTargetPath(directory, sessionId);
    let cancelSignalPath;
    if (sessionId) {
        try {
            cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, directory);
        }
        catch {
            // Fall through to the legacy path.
        }
    }
    if (!cancelSignalPath) {
        cancelSignalPath = join(getOmcRoot(directory), 'state', 'cancel-signal-state.json');
    }
    const validateSignal = (target) => {
        const locked = withStateFileMutationLock(cancelSignalPath, () => {
            let raw;
            try {
                const parsed = JSON.parse(readFileSync(cancelSignalPath, 'utf-8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    return false;
                raw = parsed;
            }
            catch {
                return false;
            }
            const now = Date.now();
            const requestedAt = typeof raw.requested_at === 'string' ? new Date(raw.requested_at).getTime() : NaN;
            const expiresAt = typeof raw.expires_at === 'string' ? new Date(raw.expires_at).getTime() : NaN;
            if (target) {
                if (Number.isFinite(expiresAt) && expiresAt <= now && existsSync(cancelSignalPath))
                    unlinkSync(cancelSignalPath);
                return isAuthenticatedAutopilotCancelSignal(raw, target);
            }
            // A requested-at-only signal belongs to Ralph/Ultrawork. It must never be
            // interpreted as an unauthenticated autopilot cancellation.
            if (raw.mode === 'autopilot' ||
                raw.target_state_sha256 !== undefined ||
                raw.target_workflow_run_id !== undefined) {
                return false;
            }
            const effectiveExpiry = Number.isFinite(expiresAt)
                ? expiresAt
                : Number.isFinite(requestedAt) ? requestedAt + CANCEL_SIGNAL_TTL_MS : NaN;
            if (!Number.isFinite(requestedAt) ||
                requestedAt > now + CANCEL_SIGNAL_CLOCK_SKEW_MS ||
                now - requestedAt > CANCEL_SIGNAL_TTL_MS ||
                !Number.isFinite(effectiveExpiry) ||
                effectiveExpiry <= requestedAt ||
                effectiveExpiry - requestedAt > CANCEL_SIGNAL_TTL_MS ||
                effectiveExpiry <= now) {
                if (Number.isFinite(effectiveExpiry) && effectiveExpiry <= now && existsSync(cancelSignalPath))
                    unlinkSync(cancelSignalPath);
                return false;
            }
            return true;
        }, target !== null);
        return locked.acquired && locked.value === true;
    };
    // A target-bearing signal must hold both locks. On runtimes without flock,
    // requested-at-only Ralph/Ultrawork cancellation may proceed only after
    // canonical discovery proves this session has no enforceable autopilot state.
    const locked = withStateFileMutationLock(autopilotPath, () => {
        const current = readAutopilotTarget(directory, sessionId);
        if (!current || !isCurrentAutopilotTarget(current.state, directory, sessionId)) {
            return { autopilotCancellation: false, nonAutopilotCancellation: validateSignal(null) };
        }
        // Named integrity failures deliberately fail closed so checkAutopilot()
        // can propagate its diagnostic instead of a forged cancel hiding it.
        if (hasNamedWorkflowMarkers(current.state) && !isEnforceableNamedAutopilotState(current.state, directory, sessionId)) {
            return { autopilotCancellation: false, nonAutopilotCancellation: false };
        }
        return {
            autopilotCancellation: validateSignal(current),
            nonAutopilotCancellation: false,
            enforceableAutopilot: current,
        };
    }, true);
    if (locked.acquired && locked.value)
        return locked.value;
    if (namedWorkflowRuntimeSupported()) {
        return { autopilotCancellation: false, nonAutopilotCancellation: false };
    }
    const current = readAutopilotTarget(directory, sessionId);
    if (current && isCurrentAutopilotTarget(current.state, directory, sessionId)) {
        return { autopilotCancellation: false, nonAutopilotCancellation: false, enforceableAutopilot: current };
    }
    return { autopilotCancellation: false, nonAutopilotCancellation: validateSignal(null) };
}
/**
 * Treat mode state as stale if it has not been refreshed recently.
 * Stale files are ignored so they cannot falsely block new sessions.
 * Uses the freshest of last_checked_at, updated_at, or started_at.
 */
function isStaleState(state) {
    if (!state || typeof state !== 'object') {
        return true;
    }
    const stateRecord = state;
    const timestamps = [stateRecord.last_checked_at, stateRecord.updated_at, stateRecord.started_at]
        .filter((value) => typeof value === 'string' && value.length > 0);
    const mostRecent = timestamps.reduce((max, value) => {
        const parsed = new Date(value).getTime();
        return Number.isFinite(parsed) && parsed > max ? parsed : max;
    }, 0);
    if (mostRecent === 0) {
        return true;
    }
    return Date.now() - mostRecent > STALE_STATE_THRESHOLD_MS;
}
function parseTimestamp(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}
function isFreshTimestamp(value, ttlMs = PENDING_ASYNC_STATE_STALE_MS) {
    const parsed = parseTimestamp(value);
    return parsed !== null && Date.now() - parsed <= ttlMs;
}
function hasPendingBackgroundTask(directory, sessionId) {
    try {
        const stateRoot = join(getOmcRoot(directory), 'state');
        const hudPath = sessionId
            ? join(stateRoot, 'sessions', sessionId, 'hud-state.json')
            : join(stateRoot, 'hud-state.json');
        if (!existsSync(hudPath))
            return false;
        const hudState = JSON.parse(readFileSync(hudPath, 'utf-8'));
        return Boolean(hudState?.backgroundTasks?.some((task) => {
            if (task.status !== 'running')
                return false;
            return isFreshTimestamp(task.startedAt ?? task.startTime);
        }));
    }
    catch {
        return false;
    }
}
function readPendingWakeupState(directory, sessionId) {
    const stateRoot = join(getOmcRoot(directory), 'state');
    const dirs = sessionId
        ? [join(stateRoot, 'sessions', sessionId), stateRoot]
        : [stateRoot];
    const fileNames = [
        'scheduled-wakeup-state.json',
        'schedule-wakeup-state.json',
        'wakeup-state.json',
    ];
    const states = [];
    for (const dir of dirs) {
        for (const fileName of fileNames) {
            const filePath = join(dir, fileName);
            try {
                if (!existsSync(filePath))
                    continue;
                const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
                if (parsed && typeof parsed === 'object') {
                    states.push(parsed);
                }
            }
            catch {
                continue;
            }
        }
    }
    return states;
}
function hasPendingScheduledWakeup(directory, sessionId) {
    const now = Date.now();
    return readPendingWakeupState(directory, sessionId).some((state) => {
        const status = typeof state.status === 'string' ? state.status.toLowerCase() : '';
        if (['completed', 'complete', 'cancelled', 'canceled', 'failed', 'expired'].includes(status)) {
            return false;
        }
        const dueAt = parseTimestamp(state.due_at ?? state.wakeup_at ?? state.scheduled_for ?? state.deadline_at ?? state.expires_at);
        if (dueAt !== null) {
            return dueAt > now;
        }
        if (state.active === true || state.pending === true) {
            return isFreshTimestamp(state.created_at ?? state.updated_at ?? state.started_at);
        }
        return false;
    });
}
function normalizeWorkflowTerminalPhase(state) {
    const raw = state.current_phase ?? state.phase ?? state.status;
    return typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim().toLowerCase()
        : null;
}
function isTerminalWorkflowModeState(state) {
    if (!state)
        return false;
    if (state.active === false)
        return true;
    if (typeof state.completed_at === 'string' && state.completed_at.length > 0)
        return true;
    const phase = normalizeWorkflowTerminalPhase(state);
    return Boolean(phase && TERMINAL_WORKFLOW_PHASES.has(phase));
}
async function reconcileTerminalWorkflowSlots(workingDir, sessionId) {
    try {
        const { readSkillActiveStateNormalized, pruneExpiredWorkflowSkillTombstones, markWorkflowSkillCompleted, writeSkillActiveStateCopies, } = await import('../skill-state/index.js');
        const original = readSkillActiveStateNormalized(workingDir, sessionId);
        let current = pruneExpiredWorkflowSkillTombstones(original);
        let changed = current !== original;
        for (const [slotName, slot] of Object.entries(current.active_skills)) {
            if (slot.completed_at || !TERMINAL_WORKFLOW_SLOT_MODES.has(slotName)) {
                continue;
            }
            const modeState = readModeState(slotName, workingDir, sessionId);
            if (!isTerminalWorkflowModeState(modeState)) {
                continue;
            }
            current = markWorkflowSkillCompleted(current, slotName);
            changed = true;
        }
        if (changed) {
            writeSkillActiveStateCopies(workingDir, current, sessionId);
        }
    }
    catch {
        // Best-effort reconciliation only. Stop enforcement falls back to the
        // direct mode-state checks below if the ledger cannot be updated.
    }
}
/**
 * Pending owned async work (background Bash/Task or an armed wakeup) means the
 * agent is legitimately waiting for an external notification/resume. In that
 * window persistent modes should not inject a "stalled" reinforcement.
 */
export function hasPendingOwnedAsyncWork(directory, sessionId) {
    return hasPendingBackgroundTask(directory, sessionId)
        || hasPendingScheduledWakeup(directory, sessionId);
}
/**
 * Read last tool error from state directory.
 * Returns null if file doesn't exist or error is stale (>60 seconds old).
 */
export function readLastToolError(directory) {
    const stateDir = join(getOmcRoot(directory), 'state');
    const errorPath = join(stateDir, 'last-tool-error.json');
    try {
        if (!existsSync(errorPath)) {
            return null;
        }
        const content = readFileSync(errorPath, 'utf-8');
        const toolError = JSON.parse(content);
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
    }
    catch {
        return null;
    }
}
/**
 * Clear tool error state file atomically.
 */
export function clearToolErrorState(directory) {
    const stateDir = join(getOmcRoot(directory), 'state');
    const errorPath = join(stateDir, 'last-tool-error.json');
    try {
        if (existsSync(errorPath)) {
            unlinkSync(errorPath);
        }
    }
    catch {
        // Ignore errors - file may have been removed already
    }
}
/**
 * Generate retry guidance message for tool errors.
 * After 5+ retries, suggests alternative approaches.
 */
export function getToolErrorRetryGuidance(toolError) {
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
function trackTodoContinuationAttempt(sessionId) {
    if (todoContinuationAttempts.size > 200)
        todoContinuationAttempts.clear();
    const current = todoContinuationAttempts.get(sessionId) || 0;
    const next = current + 1;
    todoContinuationAttempts.set(sessionId, next);
    return next;
}
/**
 * Reset todo-continuation attempt counter (call when todos actually change)
 */
export function resetTodoContinuationAttempts(sessionId) {
    todoContinuationAttempts.delete(sessionId);
}
/**
 * Read the session-idle notification cooldown in seconds from global OMC config.
 * Default: 60 seconds. 0 = disabled (no cooldown).
 */
export function getIdleNotificationCooldownSeconds() {
    for (const configPath of getGlobalOmcConfigCandidates('config.json')) {
        try {
            if (!existsSync(configPath))
                continue;
            const config = JSON.parse(readFileSync(configPath, 'utf-8'));
            const cooldown = config?.notificationCooldown;
            const val = cooldown?.sessionIdleSeconds;
            if (typeof val === 'number' && Number.isFinite(val))
                return Math.max(0, val);
            return 60;
        }
        catch {
            return 60;
        }
    }
    return 60;
}
function getGlobalIdleNotificationCooldownPath(stateDir) {
    return join(stateDir, 'idle-notif-cooldown.json');
}
function getIdleNotificationCooldownPath(stateDir, sessionId) {
    // Keep session segments filesystem-safe; fall back to legacy global path otherwise.
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
        return join(stateDir, 'sessions', sessionId, 'idle-notif-cooldown.json');
    }
    return getGlobalIdleNotificationCooldownPath(stateDir);
}
function readIdleNotificationCooldownRecord(cooldownPath) {
    try {
        if (!existsSync(cooldownPath))
            return null;
        return JSON.parse(readFileSync(cooldownPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
function isRepeatedZeroBacklogCooldown(record, repoState) {
    return Boolean(repoState?.backlogZero &&
        record?.backlogZero === true &&
        typeof record.repoSignature === 'string' &&
        record.repoSignature === repoState.signature);
}
function hasRepeatedZeroBacklogCooldown(stateDir, sessionId, repoState) {
    const cooldownPath = getIdleNotificationCooldownPath(stateDir, sessionId);
    const cooldownRecord = readIdleNotificationCooldownRecord(cooldownPath);
    if (isRepeatedZeroBacklogCooldown(cooldownRecord, repoState)) {
        return true;
    }
    if (cooldownPath !== getGlobalIdleNotificationCooldownPath(stateDir)) {
        const globalRecord = readIdleNotificationCooldownRecord(getGlobalIdleNotificationCooldownPath(stateDir));
        if (isRepeatedZeroBacklogCooldown(globalRecord, repoState)) {
            return true;
        }
    }
    return false;
}
/**
 * OpenClaw stop wakes should usually bypass idle cooldowns, but unchanged
 * zero-backlog repo state should stay suppressed so stale repo-level CI replay
 * bursts do not re-arm after the actionable backlog is already zero.
 */
export function shouldWakeOpenClawOnStop(stateDir, sessionId, repoState) {
    return !hasRepeatedZeroBacklogCooldown(stateDir, sessionId, repoState);
}
/**
 * Check whether the session-idle notification cooldown has elapsed.
 * Returns true if the notification should be sent.
 */
export function shouldSendIdleNotification(stateDir, sessionId, repoState) {
    const cooldownSecs = getIdleNotificationCooldownSeconds();
    const cooldownPath = getIdleNotificationCooldownPath(stateDir, sessionId);
    const cooldownRecord = readIdleNotificationCooldownRecord(cooldownPath);
    if (hasRepeatedZeroBacklogCooldown(stateDir, sessionId, repoState)) {
        return false;
    }
    if (repoState && typeof cooldownRecord?.repoSignature === 'string') {
        if (cooldownRecord.repoSignature !== repoState.signature) {
            return true;
        }
    }
    if (cooldownSecs === 0)
        return true; // cooldown disabled
    if (typeof cooldownRecord?.lastSentAt === 'string') {
        const elapsed = (Date.now() - new Date(cooldownRecord.lastSentAt).getTime()) / 1000;
        if (Number.isFinite(elapsed) && elapsed < cooldownSecs)
            return false;
    }
    return true;
}
/**
 * Record that the session-idle notification was sent at the current timestamp.
 */
export function recordIdleNotificationSent(stateDir, sessionId, repoState) {
    const cooldownPath = getIdleNotificationCooldownPath(stateDir, sessionId);
    try {
        const record = {
            lastSentAt: new Date().toISOString(),
        };
        if (repoState) {
            record.repoSignature = repoState.signature;
            record.backlogZero = repoState.backlogZero;
        }
        atomicWriteJsonSync(cooldownPath, record);
        if (repoState?.backlogZero && cooldownPath !== getGlobalIdleNotificationCooldownPath(stateDir)) {
            atomicWriteJsonSync(getGlobalIdleNotificationCooldownPath(stateDir), record);
        }
    }
    catch {
        // ignore write errors
    }
}
/** Max bytes to read from the tail of a transcript for architect approval detection. */
const TRANSCRIPT_TAIL_BYTES = 32 * 1024; // 32 KB
const CRITICAL_CONTEXT_STOP_PERCENT = 95;
const RALPLAN_TERMINAL_PHASES = new Set([
    'completed',
    'complete',
    'failed',
    'cancelled',
    'canceled',
    'aborted',
    'terminated',
    'done',
    'handoff',
    'pending approval',
    'pending-approval',
    'pending_approval',
    'awaiting approval',
    'awaiting-approval',
    'awaiting_approval',
    'approval-required',
    'approval_required',
]);
/**
 * Read the tail of a potentially large transcript file.
 * Architect approval/rejection markers appear near the end of the conversation,
 * so reading only the last N bytes avoids loading megabyte-sized transcripts.
 */
function readTranscriptTail(transcriptPath) {
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
    }
    finally {
        closeSync(fd);
    }
}
function readTranscriptTailLines(transcriptPath) {
    const content = readTranscriptTail(transcriptPath);
    const lines = content.split('\n');
    try {
        if (statSync(transcriptPath).size > TRANSCRIPT_TAIL_BYTES && lines.length > 0) {
            lines.shift();
        }
    }
    catch {
        return lines;
    }
    return lines;
}
const REVIEWER_TASK_TOOL_NAMES = new Set(['Task', 'proxy_Task', 'Agent']);
const REVIEWER_COMMAND_TOOL_NAMES = new Set(['Bash', 'proxy_Bash']);
function normalizeReviewerPath(subagentType) {
    if (typeof subagentType !== 'string') {
        return null;
    }
    const normalized = subagentType.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    const baseName = normalized.includes(':')
        ? normalized.slice(normalized.lastIndexOf(':') + 1)
        : normalized;
    if (baseName === 'architect' || baseName.startsWith('architect-')) {
        return 'architect';
    }
    if (baseName === 'critic' || baseName.startsWith('critic-')) {
        return 'critic';
    }
    return null;
}
function isCodexReviewerCommand(command) {
    return typeof command === 'string'
        && /\bask\s+codex\s+--agent-prompt\s+critic\b/i.test(command);
}
function extractTranscriptText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((item) => extractTranscriptText(item)).filter(Boolean).join('\n');
    }
    if (!content || typeof content !== 'object') {
        return '';
    }
    const record = content;
    const directText = typeof record.text === 'string' ? record.text : '';
    const nestedContent = 'content' in record ? extractTranscriptText(record.content) : '';
    return [directText, nestedContent].filter(Boolean).join('\n');
}
function matchesVerificationReviewerPath(reviewerPath, verificationState) {
    const expected = verificationState?.critic_mode ?? 'architect';
    return reviewerPath === expected;
}
function checkReviewerAuthoredApprovalInMessages(transcriptPath, verificationState) {
    const reviewerToolUses = new Map();
    for (const line of readTranscriptTailLines(transcriptPath)) {
        if (!line.trim()) {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const content = entry.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const block of content) {
            if (block?.type === 'tool_use' && block.id && block.name) {
                if (REVIEWER_TASK_TOOL_NAMES.has(block.name)) {
                    const reviewerPath = normalizeReviewerPath(block.input?.subagent_type);
                    if (reviewerPath && matchesVerificationReviewerPath(reviewerPath, verificationState)) {
                        reviewerToolUses.set(block.id, reviewerPath);
                    }
                    continue;
                }
                if (REVIEWER_COMMAND_TOOL_NAMES.has(block.name)) {
                    const command = block.input?.command;
                    if (isCodexReviewerCommand(command) && matchesVerificationReviewerPath('codex', verificationState)) {
                        reviewerToolUses.set(block.id, 'codex');
                    }
                }
                continue;
            }
            if (block?.type !== 'tool_result' || !block.tool_use_id) {
                continue;
            }
            if (!reviewerToolUses.has(block.tool_use_id)) {
                continue;
            }
            const reviewerOutput = extractTranscriptText(block.content);
            if (reviewerOutput && detectArchitectApproval(reviewerOutput, verificationState)) {
                return true;
            }
        }
    }
    return false;
}
function estimateTranscriptContextPercent(transcriptPath) {
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
    }
    catch {
        return 0;
    }
}
function isCriticalContextStop(stopContext) {
    if (isContextLimitStop(stopContext)) {
        return true;
    }
    const transcriptPath = stopContext?.transcript_path ?? stopContext?.transcriptPath;
    return estimateTranscriptContextPercent(transcriptPath) >= CRITICAL_CONTEXT_STOP_PERCENT;
}
const AWAITING_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
function isAwaitingConfirmation(state) {
    if (!state || typeof state !== 'object') {
        return false;
    }
    const stateRecord = state;
    if (stateRecord.awaiting_confirmation !== true) {
        return false;
    }
    const setAt = (typeof stateRecord.awaiting_confirmation_set_at === 'string' && stateRecord.awaiting_confirmation_set_at) ||
        (typeof stateRecord.started_at === 'string' && stateRecord.started_at) ||
        null;
    if (!setAt) {
        return false;
    }
    const setAtMs = new Date(setAt).getTime();
    if (!Number.isFinite(setAtMs)) {
        return false;
    }
    return Date.now() - setAtMs < AWAITING_CONFIRMATION_TTL_MS;
}
/**
 * Check for architect approval in session transcript
 */
function checkArchitectApprovalInTranscript(sessionId, verificationState) {
    const claudeDir = getClaudeConfigDir();
    const possiblePaths = [join(claudeDir, 'sessions', sessionId, 'messages.json')];
    for (const transcriptPath of possiblePaths) {
        if (!existsSync(transcriptPath)) {
            continue;
        }
        try {
            if (checkReviewerAuthoredApprovalInMessages(transcriptPath, verificationState)) {
                return true;
            }
        }
        catch {
            continue;
        }
    }
    return false;
}
/**
 * Check for architect rejection in session transcript
 */
function checkArchitectRejectionInTranscript(sessionId) {
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
            }
            catch {
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
async function checkRalphLoop(sessionId, directory, cancelInProgress) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readRalphState(workingDir, sessionId);
    const ralphStatePath = sessionId
        ? resolveSessionStatePath('ralph', sessionId, workingDir)
        : resolveStatePath('ralph', workingDir);
    if (!state || !state.active || isStaleState(state)) {
        return null;
    }
    // Session isolation. `readRalphState()` already enforces the lenient form
    // ("only reject when BOTH sides have defined session_ids that differ"),
    // so by the time we get here, the state file is either explicitly bound
    // to this session or has no session_id at all (legacy/unbound state).
    //
    // The previous strict check `state.session_id !== sessionId` rejected the
    // legitimate case where one side is undefined and the other is a UUID,
    // which broke iteration counting on every Ralph loop where the state file
    // lacked a session_id (or the Stop hook lost it). Symptom: ralph:1/100
    // stuck forever in the HUD even on multi-hour sessions where the Stop
    // hook fired many times.
    if (state.session_id && sessionId && state.session_id !== sessionId) {
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
            const restoredState = {
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
    if (teamState && teamState.active !== undefined && !isStaleState(teamState)) {
        const teamPhase = teamState.phase;
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
    let verificationState = readVerificationState(workingDir, sessionId);
    if (verificationState?.pending) {
        // Verification is in progress - check for architect's response
        if (sessionId) {
            // Check for architect approval
            if (checkArchitectApprovalInTranscript(sessionId, verificationState)) {
                if (verificationState.verification_scope === 'story' && verificationState.story_id) {
                    markStoryArchitectVerified(workingDir, verificationState.story_id, undefined, sessionId);
                    clearVerificationState(workingDir, sessionId);
                    const refreshedState = readRalphState(workingDir, sessionId);
                    if (refreshedState) {
                        const refreshedPrd = getPrdCompletionStatus(workingDir, sessionId);
                        refreshedState.current_story_id = refreshedPrd.nextStory?.id;
                        writeRalphState(workingDir, refreshedState, sessionId);
                    }
                    verificationState = readVerificationState(workingDir, sessionId);
                }
                else {
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
            }
            // Check for architect rejection
            const rejection = checkArchitectRejectionInTranscript(sessionId);
            if (verificationState && rejection.rejected) {
                if (verificationState.verification_scope === 'story' && verificationState.story_id) {
                    markStoryIncomplete(workingDir, verificationState.story_id, rejection.feedback, sessionId);
                }
                // Architect rejected - continue with feedback
                recordArchitectFeedback(workingDir, false, rejection.feedback, sessionId);
                const updatedVerification = readVerificationState(workingDir, sessionId);
                verificationState = updatedVerification;
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
        if (verificationState?.pending) {
            const storyUnderReview = verificationState.story_id
                ? getStory(workingDir, verificationState.story_id, sessionId) ?? undefined
                : undefined;
            // Verification still pending - remind to run the selected reviewer
            const verificationPrompt = getArchitectVerificationPrompt(verificationState, storyUnderReview);
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
    }
    const prdStatus = getPrdCompletionStatus(workingDir, sessionId);
    const currentStory = state.current_story_id
        ? getStory(workingDir, state.current_story_id, sessionId)
        : prdStatus.nextStory;
    if (currentStory?.passes && currentStory.architectVerified !== true) {
        const startedVerification = startVerification(workingDir, `Story ${currentStory.id} is marked passes: true and requires architect approval before Ralph can progress.`, state.prompt, state.critic_mode, sessionId, currentStory);
        return {
            shouldBlock: true,
            message: getArchitectVerificationPrompt(startedVerification, currentStory),
            mode: 'ralph',
            metadata: {
                iteration: state.iteration,
                maxIterations: state.max_iterations
            }
        };
    }
    // Check for PRD-based completion (all stories have passes: true and are architect-verified).
    // Enter a verification phase instead of clearing Ralph immediately.
    if (prdStatus.hasPrd && prdStatus.allComplete) {
        const startedVerification = startVerification(workingDir, `All ${prdStatus.status?.total || 0} PRD stories are marked passes: true.`, state.prompt, state.critic_mode, sessionId);
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
    // Hard max: check iteration count directly against the security limit,
    // independent of max_iterations, so it cannot be bypassed by a high
    // initial max_iterations value.
    const hardMax = getHardMaxIterations();
    if (hardMax > 0 && state.iteration >= hardMax) {
        // Hard limit reached — auto-disable to prevent unbounded execution
        state.active = false;
        if (!shouldWriteStateBack(ralphStatePath)) {
            return {
                shouldBlock: false,
                message: '',
                mode: 'none'
            };
        }
        writeRalphState(workingDir, state, sessionId);
        return {
            shouldBlock: true,
            message: `[RALPH - HARD LIMIT] Reached hard max iterations (${hardMax}). Mode auto-disabled. Restart with /oh-my-claudecode:ralph if needed.`,
            mode: 'ralph',
            metadata: { iteration: state.iteration, maxIterations: state.max_iterations }
        };
    }
    // Check max iterations — extend limit so user-visible cancellation
    // remains the only explicit termination path.
    if (state.iteration >= state.max_iterations) {
        state.max_iterations += 10;
        if (!shouldWriteStateBack(ralphStatePath)) {
            return {
                shouldBlock: false,
                message: '',
                mode: 'none'
            };
        }
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
    const ralphContext = getRalphContext(workingDir, sessionId);
    const activePrdPath = prdStatus.hasPrd ? findPrdPath(workingDir, sessionId) : null;
    const prdInstruction = prdStatus.hasPrd
        ? `2. Check ${activePrdPath ?? 'prd.json'} - verify the current story's acceptance criteria are met, then mark it passes: true. Are ALL stories complete?`
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

${newState.prompt ? `Original task: ${truncatePromptForEcho(newState.prompt)}` : ''}

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
function readStopBreaker(directory, name, sessionId, ttlMs) {
    const stateDir = sessionId
        ? join(getOmcRoot(directory), 'state', 'sessions', sessionId)
        : join(getOmcRoot(directory), 'state');
    const breakerPath = join(stateDir, `${name}-stop-breaker.json`);
    try {
        if (!existsSync(breakerPath))
            return 0;
        const raw = JSON.parse(readFileSync(breakerPath, 'utf-8'));
        if (ttlMs && raw.updated_at) {
            const updatedAt = new Date(raw.updated_at).getTime();
            if (Number.isFinite(updatedAt) && Date.now() - updatedAt > ttlMs) {
                unlinkSync(breakerPath);
                return 0;
            }
        }
        return typeof raw.count === 'number' ? raw.count : 0;
    }
    catch {
        return 0;
    }
}
function writeStopBreaker(directory, name, count, sessionId) {
    const stateDir = sessionId
        ? join(getOmcRoot(directory), 'state', 'sessions', sessionId)
        : join(getOmcRoot(directory), 'state');
    try {
        mkdirSync(stateDir, { recursive: true });
        const breakerPath = join(stateDir, `${name}-stop-breaker.json`);
        const data = { count, updated_at: new Date().toISOString() };
        atomicWriteJsonSync(breakerPath, data);
    }
    catch {
        // Ignore write errors — fail-open
    }
}
// ---------------------------------------------------------------------------
// Thinking-only streak guard (issue #3280)
//
// A persistent mode (ralph/autopilot/team/ralplan/ultrawork/…) re-injects a
// continuation prompt on every Stop while the mode is active. If the agent
// answers each continuation with only thinking blocks and never a tool_use,
// no work happens but tokens keep burning. Bound that failure: count
// consecutive thinking-only assistant turns and release the stop once the
// streak hits a conservative threshold. Any tool_use turn resets the streak,
// and every read/parse path fails open (keep enforcing) so a flaky transcript
// never short-circuits a healthy persistent mode.
// ---------------------------------------------------------------------------
const THINKING_ONLY_STREAK_BREAKER = 'thinking-only-streak';
const THINKING_ONLY_STREAK_MAX = 3;
const THINKING_ONLY_STREAK_TTL_MS = 5 * 60 * 1000; // 5 min
const THINKING_ONLY_STREAK_BAILOUT_MESSAGE = `[PERSISTENT MODE PAUSED - NO TOOL PROGRESS] The last ${THINKING_ONLY_STREAK_MAX} assistant turns ` +
    'produced only thinking with no tool calls, so the persistent-mode stop guard is releasing this ' +
    'stop to avoid an infinite loop. Resume manually with a concrete next action (run a tool/command) ' +
    'or /cancel the active mode.';
/**
 * Does a user-role transcript record carry a tool_result block? A tool_result
 * only exists because the assistant invoked a tool earlier in the same turn, so
 * its presence proves the most recent assistant turn made tool progress.
 */
function userRecordHasToolResult(content) {
    if (!Array.isArray(content))
        return false;
    return content.some((block) => block?.type === 'tool_result');
}
/**
 * Classify the most recent assistant *turn* in a transcript as making tool
 * progress, being thinking-only, or indeterminate. A turn spans every assistant
 * record (and interleaved tool_result records) back to the preceding real user
 * message, so a productive turn whose final record is plain text — tool_use
 * earlier, trailing text before stop — still classifies as tool_use rather than
 * leaking through as indeterminate.
 *
 * Reads only the bounded transcript tail (never the whole file) and treats any
 * unreadable/ambiguous shape as indeterminate so callers fail open.
 */
function classifyLastAssistantTurn(transcriptPath) {
    let lines;
    try {
        lines = readTranscriptTailLines(transcriptPath);
    }
    catch {
        return 'indeterminate';
    }
    let sawAssistant = false;
    let hasThinking = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // Skip non-JSON/truncated lines and keep scanning backward.
            continue;
        }
        const role = parsed?.message?.role;
        const isAssistant = parsed?.type === 'assistant' || role === 'assistant';
        if (isAssistant) {
            sawAssistant = true;
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    const blockType = block?.type;
                    if (blockType === 'tool_use') {
                        // Any tool_use anywhere in the most recent turn is real progress.
                        return 'tool_use';
                    }
                    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                        hasThinking = true;
                    }
                }
            }
            // Non-array (string/missing) content carries no structured block; keep
            // scanning the rest of the turn rather than bailing out early.
            continue;
        }
        const isUser = parsed?.type === 'user' || role === 'user';
        if (isUser) {
            // A tool_result confirms the turn invoked a tool, so it made progress.
            if (userRecordHasToolResult(parsed.message?.content)) {
                return 'tool_use';
            }
            // A real user message marks the start of the most recent assistant turn.
            break;
        }
        // Other record types (system/summary/…) are turn-neutral; keep scanning.
    }
    if (!sawAssistant)
        return 'indeterminate';
    return hasThinking ? 'thinking_only' : 'indeterminate';
}
/**
 * Bound persistent-mode continuation loops that make no tool progress.
 *
 * Only acts when a mode would otherwise block the stop. A tool_use turn resets
 * the streak; a thinking-only turn increments it and, once it reaches
 * THINKING_ONLY_STREAK_MAX, releases the stop (and clears the counter) instead
 * of re-injecting another continuation prompt. Indeterminate/unreadable
 * transcripts leave the streak untouched and keep the original blocking result.
 */
function applyThinkingOnlyStreakGuard(result, workingDir, sessionId, stopContext) {
    // Non-blocking results already let the session stop — no loop to bound.
    if (!result.shouldBlock)
        return result;
    const transcriptPath = stopContext?.transcript_path ?? stopContext?.transcriptPath;
    if (!transcriptPath || !existsSync(transcriptPath)) {
        return result; // fail open: cannot classify without a transcript
    }
    let classification;
    try {
        classification = classifyLastAssistantTurn(transcriptPath);
    }
    catch {
        return result; // fail open on any unexpected read/parse error
    }
    if (classification === 'tool_use') {
        // Real progress — reset the streak and keep enforcing.
        writeStopBreaker(workingDir, THINKING_ONLY_STREAK_BREAKER, 0, sessionId);
        return result;
    }
    if (classification === 'indeterminate') {
        // Cannot confirm a thinking-only stall — keep enforcing, leave streak as is.
        return result;
    }
    const streak = readStopBreaker(workingDir, THINKING_ONLY_STREAK_BREAKER, sessionId, THINKING_ONLY_STREAK_TTL_MS) + 1;
    if (streak >= THINKING_ONLY_STREAK_MAX) {
        // Bail out: release the stop and clear the counter for a clean restart.
        writeStopBreaker(workingDir, THINKING_ONLY_STREAK_BREAKER, 0, sessionId);
        return {
            shouldBlock: false,
            message: THINKING_ONLY_STREAK_BAILOUT_MESSAGE,
            mode: 'none',
        };
    }
    writeStopBreaker(workingDir, THINKING_ONLY_STREAK_BREAKER, streak, sessionId);
    return result;
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
async function checkTeamPipeline(sessionId, directory, cancelInProgress) {
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
        ?? teamState.current_phase
        ?? teamState.currentStage
        ?? teamState.current_stage
        ?? teamState.stage;
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
    const rawStatus = teamState.status;
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
function getAutoresearchDeadlineMs(state) {
    if (typeof state.deadline_at === 'string' && state.deadline_at.trim().length > 0) {
        const parsed = new Date(state.deadline_at).getTime();
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    if (typeof state.max_runtime_ms === 'number' && Number.isFinite(state.max_runtime_ms)
        && typeof state.started_at === 'string' && state.started_at.trim().length > 0) {
        const startedAt = new Date(state.started_at).getTime();
        if (Number.isFinite(startedAt)) {
            return startedAt + state.max_runtime_ms;
        }
    }
    return null;
}
async function checkAutoresearch(sessionId, directory, cancelInProgress) {
    const workingDir = resolveToWorktreeRoot(directory);
    let stateSourceSessionId = sessionId;
    let state = readModeState('autoresearch', workingDir, sessionId);
    // Autoresearch predates session-scoped state files. Preserve strict sessioned reads
    // first, then allow a narrow legacy/shared bridge only for matching or unbound state.
    if (!state && sessionId) {
        const legacyState = readModeState('autoresearch', workingDir);
        if (!legacyState?.session_id || legacyState.session_id === sessionId) {
            state = legacyState;
            stateSourceSessionId = undefined;
        }
    }
    const stateRecord = state;
    const hasTimestampFields = Boolean(stateRecord
        && ['updated_at', 'started_at'].some((key) => typeof stateRecord[key] === 'string' && String(stateRecord[key]).length > 0));
    if (!state || !state.active || (hasTimestampFields && isStaleState(state))) {
        return null;
    }
    if (sessionId && state.session_id && state.session_id !== sessionId) {
        return null;
    }
    if (cancelInProgress) {
        return {
            shouldBlock: false,
            message: '',
            mode: 'autoresearch',
        };
    }
    const phase = typeof state.current_phase === 'string'
        ? state.current_phase.trim().toLowerCase()
        : '';
    if (phase === 'completed' || phase === 'failed' || phase === 'stopped' || phase === 'cancelled') {
        return {
            shouldBlock: false,
            message: '',
            mode: 'autoresearch',
        };
    }
    const deadlineMs = getAutoresearchDeadlineMs(state);
    if (deadlineMs != null && Date.now() >= deadlineMs) {
        writeModeState('autoresearch', {
            ...state,
            active: false,
            current_phase: 'stopped',
            completed_at: new Date().toISOString(),
            stop_reason: 'max-runtime ceiling reached',
        }, workingDir, stateSourceSessionId);
        return {
            shouldBlock: false,
            message: '[AUTORESEARCH COMPLETE] Max-runtime ceiling reached. Stop hook released the stateful autoresearch run.',
            mode: 'autoresearch',
            metadata: {
                iteration: typeof state.iteration === 'number' ? state.iteration : undefined,
            },
        };
    }
    const remaining = deadlineMs == null
        ? 'unknown'
        : `${Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))}s`;
    const missionSlug = typeof state.mission_slug === 'string' && state.mission_slug
        ? state.mission_slug
        : 'unknown-mission';
    return {
        shouldBlock: true,
        message: `<autoresearch-continuation>

[AUTORESEARCH - STATEFUL MISSION ACTIVE]
Mission: ${missionSlug}
The autoresearch loop is still active and should continue iterating.
Do not stop just because the latest evaluation did not pass.
Strict stop boundary: explicit max-runtime ceiling.
Remaining runtime: ${remaining}

</autoresearch-continuation>

---
`,
        mode: 'autoresearch',
        metadata: {
            iteration: typeof state.iteration === 'number' ? state.iteration : undefined,
            phase: state.current_phase,
        },
    };
}
function getNormalizedRalplanPhase(state) {
    if (!state || typeof state !== 'object') {
        return null;
    }
    const rawPhase = state.current_phase ?? state.phase ?? state.status;
    if (typeof rawPhase !== 'string') {
        return null;
    }
    const phase = rawPhase.trim().toLowerCase();
    if (!phase) {
        return null;
    }
    if (phase === 'handoff' || phase.startsWith('handoff:') || phase.startsWith('handoff-')) {
        return 'handoff';
    }
    return phase;
}
/**
 * Check Ralplan state for standalone ralplan mode enforcement.
 * Ralplan state is written by the MCP state_write tool.
 * `active`, `session_id`, and the normalized phase/status fields are used for blocking decisions.
 */
async function checkRalplan(sessionId, directory, cancelInProgress) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readModeState('ralplan', workingDir, sessionId);
    const stateRecord = state;
    const hasTimestampFields = Boolean(stateRecord &&
        ['last_checked_at', 'updated_at', 'started_at'].some((key) => typeof stateRecord[key] === 'string' && String(stateRecord[key]).length > 0));
    // Session-scoped ralplan state can legitimately omit timestamps in CI.
    // Only apply stale-state suppression when a freshness timestamp exists.
    if (!state || !state.active || (hasTimestampFields && isStaleState(state))) {
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
    const currentPhase = getNormalizedRalplanPhase(state);
    if (currentPhase && RALPLAN_TERMINAL_PHASES.has(currentPhase)) {
        writeStopBreaker(workingDir, 'ralplan', 0, sessionId);
        return { shouldBlock: false, message: '', mode: 'ralplan' };
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
    const hasFreshActiveAgentState = Number.isFinite(activeAgentStateUpdatedAt)
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
        // Deactivate the stale ralplan state so a later Stop event cannot start a
        // brand-new reinforcement cycle (30/30 -> 1/30) after the workflow has
        // already exhausted its breaker budget.
        state.active = false;
        state.deactivated_reason = 'stop_breaker_exhausted';
        state.completed_at = new Date().toISOString();
        writeModeState('ralplan', state, workingDir, sessionId);
        return {
            shouldBlock: false,
            message: `[RALPLAN CIRCUIT BREAKER] Stop enforcement exceeded ${RALPLAN_STOP_BLOCKER_MAX} reinforcements. Allowing stop and deactivating stale ralplan state to prevent infinite restart loops.`,
            mode: 'ralplan'
        };
    }
    writeStopBreaker(workingDir, 'ralplan', breakerCount, sessionId);
    return {
        shouldBlock: true,
        message: `<ralplan-continuation>

[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${breakerCount}/${RALPLAN_STOP_BLOCKER_MAX}]

The ralplan consensus workflow is active. Continue the Planner/Architect/Critic planning loop only.
Ralplan is read-only/planning mode: do not implement, invoke execution skills, edit source, commit, push, or open PRs from this continuation.
When consensus is reached, stop at a pending-approval handoff and require explicit user approval before execution.
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
async function checkUltrawork(sessionId, directory, _hasIncompleteTodos, cancelInProgress) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readUltraworkState(workingDir, sessionId);
    if (!state || !state.active || isStaleState(state)) {
        return null;
    }
    // Session isolation. `readUltraworkState()` already enforces the lenient
    // form ("only reject when BOTH sides have defined session_ids that
    // differ"). The previous strict check rejected legitimate cases where
    // one side was undefined — same root cause as the ralph counter bug.
    if (state.session_id && sessionId && state.session_id !== sessionId) {
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
    // If all tracked work is complete, auto-deactivate ultrawork and allow exit.
    // Issue #2419: otherwise the Stop hook can keep blocking even after task
    // completion, leaving ultrawork active until manual /cancel or session-end.
    if (!_hasIncompleteTodos) {
        deactivateUltrawork(workingDir, sessionId);
        return {
            shouldBlock: false,
            message: '[ULTRAWORK COMPLETE] No incomplete tasks remain. Ultrawork state cleared.',
            mode: 'none'
        };
    }
    // Enforce hard max iterations for ultrawork (mirrors ralph enforcement).
    const hardMax = getHardMaxIterations();
    if (hardMax > 0 && state.reinforcement_count >= hardMax) {
        deactivateUltrawork(workingDir, sessionId);
        return {
            shouldBlock: true,
            message: '[ULTRAWORK - HARD LIMIT] Reached hard max iterations (' + hardMax + '). Mode auto-disabled. Restart with /oh-my-claudecode:ultrawork if needed.',
            mode: 'ultrawork',
            metadata: { reinforcementCount: state.reinforcement_count }
        };
    }
    // Reinforce ultrawork mode while incomplete work remains.
    // This prevents false stops from bash errors or transient failures mid-task.
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
async function _checkTodoContinuation(sessionId, directory) {
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
 * Main persistent mode checker.
 * Resolves which mode (if any) should block, then applies the thinking-only
 * streak guard so an active mode cannot loop forever re-injecting continuation
 * prompts while the agent only emits thinking blocks and never tool_use (#3280).
 */
export async function checkPersistentModes(sessionId, directory, stopContext // NEW: from todo-continuation types
) {
    const result = await resolvePersistentModeBlock(sessionId, directory, stopContext);
    return applyThinkingOnlyStreakGuard(result, resolveToWorktreeRoot(directory), sessionId, stopContext);
}
/**
 * Resolve which persistent mode (if any) should block this stop event.
 * Checks all persistent modes in priority order and returns appropriate action.
 */
async function resolvePersistentModeBlock(sessionId, directory, stopContext // NEW: from todo-continuation types
) {
    const workingDir = resolveToWorktreeRoot(directory);
    // Hard bypass invariants: never enforce stop continuation under any of these
    // environment-level kill switches. bridge.ts also guards DISABLE_OMC and
    // OMC_SKIP_HOOKS at hook-entry, but we re-check here so direct callers and
    // nested helpers (team workers, tests) observe the same contract.
    if (process.env.DISABLE_OMC === '1' ||
        process.env.DISABLE_OMC === 'true' ||
        process.env.OMC_TEAM_WORKER) {
        return { shouldBlock: false, message: '', mode: 'none' };
    }
    const skipHooks = (process.env.OMC_SKIP_HOOKS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (skipHooks.includes('persistent-mode') || skipHooks.includes('stop-continuation')) {
        return { shouldBlock: false, message: '', mode: 'none' };
    }
    // Best-effort: keep the workflow-slot ledger aligned with terminal mode
    // state before using it for stop-gating authority. This both prunes old
    // tombstones and tombstones live slots whose autopilot/Ralph/ralplan mode
    // state already reached a terminal/inactive state through a path other than
    // the Skill PostToolUse completion hook.
    await reconcileTerminalWorkflowSlots(workingDir, sessionId);
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
    // Session-scoped cancel signals are authenticated against the current
    // autopilot generation while its mutation lock is held.
    const cancelCheck = isSessionCancelInProgress(workingDir, sessionId);
    const cancelInProgress = cancelCheck.nonAutopilotCancellation;
    if (cancelCheck.autopilotCancellation) {
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
    // CRITICAL: Never block scheduled wake-up resumptions.
    // Native ScheduleWakeup-triggered `/loop` turns are resumptions, not signals
    // to continue or clean up a prior persistent mode. Re-enforcing here can
    // inject `/cancel` guidance from stale state and cause the scheduled turn to
    // cancel itself before the real work runs.
    if (isScheduledWakeupStop(stopContext)) {
        return {
            shouldBlock: false,
            message: '',
            mode: 'none'
        };
    }
    // Oversized tool outputs can cause Claude Code to end the current turn after
    // redirecting the payload to a `tool-results/*.txt` file pointer. That stop is
    // not a real idle/stall signal: injecting a visible Ralph/Ultrawork/todo
    // continuation banner immediately after the redirect spams the transcript
    // while the agent is still mid-task. Suppress only a small consecutive window
    // of such redirects; if redirects keep repeating, fall through to the normal
    // persistence checks so genuine stalls still get re-enforced.
    if (isOversizeToolResultRedirectStop(stopContext)) {
        const redirectStopCount = readStopBreaker(workingDir, 'oversize-tool-result-redirect', sessionId, OVERSIZE_TOOL_RESULT_REDIRECT_STOP_TTL_MS) + 1;
        writeStopBreaker(workingDir, 'oversize-tool-result-redirect', redirectStopCount, sessionId);
        if (redirectStopCount <= OVERSIZE_TOOL_RESULT_REDIRECT_STOP_MAX) {
            return {
                shouldBlock: false,
                message: '',
                mode: 'none'
            };
        }
    }
    else {
        writeStopBreaker(workingDir, 'oversize-tool-result-redirect', 0, sessionId);
    }
    // If this session owns pending async work, quiescence is intentional: Claude
    // Code will notify on background completion or resume via ScheduleWakeup.
    // Do not convert that waiting window into a Ralph/persistent-mode stall loop.
    if (hasPendingOwnedAsyncWork(workingDir, sessionId)) {
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
    // Consult the workflow ledger ONCE before direct mode-priority shortcuts.
    // `resolveAuthoritativeWorkflowSkill()` returns the root of the live chain
    // (autopilot in `autopilot → ralph`), so stop enforcement bubbles up to the
    // live parent rather than the child currently executing beneath it.
    // Tombstoned slots are tracked separately so stale mode files from crashed
    // sessions don't re-arm priority checks until TTL prune or fresh activation.
    const tombstonedWorkflowModes = new Set();
    let workflowAuthority = null;
    try {
        const { readSkillActiveStateNormalized, resolveAuthoritativeWorkflowSkill } = await import('../skill-state/index.js');
        const ledger = readSkillActiveStateNormalized(workingDir, sessionId);
        const authority = resolveAuthoritativeWorkflowSkill(ledger);
        workflowAuthority = authority?.skill_name ?? null;
        for (const [name, slot] of Object.entries(ledger.active_skills)) {
            if (slot.completed_at)
                tombstonedWorkflowModes.add(name);
        }
    }
    catch {
        // Ledger unavailable — fall back to legacy mode-file detection.
    }
    // Authority-first ordering for nested workflow runs.
    //
    // `resolveAuthoritativeWorkflowSkill()` returns the root of the live chain.
    // In `autopilot → ralph`, autopilot is the authoritative parent while ralph
    // runs beneath it — stop enforcement must resolve to the live parent so its
    // iteration accounting keeps advancing. The legacy ordering (ralph > autopilot)
    // still applies whenever the ledger is silent or authority already is ralph.
    const autopilotPriorityFirst = workflowAuthority === 'autopilot';
    const runAutopilotPriority = async () => {
        if (tombstonedWorkflowModes.has('autopilot') ||
            !(cancelCheck.enforceableAutopilot || isAutopilotActive(workingDir, sessionId))) {
            return null;
        }
        const autopilotResult = await checkAutopilot(sessionId, workingDir);
        if (!autopilotResult)
            return null;
        const isNamedDiagnostic = autopilotResult.message === 'workflow_descriptor_integrity_failed' ||
            autopilotResult.message.startsWith('[AUTOPILOT NAMED WORKFLOW UNSUPPORTED]');
        if (!autopilotResult.shouldBlock && !isNamedDiagnostic)
            return null;
        return {
            shouldBlock: autopilotResult.shouldBlock,
            message: autopilotResult.message,
            mode: 'autopilot',
            metadata: {
                iteration: autopilotResult.metadata?.iteration,
                maxIterations: autopilotResult.metadata?.maxIterations,
                phase: autopilotResult.phase,
                tasksCompleted: autopilotResult.metadata?.tasksCompleted,
                tasksTotal: autopilotResult.metadata?.tasksTotal,
                toolError: autopilotResult.metadata?.toolError,
            },
        };
    };
    const runRalphPriority = async () => {
        // Skip when the authoritative registry says Ralph is inactive. This keeps
        // Stop enforcement aligned with state_list_active and ignores stale
        // restored/cache artifacts (including tombstoned workflow slots) after
        // cancel/state_clear has made the registry empty.
        if (tombstonedWorkflowModes.has('ralph') || !isModeActive('ralph', workingDir, sessionId))
            return null;
        return checkRalphLoop(sessionId, workingDir, cancelInProgress);
    };
    if (cancelInProgress) {
        // Requested-at-only signals may cancel Ralph/Ultrawork, never autopilot.
        // Recheck autopilot after signal consumption so an active replacement wins.
        const autopilotResult = await runAutopilotPriority();
        // Terminal named diagnostics are not enforceable autopilot targets and
        // must not alter the established generic-cancellation result contract.
        if (autopilotResult?.shouldBlock)
            return autopilotResult;
        return {
            shouldBlock: false,
            message: '',
            mode: 'none',
        };
    }
    if (autopilotPriorityFirst) {
        const autopilotResult = await runAutopilotPriority();
        if (autopilotResult)
            return autopilotResult;
        const ralphResult = await runRalphPriority();
        if (ralphResult)
            return ralphResult;
    }
    else {
        const ralphResult = await runRalphPriority();
        if (ralphResult)
            return ralphResult;
        const autopilotResult = await runAutopilotPriority();
        if (autopilotResult)
            return autopilotResult;
    }
    // Priority 1.6: Autoresearch (stateful single-mission runtime)
    const autoresearchResult = await checkAutoresearch(sessionId, workingDir, cancelInProgress);
    if (autoresearchResult) {
        return autoresearchResult;
    }
    // Priority 1.7: Ralplan (standalone consensus planning)
    // Ralplan consensus loops (Planner/Architect/Critic) need hard-blocking.
    // When ralplan runs under ralph, checkRalphLoop() handles it (Priority 1).
    // Return ANY non-null result (including circuit breaker shouldBlock=false with message).
    // Suppressed when the ralplan slot is tombstoned so noisy re-handoff stops
    // on completion until the tombstone TTL expires or a fresh slot reopens.
    if (!tombstonedWorkflowModes.has('ralplan')) {
        const ralplanResult = await checkRalplan(sessionId, workingDir, cancelInProgress);
        if (ralplanResult) {
            return ralplanResult;
        }
    }
    // Priority 1.8: Team Pipeline (standalone team mode)
    // When team runs without ralph, this provides stop-hook blocking.
    // When team runs with ralph, checkRalphLoop() handles it (Priority 1).
    // Return ANY non-null result (including circuit breaker shouldBlock=false with message).
    if (!tombstonedWorkflowModes.has('team')) {
        const teamResult = await checkTeamPipeline(sessionId, workingDir, cancelInProgress);
        if (teamResult) {
            return teamResult;
        }
    }
    // Priority 2: Ultrawork Mode (performance mode with persistence)
    if (!tombstonedWorkflowModes.has('ultrawork') && isModeActive('ultrawork', workingDir, sessionId)) {
        const ultraworkResult = await checkUltrawork(sessionId, workingDir, hasIncompleteTodos, cancelInProgress);
        if (ultraworkResult) {
            return ultraworkResult;
        }
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
                mode: 'ultrawork', // Reuse ultrawork mode type for compatibility
                metadata: {
                    phase: `skill:${skillResult.skillName || 'unknown'}`,
                }
            };
        }
    }
    catch {
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
export function createHookOutput(result) {
    return {
        continue: !result.shouldBlock,
        message: result.message || undefined
    };
}
//# sourceMappingURL=index.js.map