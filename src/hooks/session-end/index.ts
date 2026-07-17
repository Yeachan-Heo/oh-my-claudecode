import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { runSessionEndDeferredAction } from './callbacks.js';
import { getOMCConfig } from '../../features/auto-update.js';
import { buildConfigFromEnv, getEnabledPlatforms, getNotificationConfig } from '../../notifications/config.js';
import type { NotificationPlatform } from '../../notifications/types.js';
import { cleanupBridgeSessions } from '../../tools/python-repl/bridge-manager.js';
import { resolveToWorktreeRoot, getOmcRoot, validateSessionId, isValidTranscriptPath, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import { SESSION_END_MODE_STATE_FILES, SESSION_METRICS_MODE_FILES } from '../../lib/mode-names.js';
import { clearModeStateFile, readModeState } from '../../lib/mode-state-io.js';
import { completeForegroundCleanup, completeForegroundCleanupAndSealCore, prepareCoreManifest, readSessionEndJob, sealWikiManifest } from './cleanup-manifest.js';
import { spawnSessionEndWorker } from './worker.js';
import { buildWikiSessionEndCaptureIntent } from '../wiki/session-hooks.js';

export interface SessionEndInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'SessionEnd';
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

export interface SessionMetrics {
  session_id: string;
  started_at?: string;
  ended_at: string;
  reason: string;
  duration_ms?: number;
  agents_spawned: number;
  agents_completed: number;
  modes_used: string[];
}

export interface HookOutput {
  continue: boolean;
}

interface SessionOwnedTeamCleanupResult {
  attempted: string[];
  cleaned: string[];
  failed: Array<{ teamName: string; error: string }>;
}

type LegacyStopCallbackPlatform = 'file' | 'telegram' | 'discord';
const SESSION_STARTED_MARKER_FILE = 'session-started.json';

const DEFAULT_SESSION_END_CLEANUP_BUDGET_MS = 2_000;
const MAX_SESSION_END_CLEANUP_BUDGET_MS = 10_000;
const SESSION_END_CLEANUP_BUDGET_ENV = 'OMC_SESSIONEND_CLEANUP_BUDGET_MS';

export interface SessionEndCleanupWorkerPayload {
  directory: string;
  sessionId: string;
  transcriptPath: string;
  cleanupBudgetMs: number;
  initialTeamNames?: string[];
}


const SESSION_END_SAFE_TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeSessionEndTeamName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!SESSION_END_SAFE_TEAM_NAME_PATTERN.test(trimmed)) return null;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}


export function resolveSessionEndCleanupBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SESSION_END_CLEANUP_BUDGET_ENV];
  if (raw == null || raw.trim() === '') {
    return DEFAULT_SESSION_END_CLEANUP_BUDGET_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SESSION_END_CLEANUP_BUDGET_MS;
  }

  return Math.min(Math.floor(parsed), MAX_SESSION_END_CLEANUP_BUDGET_MS);
}


function hasExplicitNotificationConfig(profileName?: string): boolean {
  const config = getOMCConfig();

  if (profileName) {
    const profile = config.notificationProfiles?.[profileName];
    if (profile && typeof profile.enabled === 'boolean') {
      return true;
    }
  }

  if (config.notifications && typeof config.notifications.enabled === 'boolean') {
    return true;
  }

  return buildConfigFromEnv() !== null;
}

function getLegacyPlatformsCoveredByNotifications(
  enabledPlatforms: NotificationPlatform[]
): LegacyStopCallbackPlatform[] {
  const overlappingPlatforms: LegacyStopCallbackPlatform[] = [];

  if (enabledPlatforms.includes('telegram')) {
    overlappingPlatforms.push('telegram');
  }

  if (enabledPlatforms.includes('discord')) {
    overlappingPlatforms.push('discord');
  }

  return overlappingPlatforms;
}

/**
 * Read agent tracking to get spawn/completion counts
 */
function getAgentCounts(directory: string): { spawned: number; completed: number } {
  const trackingPath = path.join(getOmcRoot(directory), 'state', 'subagent-tracking.json');

  if (!fs.existsSync(trackingPath)) {
    return { spawned: 0, completed: 0 };
  }

  try {
    const content = fs.readFileSync(trackingPath, 'utf-8');
    const tracking = JSON.parse(content);

    interface AgentTrackingEntry { status: string }
    const spawned = tracking.agents?.length || 0;
    const completed = tracking.agents?.filter((a: AgentTrackingEntry) => a.status === 'completed').length || 0;

    return { spawned, completed };
  } catch (_error) {
    return { spawned: 0, completed: 0 };
  }
}

/**
 * Detect which modes were used during the session
 */
function getModesUsed(directory: string): string[] {
  const stateDir = path.join(getOmcRoot(directory), 'state');
  const modes: string[] = [];

  if (!fs.existsSync(stateDir)) {
    return modes;
  }

  for (const { file, mode } of SESSION_METRICS_MODE_FILES) {
    const statePath = path.join(stateDir, file);
    if (fs.existsSync(statePath)) {
      modes.push(mode);
    }
  }

  return modes;
}

/**
 * Get session start time from state files.
 *
 * When sessionId is provided, only state files whose session_id matches are
 * considered.  State files that carry a *different* session_id are treated as
 * stale leftovers and skipped — this is the fix for issue #573 where stale
 * state files caused grossly overreported session durations.
 *
 * Legacy state files (no session_id field) are used as a fallback so that
 * older state formats still work.
 *
 * When multiple files match, the earliest started_at is returned so that
 * duration reflects the full session span (e.g. autopilot started before
 * ultrawork).
 */
export function getSessionStartTime(directory: string, sessionId?: string): string | undefined {
  const stateDir = path.join(getOmcRoot(directory), 'state');

  if (!fs.existsSync(stateDir)) {
    return undefined;
  }

  const stateFiles = fs.readdirSync(stateDir).filter(f => f.endsWith('.json'));

  let matchedStartTime: string | undefined;
  let matchedEpoch = Infinity;
  let legacyStartTime: string | undefined;
  let legacyEpoch = Infinity;

  for (const file of stateFiles) {
    try {
      const statePath = path.join(stateDir, file);
      const content = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content);

      if (!state.started_at) {
        continue;
      }

      const ts = Date.parse(state.started_at);
      if (!Number.isFinite(ts)) {
        continue; // skip invalid / malformed timestamps
      }

      if (sessionId && state.session_id === sessionId) {
        // State belongs to the current session — prefer earliest
        if (ts < matchedEpoch) {
          matchedEpoch = ts;
          matchedStartTime = state.started_at;
        }
      } else if (!state.session_id) {
        // Legacy state without session_id — fallback only
        if (ts < legacyEpoch) {
          legacyEpoch = ts;
          legacyStartTime = state.started_at;
        }
      }
      // else: state has a different session_id — stale, skip
    } catch (_error) {
      continue;
    }
  }

  return matchedStartTime ?? legacyStartTime;
}

/**
 * Record session metrics
 */
export function recordSessionMetrics(directory: string, input: SessionEndInput): SessionMetrics {
  const endedAt = new Date().toISOString();
  const startedAt = getSessionStartTime(directory, input.session_id);
  const { spawned, completed } = getAgentCounts(directory);
  const modesUsed = getModesUsed(directory);

  const metrics: SessionMetrics = {
    session_id: input.session_id,
    started_at: startedAt,
    ended_at: endedAt,
    reason: input.reason,
    agents_spawned: spawned,
    agents_completed: completed,
    modes_used: modesUsed,
  };

  // Calculate duration if start time is available
  if (startedAt) {
    try {
      const startTime = new Date(startedAt).getTime();
      const endTime = new Date(endedAt).getTime();
      metrics.duration_ms = endTime - startTime;
    } catch (_error) {
      // Invalid date, skip duration
    }
  }

  return metrics;
}

/**
 * Clean up transient state files.
 *
 * @param directory - Worktree root (or any path under it).
 * @param endingSessionId - Optional id of the session that is ending.
 *   When provided, per-session transient caches (HUD stdin cache) are
 *   removed only from that session's directory so other concurrent
 *   sessions keep their live state. When omitted (e.g. legacy callers
 *   or tests), the previous behavior is preserved for compatibility.
 */
export function cleanupTransientState(directory: string, endingSessionId?: string): number {
  let filesRemoved = 0;
  const omcDir = getOmcRoot(directory);

  if (!fs.existsSync(omcDir)) {
    return filesRemoved;
  }

  // Remove transient agent tracking
  const trackingPath = path.join(omcDir, 'state', 'subagent-tracking.json');
  if (fs.existsSync(trackingPath)) {
    try {
      fs.unlinkSync(trackingPath);
      filesRemoved++;
    } catch (_error) {
      // Ignore removal errors
    }
  }

  // Clean stale checkpoints (older than 24 hours)
  const checkpointsDir = path.join(omcDir, 'checkpoints');
  if (fs.existsSync(checkpointsDir)) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    try {
      const files = fs.readdirSync(checkpointsDir);
      for (const file of files) {
        const filePath = path.join(checkpointsDir, file);
        const stats = fs.statSync(filePath);

        if (stats.mtimeMs < oneDayAgo) {
          fs.unlinkSync(filePath);
          filesRemoved++;
        }
      }
    } catch (_error) {
      // Ignore cleanup errors
    }
  }

  // Remove .tmp files in .omc/
  const removeTmpFiles = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          removeTmpFiles(fullPath);
        } else if (entry.name.endsWith('.tmp')) {
          fs.unlinkSync(fullPath);
          filesRemoved++;
        }
      }
    } catch (_error) {
      // Ignore errors
    }
  };

  removeTmpFiles(omcDir);

  // Remove transient state files that accumulate across sessions
  const stateDir = path.join(omcDir, 'state');
  if (fs.existsSync(stateDir)) {
    const transientPatterns = [
      /^agent-replay-.*\.jsonl$/,
      /^last-tool-error\.json$/,
      /^hud-state\.json$/,
      /^hud-stdin-cache\.json$/,
      /^idle-notif-cooldown\.json$/,
      /^.*-stop-breaker\.json$/,
    ];

    try {
      const stateFiles = fs.readdirSync(stateDir);
      for (const file of stateFiles) {
        if (transientPatterns.some(p => p.test(file))) {
          try {
            fs.unlinkSync(path.join(stateDir, file));
            filesRemoved++;
          } catch (_error) {
            // Ignore removal errors
          }
        }
      }
    } catch (_error) {
      // Ignore errors
    }

    // Clean up cancel signal files, stale per-session transient caches,
    // and empty session directories.
    const sessionsDir = path.join(stateDir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      // Patterns that are safe to delete across every session dir:
      // these are short-lived markers/breakers that do not represent
      // live per-session state an active concurrent session is reading.
      const crossSessionSafePatterns = [
        /^cancel-signal/,
        /stop-breaker/,
      ];
      // Patterns that must only be deleted from the session that is
      // actually ending — deleting them from a still-running session
      // would reintroduce cross-session interference.
      const endingSessionOnlyPatterns = [
        // HUD's stdin cache is session-scoped (see `src/hud/stdin.ts`)
        // and consumed by `omc hud --watch` for the owning session.
        /^hud-stdin-cache\.json$/,
      ];
      const isEndingSession = (sid: string): boolean =>
        typeof endingSessionId === 'string'
        && endingSessionId.length > 0
        && sid === endingSessionId;
      try {
        const sessionDirs = fs.readdirSync(sessionsDir);
        for (const sid of sessionDirs) {
          const sessionDir = path.join(sessionsDir, sid);
          try {
            const stat = fs.statSync(sessionDir);
            if (!stat.isDirectory()) continue;

            const activePatterns = isEndingSession(sid)
              ? [...crossSessionSafePatterns, ...endingSessionOnlyPatterns]
              : crossSessionSafePatterns;

            const sessionFiles = fs.readdirSync(sessionDir);
            for (const file of sessionFiles) {
              if (activePatterns.some(p => p.test(file))) {
                try {
                  fs.unlinkSync(path.join(sessionDir, file));
                  filesRemoved++;
                } catch (_error) { /* ignore */ }
              }
            }

            // Remove empty session directories
            const remaining = fs.readdirSync(sessionDir);
            if (remaining.length === 0) {
              try {
                fs.rmdirSync(sessionDir);
                filesRemoved++;
              } catch (_error) { /* ignore */ }
              }
          } catch (_error) {
            // Ignore per-session errors
          }
        }
      } catch (_error) {
        // Ignore errors
      }
    }
  }

  return filesRemoved;
}

/**
 * Mode state files that should be cleaned up on session end.
 * Imported from the shared mode-names module (issue #1058).
 */

const PYTHON_REPL_TOOL_NAMES = new Set(['python_repl', 'mcp__t__python_repl']);

/**
 * Extract python_repl research session IDs from transcript JSONL.
 * These sessions are terminated on SessionEnd to prevent bridge leaks.
 */
export async function extractPythonReplSessionIdsFromTranscript(transcriptPath: string): Promise<string[]> {
  // Security: validate transcript path is within allowed directories
  if (!transcriptPath || !isValidTranscriptPath(transcriptPath) || !fs.existsSync(transcriptPath)) {
    return [];
  }

  const sessionIds = new Set<string>();
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const entry = parsed as { message?: { content?: unknown[] } };
      const contentBlocks = entry.message?.content;
      if (!Array.isArray(contentBlocks)) {
        continue;
      }

      for (const block of contentBlocks) {
        const toolUse = block as {
          type?: string;
          name?: string;
          input?: { researchSessionID?: unknown };
        };

        if (toolUse.type !== 'tool_use' || !toolUse.name || !PYTHON_REPL_TOOL_NAMES.has(toolUse.name)) {
          continue;
        }

        const sessionId = toolUse.input?.researchSessionID;
        if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
          sessionIds.add(sessionId.trim());
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return [...sessionIds];
}

/**
 * Clean up mode state files on session end.
 *
 * This prevents stale state from causing the stop hook to malfunction
 * in subsequent sessions. When a session ends normally, all active modes
 * should be considered terminated.
 *
 * @param directory - The project directory
 * @param sessionId - Optional session ID to match. Only cleans states belonging to this session.
 * @returns Object with counts of files removed and modes cleaned
 */
export function cleanupModeStates(directory: string, sessionId?: string): { filesRemoved: number; modesCleaned: string[] } {
  let filesRemoved = 0;
  const modesCleaned: string[] = [];
  const stateDir = path.join(getOmcRoot(directory), 'state');

  if (!fs.existsSync(stateDir)) {
    return { filesRemoved, modesCleaned };
  }

  for (const { file, mode } of SESSION_END_MODE_STATE_FILES) {
    const localPath = path.join(stateDir, file);
    const sessionPath = sessionId ? resolveSessionStatePath(mode, sessionId, directory) : undefined;

    try {
      // For JSON files, check if active before removing
      if (file.endsWith('.json')) {
        const sessionState = sessionId
          ? readModeState<Record<string, unknown>>(mode, directory, sessionId)
          : null;

        let shouldCleanup = sessionState?.active === true;

        if (!shouldCleanup && fs.existsSync(localPath)) {
          const content = fs.readFileSync(localPath, 'utf-8');
          const state = JSON.parse(content);

          // Only clean if marked as active AND belongs to this session
          // (prevents removing other concurrent sessions' states)
          if (state.active === true) {
            // If sessionId is provided, only clean matching states
            // If state has no session_id, it's legacy - clean it
            // If state.session_id matches our sessionId, clean it
            const stateSessionId = state.session_id as string | undefined;
            if (!sessionId || !stateSessionId || stateSessionId === sessionId) {
              shouldCleanup = true;
            }
          }
        }

        if (shouldCleanup) {
          const hadLocalPath = fs.existsSync(localPath);
          const hadSessionPath = Boolean(sessionPath && fs.existsSync(sessionPath));

          if (clearModeStateFile(mode, directory, sessionId)) {
            if (hadLocalPath && !fs.existsSync(localPath)) {
              filesRemoved++;
            }
            if (sessionPath && hadSessionPath && !fs.existsSync(sessionPath)) {
              filesRemoved++;
            }
            if (!modesCleaned.includes(mode)) {
              modesCleaned.push(mode);
            }
          }
        }
      } else if (fs.existsSync(localPath)) {
        // For marker files, always remove
        fs.unlinkSync(localPath);
        filesRemoved++;
        if (!modesCleaned.includes(mode)) {
          modesCleaned.push(mode);
        }
      }
    } catch {
      // Ignore errors, continue with other files
    }
  }

  return { filesRemoved, modesCleaned };
}

/**
 * Clean up mission-state.json entries belonging to this session.
 * Without this, the HUD keeps showing stale mode/mission info after session end.
 *
 * When sessionId is provided, only removes missions whose source is 'session'
 * and whose id contains the sessionId. When sessionId is omitted, removes all
 * session-sourced missions.
 */
export function cleanupMissionState(directory: string, sessionId?: string): number {
  const missionStatePath = path.join(getOmcRoot(directory), 'state', 'mission-state.json');

  if (!fs.existsSync(missionStatePath)) {
    return 0;
  }

  try {
    const content = fs.readFileSync(missionStatePath, 'utf-8');
    const parsed = JSON.parse(content) as {
      updatedAt?: string;
      missions?: Array<Record<string, unknown>>;
    };

    if (!Array.isArray(parsed.missions)) {
      return 0;
    }

    const before = parsed.missions.length;
    parsed.missions = parsed.missions.filter((mission) => {
      // Keep non-session missions (e.g., team missions handled by state_clear)
      if (mission.source !== 'session') return true;

      // If sessionId provided, only remove missions for this session
      if (sessionId) {
        const missionId = typeof mission.id === 'string' ? mission.id : '';
        return !missionId.includes(sessionId);
      }

      // No sessionId: remove all session-sourced missions
      return false;
    });

    const removed = before - parsed.missions.length;
    if (removed > 0) {
      parsed.updatedAt = new Date().toISOString();
      fs.writeFileSync(missionStatePath, JSON.stringify(parsed, null, 2));
    }

    return removed;
  } catch {
    return 0;
  }
}

function cleanupSessionStartedMarker(directory: string, sessionId: string): void {
  try {
    validateSessionId(sessionId);
  } catch {
    return;
  }

  try {
    const markerPath = path.join(getOmcRoot(directory), 'state', 'sessions', sessionId, SESSION_STARTED_MARKER_FILE);
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // Best-effort marker cleanup only; SessionEnd cleanup must continue.
  }
}

function extractTeamNameFromState(state: Record<string, unknown> | null): string | null {
  if (!state || typeof state !== 'object') return null;
  return normalizeSessionEndTeamName(state.team_name ?? state.teamName);
}

async function findSessionOwnedTeams(directory: string, sessionId: string): Promise<string[]> {
  const teamNames = new Set<string>();
  const teamState = readModeState<Record<string, unknown>>('team', directory, sessionId);
  const stateTeamName = extractTeamNameFromState(teamState);
  if (stateTeamName) {
    teamNames.add(stateTeamName);
  }

  const teamRoot = path.join(getOmcRoot(directory), 'state', 'team');
  if (!fs.existsSync(teamRoot)) {
    return [...teamNames];
  }

  const { teamReadManifest } = await import('../../team/team-ops.js');

  try {
    const entries = fs.readdirSync(teamRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const teamName = entry.name;
      try {
        const manifest = await teamReadManifest(teamName, directory);
        if (manifest?.leader.session_id === sessionId) {
          teamNames.add(teamName);
        }
      } catch {
        // Ignore malformed team state and continue scanning.
      }
    }
  } catch {
    // Best-effort only — session end must not fail because team discovery failed.
  }

  return [...teamNames];
}

export async function cleanupSessionOwnedTeams(
  directory: string,
  sessionId: string,
  initialTeamNames: string[] = [],
): Promise<SessionOwnedTeamCleanupResult> {
  const attempted: string[] = [];
  const cleaned: string[] = [];
  const failed: Array<{ teamName: string; error: string }> = [];
  const discoveredTeamNames = await findSessionOwnedTeams(directory, sessionId);
  const teamNames = [
    ...new Set(
      [...initialTeamNames, ...discoveredTeamNames]
        .map(normalizeSessionEndTeamName)
        .filter((teamName): teamName is string => teamName !== null),
    ),
  ];

  if (teamNames.length === 0) {
    return { attempted, cleaned, failed };
  }

  const { teamReadConfig, teamCleanup } = await import('../../team/team-ops.js');
  const { shutdownTeamV2 } = await import('../../team/runtime-v2.js');
  const { shutdownTeam } = await import('../../team/runtime.js');

  await Promise.all(teamNames.map(async (teamName) => {
    attempted.push(teamName);
    try {
      const config = await teamReadConfig(teamName, directory) as unknown;
      if (!config || typeof config !== 'object') {
        await teamCleanup(teamName, directory);
        cleaned.push(teamName);
        return;
      }

      if (Array.isArray((config as { workers?: unknown[] }).workers)) {
        await shutdownTeamV2(teamName, directory, { force: true, timeoutMs: 0 });
        cleaned.push(teamName);
        return;
      }

      if (Array.isArray((config as { agentTypes?: unknown[] }).agentTypes)) {
        const legacyConfig = config as {
          tmuxSession?: string;
          leaderPaneId?: string | null;
          tmuxOwnsWindow?: boolean;
        };
        const sessionName = typeof legacyConfig.tmuxSession === 'string' && legacyConfig.tmuxSession.trim() !== ''
          ? legacyConfig.tmuxSession.trim()
          : `omc-team-${teamName}`;
        const leaderPaneId = typeof legacyConfig.leaderPaneId === 'string' && legacyConfig.leaderPaneId.trim() !== ''
          ? legacyConfig.leaderPaneId.trim()
          : undefined;
        await shutdownTeam(teamName, sessionName, directory, 0, undefined, leaderPaneId, legacyConfig.tmuxOwnsWindow === true);
        cleaned.push(teamName);
        return;
      }

      await teamCleanup(teamName, directory);
      cleaned.push(teamName);
    } catch (error) {
      failed.push({
        teamName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  return { attempted, cleaned, failed };
}

/**
 * Export session summary to .omc/sessions/
 */
export function exportSessionSummary(directory: string, metrics: SessionMetrics): void {
  const sessionsDir = path.join(getOmcRoot(directory), 'sessions');

  // Create sessions directory if it doesn't exist
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Validate session_id to prevent path traversal
  try {
    validateSessionId(metrics.session_id);
  } catch {
    // Invalid session_id - skip export to prevent path traversal
    return;
  }

  // Write session summary
  const sessionFile = path.join(sessionsDir, `${metrics.session_id}.json`);

  try {
    fs.writeFileSync(sessionFile, JSON.stringify(metrics, null, 2), 'utf-8');
  } catch (_error) {
    // Ignore write errors
  }
}



export async function cleanupSessionPython(directory: string, sessionId: string): Promise<void> {
  const manifest = prepareCoreManifest(directory, sessionId, {});
  const transcriptPath = typeof manifest?.actions['python-cleanup'].payload.transcriptPath === 'string'
    ? manifest.actions['python-cleanup'].payload.transcriptPath : '';
  const sessionIds = await extractPythonReplSessionIdsFromTranscript(transcriptPath);
  if (sessionIds.length > 0) {
    await cleanupBridgeSessions(sessionIds, { gracePeriodMs: 500, sigtermGraceMs: 500, finalWaitMs: 250, parallel: true });
  }
}

/** Compatibility export; durable ownership is handled by the manifest worker. */
export async function processSessionEndCleanupWorker(payload: SessionEndCleanupWorkerPayload): Promise<void> {
  await cleanupSessionPython(payload.directory, payload.sessionId);
}

export async function cleanupSessionReplies(sessionId: string): Promise<void> {
  const { removeSession, loadAllMappings } = await import('../../notifications/session-registry.js');
  if (!removeSession(sessionId)) throw new Error('reply-registry-remove-lock-failed');
  if (loadAllMappings().length === 0) {
    const { stopReplyListener } = await import('../../notifications/reply-listener.js');
    const result = await stopReplyListener();
    if (!result.success) throw new Error('reply-listener-stop-failed');
  }
}

function deferredSessionEndSnapshot(directory: string, sessionId: string): { metrics: SessionMetrics; input: { session_id: string; cwd: string; transcript_path?: string; reason?: string } } {
  const payload = readSessionEndJob(directory, sessionId)?.actions.callback.payload;
  const metrics = payload?.metrics as SessionMetrics | undefined;
  const input = payload?.input as { session_id?: unknown; cwd?: unknown; transcript_path?: unknown; reason?: unknown } | undefined;
  if (metrics && input?.session_id === sessionId && typeof input.cwd === 'string') {
    return { metrics, input: input as { session_id: string; cwd: string; transcript_path?: string; reason?: string } };
  }
  return {
    metrics: recordSessionMetrics(directory, { session_id: sessionId, transcript_path: '', cwd: directory, permission_mode: '', hook_event_name: 'SessionEnd', reason: 'other' }),
    input: { session_id: sessionId, cwd: directory },
  };
}

export async function runSessionEndCallbacks(directory: string, sessionId: string, idempotencyKey?: string, strict = false): Promise<void> {
  const { metrics, input } = deferredSessionEndSnapshot(directory, sessionId);
  const profileName = process.env.OMC_NOTIFY_PROFILE;
  const config = getNotificationConfig(profileName);
  const platforms = config && hasExplicitNotificationConfig(profileName) ? getEnabledPlatforms(config, 'session-end') : [];
  const outcome = await runSessionEndDeferredAction({ name: 'legacy-callback', class: 'best-effort', idempotencyKey, payload: { skipPlatforms: platforms.length > 0 ? getLegacyPlatformsCoveredByNotifications(platforms) : [], idempotencyKey }, budgetMs: 2_000 }, { directory, sessionId, transcriptPath: input.transcript_path ?? '', metrics, input, deadlineAt: new Date(Date.now() + 2_000).toISOString(), action: { name: 'legacy-callback', class: 'best-effort', idempotencyKey, payload: { idempotencyKey }, budgetMs: 2_000 } });
  if (strict && outcome.status !== 'completed' && outcome.status !== 'skipped') throw new Error(`legacy-callback-${outcome.status}`);
}

export async function runSessionEndNotifications(directory: string, sessionId: string, strict = false): Promise<void> {
  const profileName = process.env.OMC_NOTIFY_PROFILE;
  const config = getNotificationConfig(profileName);
  if (!config || !hasExplicitNotificationConfig(profileName)) return;
  const { metrics, input } = deferredSessionEndSnapshot(directory, sessionId);
  const outcome = await runSessionEndDeferredAction({ name: 'notification', class: 'best-effort', payload: { profileName }, budgetMs: 2_000 }, { directory, sessionId, transcriptPath: input.transcript_path ?? '', metrics, input, deadlineAt: new Date(Date.now() + 2_000).toISOString(), action: { name: 'notification', class: 'best-effort', payload: { profileName }, budgetMs: 2_000 } });
  if (strict && outcome.status !== 'completed' && outcome.status !== 'skipped') throw new Error(`notification-${outcome.status}`);
}

export async function runSessionEndOpenClaw(directory: string, sessionId: string, strict = false): Promise<void> {
  const { metrics, input } = deferredSessionEndSnapshot(directory, sessionId);
  const outcome = await runSessionEndDeferredAction({ name: 'openclaw-wake', class: 'best-effort', payload: { enabled: process.env.OMC_OPENCLAW === '1', reason: metrics.reason, sessionId }, budgetMs: 2_000 }, { directory, sessionId, transcriptPath: input.transcript_path ?? '', metrics, input, deadlineAt: new Date(Date.now() + 2_000).toISOString(), action: { name: 'openclaw-wake', class: 'best-effort', payload: {}, budgetMs: 2_000 } });
  if (strict && outcome.status !== 'completed' && outcome.status !== 'skipped') throw new Error(`openclaw-wake-${outcome.status}`);
}

/** Foreground cleanup has no network/process waits and records its result before the core producer is sealed. */
export async function runForegroundSessionEndCleanup(directory: string, sessionId: string, persistResult = true): Promise<Record<string, unknown>> {
  const removed = cleanupTransientState(directory, sessionId);
  cleanupModeStates(directory, sessionId);
  cleanupMissionState(directory, sessionId);
  cleanupSessionStartedMarker(directory, sessionId);
  const outcome = { removedTransientFiles: removed, completedAt: new Date().toISOString() };
  if (persistResult) {
    const completed = completeForegroundCleanup(directory, sessionId, outcome);
    if (!completed) throw new Error('foreground-cleanup-result-not-durable');
  }
  return outcome;
}

/** Foreground path: only durable local state and worker launch; deferred adapters are worker-owned. */
function buildDurableSessionEndPayload(directory: string, input: SessionEndInput, metrics: SessionMetrics): Record<string, unknown> {
  const teamState = readModeState<Record<string, unknown>>('team', directory, input.session_id);
  const teamName = extractTeamNameFromState(teamState);
  // Keep only routing identifiers and booleans: credentials remain in the inherited worker environment.
  return {
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    reason: input.reason,
    input,
    metrics,
    initialTeamNames: teamName ? [teamName] : [],
    notificationProfile: typeof process.env.OMC_NOTIFY_PROFILE === 'string' ? process.env.OMC_NOTIFY_PROFILE : undefined,
    openClawEnabled: process.env.OMC_OPENCLAW === '1',
  };
}

export async function processSessionEnd(input: SessionEndInput): Promise<HookOutput> {
  const directory = resolveToWorktreeRoot(input.cwd);
  const metrics = recordSessionMetrics(directory, input);
  const payload = buildDurableSessionEndPayload(directory, input, metrics);
  const manifest = prepareCoreManifest(directory, input.session_id, payload);
  if (!manifest) return { continue: true };
  exportSessionSummary(directory, metrics);
  let foregroundOutcome: Record<string, unknown>;
  try { foregroundOutcome = await runForegroundSessionEndCleanup(directory, input.session_id, false); } catch { return { continue: true }; }
  const sealed = completeForegroundCleanupAndSealCore(directory, input.session_id, foregroundOutcome);
  if (sealed) spawnSessionEndWorker({ directory, sessionId: input.session_id });
  return { continue: true };
}

/** Wiki producer has no foreground lock or write; it only seals a durable capture/no-op intent. */
export async function processWikiSessionEnd(input: SessionEndInput): Promise<HookOutput> {
  const directory = resolveToWorktreeRoot(input.cwd);
  const intent = buildWikiSessionEndCaptureIntent({ cwd: directory, session_id: input.session_id });
  sealWikiManifest(directory, input.session_id, intent ? { ...intent } : undefined);
  spawnSessionEndWorker({ directory, sessionId: input.session_id });
  return { continue: true };
}

export async function handleSessionEnd(input: SessionEndInput): Promise<HookOutput> {
  return processSessionEnd(input);
}
