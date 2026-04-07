/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */

import { z } from 'zod';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  resolveStatePath,
  ensureOmcDir,
  validateWorkingDirectory,
  resolveSessionStatePath,
  ensureSessionStateDir,
  listSessionIds,
  validateSessionId,
  getOmcRoot,
} from '../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { validatePayload } from '../lib/payload-limits.js';
import { canClearStateForSession, findSessionOwnedStateFiles } from '../lib/mode-state-io.js';
import {
  isModeActive,
  getActiveModes,
  getAllModeStatuses,
  clearModeState,
  getStateFilePath,
  MODE_CONFIGS,
  getActiveSessionsForMode,
  type ExecutionMode
} from '../hooks/mode-registry/index.js';
import { ToolDefinition } from './types.js';

// ExecutionMode from mode-registry (5 modes)
const EXECUTION_MODES: [string, ...string[]] = [
  'autopilot', 'team', 'ralph', 'ultrawork', 'ultraqa'
];

// Extended type for state tools - includes state-bearing modes outside mode-registry
const STATE_TOOL_MODES: [string, ...string[]] = [
  ...EXECUTION_MODES,
  'ralplan',
  'omc-teams',
  'deep-interview',
  'self-improve',
  'skill-active'
];
const EXTRA_STATE_ONLY_MODES = ['ralplan', 'omc-teams', 'deep-interview', 'self-improve', 'skill-active'] as const;
type StateToolMode = typeof STATE_TOOL_MODES[number];
const CANCEL_SIGNAL_TTL_MS = 30_000;

function readTeamNamesFromStateFile(statePath: string): string[] {
  if (!existsSync(statePath)) return [];

  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    const teamName = typeof raw.team_name === 'string'
      ? raw.team_name.trim()
      : typeof raw.teamName === 'string'
        ? raw.teamName.trim()
        : '';
    return teamName ? [teamName] : [];
  } catch {
    return [];
  }
}

function pruneMissionBoardTeams(root: string, teamNames?: string[]): number {
  const missionStatePath = join(getOmcRoot(root), 'state', 'mission-state.json');
  if (!existsSync(missionStatePath)) return 0;

  try {
    const parsed = JSON.parse(readFileSync(missionStatePath, 'utf-8')) as {
      updatedAt?: string;
      missions?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(parsed.missions)) return 0;

    const shouldRemoveAll = teamNames == null;
    const teamNameSet = new Set(teamNames ?? []);
    const remainingMissions = parsed.missions.filter((mission) => {
      if (mission.source !== 'team') return true;
      if (shouldRemoveAll) return false;
      const missionTeamName = typeof mission.teamName === 'string'
        ? mission.teamName.trim()
        : typeof mission.name === 'string'
          ? mission.name.trim()
          : '';
      return !missionTeamName || !teamNameSet.has(missionTeamName);
    });

    const removed = parsed.missions.length - remainingMissions.length;
    if (removed > 0) {
      writeFileSync(missionStatePath, JSON.stringify({
        ...parsed,
        updatedAt: new Date().toISOString(),
        missions: remainingMissions,
      }, null, 2));
    }

    return removed;
  } catch {
    return 0;
  }
}

function cleanupTeamRuntimeState(root: string, teamNames?: string[]): number {
  const teamStateRoot = join(getOmcRoot(root), 'state', 'team');
  if (!existsSync(teamStateRoot)) return 0;

  const shouldRemoveAll = teamNames == null;
  let removed = 0;

  if (shouldRemoveAll) {
    try {
      rmSync(teamStateRoot, { recursive: true, force: true });
      return 1;
    } catch {
      return 0;
    }
  }

  for (const teamName of teamNames ?? []) {
    if (!teamName) continue;
    try {
      rmSync(join(teamStateRoot, teamName), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best effort
    }
  }

  return removed;
}

/**
 * Get the state file path for any mode (including swarm and ralplan).
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For ralplan (not in registry): uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getStatePath(mode: StateToolMode, root: string): string {
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return getStateFilePath(root, mode as ExecutionMode);
  }
  // Fallback for modes not in registry (e.g., ralplan)
  return resolveStatePath(mode, root);
}

function getLegacyStateFileCandidates(mode: StateToolMode, root: string): string[] {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  const candidates = [
    getStatePath(mode, root),
    join(getOmcRoot(root), `${normalizedName}.json`),
  ];

  return [...new Set(candidates)];
}

function clearLegacyStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): { cleared: number; hadFailure: boolean } {
  let cleared = 0;
  let hadFailure = false;

  for (const legacyPath of getLegacyStateFileCandidates(mode, root)) {
    if (!existsSync(legacyPath)) {
      continue;
    }

    try {
      if (sessionId) {
        const raw = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;
        if (!canClearStateForSession(raw, sessionId)) {
          continue;
        }
      }

      unlinkSync(legacyPath);
      cleared++;
    } catch {
      hadFailure = true;
    }
  }

  return { cleared, hadFailure };
}

function clearSessionOwnedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId: string,
): { cleared: number; hadFailure: boolean; paths: string[] } {
  let cleared = 0;
  let hadFailure = false;
  const paths = findSessionOwnedStateFiles(mode, sessionId, root);

  for (const statePath of paths) {
    try {
      unlinkSync(statePath);
      cleared++;
    } catch {
      hadFailure = true;
    }
  }

  return { cleared, hadFailure, paths };
}

// ============================================================================
// state_read - Read state for a mode
// ============================================================================

export const stateReadTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_read',
  description: 'Read the current state for a specific mode (ralph, ultrawork, autopilot, etc.). Returns the JSON state data or indicates if no state exists.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to read state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // If session_id provided, read from session-scoped path
      if (sessionId) {
        validateSessionId(sessionId);
        const statePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sessionId)
          : resolveSessionStatePath(mode, sessionId, root);

        if (!existsSync(statePath)) {
          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
            }]
          };
        }

        const content = readFileSync(statePath, 'utf-8');
        const state = JSON.parse(content);

        return {
          content: [{
            type: 'text' as const,
            text: `## State for ${mode} (session: ${sessionId})\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
          }]
        };
      }

      // No session_id: scan all sessions and legacy path
      const statePath = getStatePath(mode, root);
      const legacyExists = existsSync(statePath);
      const sessionIds = listSessionIds(root);
      const activeSessions: string[] = [];

      for (const sid of sessionIds) {
        const sessionStatePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sid)
          : resolveSessionStatePath(mode, sid, root);

        if (existsSync(sessionStatePath)) {
          activeSessions.push(sid);
        }
      }

      if (!legacyExists && activeSessions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found for mode: ${mode}\nExpected legacy path: ${statePath}\nNo active sessions found.\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.`
          }]
        };
      }

      let output = `## State for ${mode}\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.\n\n`;

      // Show legacy state if exists
      if (legacyExists) {
        try {
          const content = readFileSync(statePath, 'utf-8');
          const state = JSON.parse(content);
          output += `### Legacy Path (shared)\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n`;
        } catch {
          output += `### Legacy Path (shared)\nPath: ${statePath}\n*Error reading state file*\n\n`;
        }
      }

      // Show active sessions
      if (activeSessions.length > 0) {
        output += `### Active Sessions (${activeSessions.length})\n\n`;
        for (const sid of activeSessions) {
          const sessionStatePath = MODE_CONFIGS[mode as ExecutionMode]
            ? getStateFilePath(root, mode as ExecutionMode, sid)
            : resolveSessionStatePath(mode, sid, root);

          try {
            const content = readFileSync(sessionStatePath, 'utf-8');
            const state = JSON.parse(content);
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n`;
          } catch {
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n*Error reading state file*\n\n`;
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: output
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_write - Write state for a mode
// ============================================================================

export const stateWriteTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  active: z.ZodOptional<z.ZodBoolean>;
  iteration: z.ZodOptional<z.ZodNumber>;
  max_iterations: z.ZodOptional<z.ZodNumber>;
  current_phase: z.ZodOptional<z.ZodString>;
  task_description: z.ZodOptional<z.ZodString>;
  plan_path: z.ZodOptional<z.ZodString>;
  started_at: z.ZodOptional<z.ZodString>;
  completed_at: z.ZodOptional<z.ZodString>;
  error: z.ZodOptional<z.ZodString>;
  state: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_write',
  description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Common fields (active, iteration, phase, etc.) can be set directly as parameters. Additional custom fields can be passed via the optional `state` parameter. Note: swarm uses SQLite and cannot be written via this tool.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to write state for'),
    active: z.boolean().optional().describe('Whether the mode is currently active'),
    iteration: z.number().optional().describe('Current iteration number'),
    max_iterations: z.number().optional().describe('Maximum iterations allowed'),
    current_phase: z.string().max(200).optional().describe('Current execution phase'),
    task_description: z.string().max(2000).optional().describe('Description of the task being executed'),
    plan_path: z.string().max(500).optional().describe('Path to the plan file'),
    started_at: z.string().max(100).optional().describe('ISO timestamp when the mode started'),
    completed_at: z.string().max(100).optional().describe('ISO timestamp when the mode completed'),
    error: z.string().max(2000).optional().describe('Error message if the mode failed'),
    state: z.record(z.string(), z.unknown()).optional().describe('Additional custom state fields (merged with explicit parameters)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const {
      mode,
      active,
      iteration,
      max_iterations,
      current_phase,
      task_description,
      plan_path,
      started_at,
      completed_at,
      error,
      state,
      workingDirectory,
      session_id
    } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // Validate custom state payload size if provided
      if (state) {
        const validation = validatePayload(state);
        if (!validation.valid) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: state payload rejected — ${validation.error}`
            }],
            isError: true
          };
        }
      }

      // Determine state path based on session_id
      let statePath: string;
      if (sessionId) {
        validateSessionId(sessionId);
        ensureSessionStateDir(sessionId, root);
        statePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sessionId)
          : resolveSessionStatePath(mode, sessionId, root);
      } else {
        ensureOmcDir('state', root);
        statePath = getStatePath(mode, root);
      }

      // Build state from explicit params + custom state
      const builtState: Record<string, unknown> = {};

      // Add explicit params (only if provided)
      if (active !== undefined) builtState.active = active;
      if (iteration !== undefined) builtState.iteration = iteration;
      if (max_iterations !== undefined) builtState.max_iterations = max_iterations;
      if (current_phase !== undefined) builtState.current_phase = current_phase;
      if (task_description !== undefined) builtState.task_description = task_description;
      if (plan_path !== undefined) builtState.plan_path = plan_path;
      if (started_at !== undefined) builtState.started_at = started_at;
      if (completed_at !== undefined) builtState.completed_at = completed_at;
      if (error !== undefined) builtState.error = error;

      // Merge custom state fields (explicit params take precedence)
      if (state) {
        for (const [key, value] of Object.entries(state)) {
          if (!(key in builtState)) {
            builtState[key] = value;
          }
        }
      }

      // Add metadata
      const stateWithMeta = {
        ...builtState,
        _meta: {
          mode,
          sessionId: sessionId || null,
          updatedAt: new Date().toISOString(),
          updatedBy: 'state_write_tool'
        }
      };

      atomicWriteJsonSync(statePath, stateWithMeta);

      const sessionInfo = sessionId ? ` (session: ${sessionId})` : ' (legacy path)';
      const warningMessage = sessionId ? '' : '\n\nWARNING: No session_id provided. State written to legacy shared path which may leak across parallel sessions. Pass session_id for session-scoped isolation.';
      return {
        content: [{
          type: 'text' as const,
          text: `Successfully wrote state for ${mode}${sessionInfo}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(stateWithMeta, null, 2)}\n\`\`\`${warningMessage}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================

export const stateClearTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_clear',
  description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to clear state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;
      const cleanedTeamNames = new Set<string>();

      const collectTeamNamesForCleanup = (statePath: string): void => {
        if (mode !== 'team') return;
        for (const teamName of readTeamNamesFromStateFile(statePath)) {
          cleanedTeamNames.add(teamName);
        }
      };

      // If session_id provided, clear only session-specific state
      if (sessionId) {
        validateSessionId(sessionId);
        for (const teamStatePath of findSessionOwnedStateFiles('team', sessionId, root)) {
          collectTeamNamesForCleanup(teamStatePath);
        }
        const now = Date.now();
        const cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, root);
        atomicWriteJsonSync(cancelSignalPath, {
          active: true,
          requested_at: new Date(now).toISOString(),
          expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
          mode,
          source: 'state_clear'
        });

        if (MODE_CONFIGS[mode as ExecutionMode]) {
          const success = clearModeState(mode as ExecutionMode, root, sessionId);
          const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId);
          const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId);

          const ghostNoteParts: string[] = [];
          if (legacyCleanup.cleared > 0) {
            ghostNoteParts.push('ghost legacy file also removed');
          }
          if (sessionCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
          }
          const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
          const runtimeCleanupNote = (() => {
            if (mode !== 'team') return '';
            const teamNames = [...cleanedTeamNames];
            const removedRoots = cleanupTeamRuntimeState(root, teamNames);
            const prunedMissions = pruneMissionBoardTeams(root, teamNames);
            const details: string[] = [];
            if (removedRoots > 0) details.push(`removed ${removedRoots} team runtime root(s)`);
            if (prunedMissions > 0) details.push(`pruned ${prunedMissions} HUD mission entry(ies)`);
            return details.length > 0 ? ` (${details.join(', ')})` : '';
          })();
          if (success && !legacyCleanup.hadFailure && !sessionCleanup.hadFailure) {
            return {
              content: [{
                type: 'text' as const,
                text: `Successfully cleared state for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
              }]
            };
          } else {
            return {
              content: [{
                type: 'text' as const,
                text: `Warning: Some files could not be removed for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
              }]
            };
          }
        }

        // Fallback for modes not in registry (e.g., ralplan)
        const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId);

        const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId);

        const ghostNoteParts: string[] = [];
        if (legacyCleanup.cleared > 0) {
          ghostNoteParts.push('ghost legacy file also removed');
        }
        if (sessionCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
        }
        const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
        const runtimeCleanupNote = (() => {
          if (mode !== 'team') return '';
          const teamNames = [...cleanedTeamNames];
          const removedRoots = cleanupTeamRuntimeState(root, teamNames);
          const prunedMissions = pruneMissionBoardTeams(root, teamNames);
          const details: string[] = [];
          if (removedRoots > 0) details.push(`removed ${removedRoots} team runtime root(s)`);
          if (prunedMissions > 0) details.push(`pruned ${prunedMissions} HUD mission entry(ies)`);
          return details.length > 0 ? ` (${details.join(', ')})` : '';
        })();
        return {
          content: [{
            type: 'text' as const,
            text: `${legacyCleanup.hadFailure || sessionCleanup.hadFailure ? 'Warning: Some files could not be removed' : 'Successfully cleared state'} for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
          }]
        };
      }

      // No session_id: clear from all locations (legacy + all sessions)
      // Write cancel signals FIRST (before deleting files) so the stop hook's
      // isSessionCancelInProgress check sees the signal during the deletion window.
      // Mirrors the session_id path at line ~403. (patch: fix missing cancel signal)
      {
        const now = Date.now();
        const cancelSignalPayload = {
          active: true,
          requested_at: new Date(now).toISOString(),
          expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
          mode,
          source: 'state_clear' as const,
        };
        // Write to legacy path (checked by stop hook fallback)
        const legacySignalPath = join(getOmcRoot(root), 'state', 'cancel-signal-state.json');
        try { atomicWriteJsonSync(legacySignalPath, cancelSignalPayload); } catch { /* best-effort */ }
        // Write to each session path (checked by stop hook primary check)
        for (const sid of listSessionIds(root)) {
          try {
            const sessionSignalPath = resolveSessionStatePath('cancel-signal', sid, root);
            atomicWriteJsonSync(sessionSignalPath, cancelSignalPayload);
          } catch { /* best-effort */ }
        }
      }
      let clearedCount = 0;
      const errors: string[] = [];
      if (mode === 'team') {
        collectTeamNamesForCleanup(getStateFilePath(root, 'team'));
      }

      // Clear legacy path
      if (MODE_CONFIGS[mode as ExecutionMode]) {
        const primaryLegacyStatePath = getStateFilePath(root, mode as ExecutionMode);
        if (existsSync(primaryLegacyStatePath)) {
          if (clearModeState(mode as ExecutionMode, root)) {
            clearedCount++;
          } else {
            errors.push('legacy path');
          }
        }
      }

      const extraLegacyCleanup = clearLegacyStateCandidates(mode, root);
      clearedCount += extraLegacyCleanup.cleared;
      if (extraLegacyCleanup.hadFailure) {
        errors.push('legacy path');
      }

      // Clear all session-scoped state files
      const sessionIds = listSessionIds(root);
      for (const sid of sessionIds) {
        if (mode === 'team') {
          collectTeamNamesForCleanup(resolveSessionStatePath('team', sid, root));
        }
        if (MODE_CONFIGS[mode as ExecutionMode]) {
          // Only clear if state file exists - avoid false counts for missing files
          const sessionStatePath = getStateFilePath(root, mode as ExecutionMode, sid);
          if (existsSync(sessionStatePath)) {
            if (clearModeState(mode as ExecutionMode, root, sid)) {
              clearedCount++;
            } else {
              errors.push(`session: ${sid}`);
            }
          }
        } else {
          const statePath = resolveSessionStatePath(mode, sid, root);
          if (existsSync(statePath)) {
            try {
              unlinkSync(statePath);
              clearedCount++;
            } catch {
              errors.push(`session: ${sid}`);
            }
          }
        }
      }

      let removedTeamRoots = 0;
      let prunedMissionEntries = 0;
      if (mode === 'team') {
        const teamNames = [...cleanedTeamNames];
        const removeSelector = teamNames.length > 0 ? teamNames : undefined;
        removedTeamRoots = cleanupTeamRuntimeState(root, removeSelector);
        prunedMissionEntries = pruneMissionBoardTeams(root, removeSelector);
      }

      if (clearedCount === 0 && errors.length === 0 && removedTeamRoots === 0 && prunedMissionEntries === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found to clear for mode: ${mode}`
          }]
        };
      }

      let message = `Cleared state for mode: ${mode}\n- Locations cleared: ${clearedCount}`;
      if (errors.length > 0) {
        message += `\n- Errors: ${errors.join(', ')}`;
      }
      if (mode === 'team') {
        if (removedTeamRoots > 0) {
          message += `\n- Team runtime roots removed: ${removedTeamRoots}`;
        }
        if (prunedMissionEntries > 0) {
          message += `\n- HUD mission entries pruned: ${prunedMissionEntries}`;
        }
      }
      message += '\nWARNING: No session_id provided. Cleared legacy plus all session-scoped state; this is a broad operation that may affect other sessions.';

      return {
        content: [{
          type: 'text' as const,
          text: message
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_list_active - List all active modes
// ============================================================================

export const stateListActiveTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_list_active',
  description: 'List all currently active modes. Returns which modes have active state files.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { workingDirectory, session_id } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // If session_id provided, show modes active for that specific session
      if (sessionId) {
        validateSessionId(sessionId);

        // Get active modes from registry for this session
        const activeModes: string[] = [...getActiveModes(root, sessionId)];

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sessionId, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active) {
                activeModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        if (activeModes.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Active Modes (session: ${sessionId})\n\nNo modes are currently active in this session.`
            }]
          };
        }

        const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `## Active Modes (session: ${sessionId}, ${activeModes.length})\n\n${modeList}`
          }]
        };
      }

      // No session_id: show all active modes across all sessions
      const modeSessionMap = new Map<string, string[]>();

      // Check legacy paths
      const legacyActiveModes: string[] = [...getActiveModes(root)];
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = getStatePath(mode, root);
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            if (state.active) {
              legacyActiveModes.push(mode);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      for (const mode of legacyActiveModes) {
        if (!modeSessionMap.has(mode)) {
          modeSessionMap.set(mode, []);
        }
        modeSessionMap.get(mode)!.push('legacy');
      }

      // Check all sessions
      const sessionIds = listSessionIds(root);
      for (const sid of sessionIds) {
        const sessionActiveModes: string[] = [...getActiveModes(root, sid)];

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sid, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active) {
                sessionActiveModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        for (const mode of sessionActiveModes) {
          if (!modeSessionMap.has(mode)) {
            modeSessionMap.set(mode, []);
          }
          modeSessionMap.get(mode)!.push(sid);
        }
      }

      if (modeSessionMap.size === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Active Modes\n\nNo modes are currently active.'
          }]
        };
      }

      const lines: string[] = [`## Active Modes (${modeSessionMap.size})\n`];
      for (const [mode, sessions] of Array.from(modeSessionMap.entries())) {
        lines.push(`- **${mode}** (${sessions.join(', ')})`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================

export const stateGetStatusTool: ToolDefinition<{
  mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_get_status',
  description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).optional().describe('Specific mode to check (omit for all modes)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      if (mode) {
        // Single mode status
        const lines: string[] = [`## Status: ${mode}\n`];

        if (sessionId) {
          // Session-specific status
          validateSessionId(sessionId);
          const statePath = MODE_CONFIGS[mode as ExecutionMode]
            ? getStateFilePath(root, mode as ExecutionMode, sessionId)
            : resolveSessionStatePath(mode, sessionId, root);

          const active = MODE_CONFIGS[mode as ExecutionMode]
            ? isModeActive(mode as ExecutionMode, root, sessionId)
            : existsSync(statePath) && (() => {
                try {
                  const content = readFileSync(statePath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true;
                } catch { return false; }
              })();

          let statePreview = 'No state file';
          if (existsSync(statePath)) {
            try {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              statePreview = JSON.stringify(state, null, 2).slice(0, 500);
              if (statePreview.length >= 500) statePreview += '\n...(truncated)';
            } catch {
              statePreview = 'Error reading state file';
            }
          }

          lines.push(`### Session: ${sessionId}`);
          lines.push(`- **Active:** ${active ? 'Yes' : 'No'}`);
          lines.push(`- **State Path:** ${statePath}`);
          lines.push(`- **Exists:** ${existsSync(statePath) ? 'Yes' : 'No'}`);
          lines.push(`\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``);

          return {
            content: [{
              type: 'text' as const,
              text: lines.join('\n')
            }]
          };
        }

        // No session_id: show all sessions + legacy
        const legacyPath = getStatePath(mode, root);
        const legacyActive = MODE_CONFIGS[mode as ExecutionMode]
          ? isModeActive(mode as ExecutionMode, root)
          : existsSync(legacyPath) && (() => {
              try {
                const content = readFileSync(legacyPath, 'utf-8');
                const state = JSON.parse(content);
                return state.active === true;
              } catch { return false; }
            })();

        lines.push(`### Legacy Path`);
        lines.push(`- **Active:** ${legacyActive ? 'Yes' : 'No'}`);
        lines.push(`- **State Path:** ${legacyPath}`);
        lines.push(`- **Exists:** ${existsSync(legacyPath) ? 'Yes' : 'No'}\n`);

        // Show active sessions for this mode
        const activeSessions = MODE_CONFIGS[mode as ExecutionMode]
          ? getActiveSessionsForMode(mode as ExecutionMode, root)
          : listSessionIds(root).filter(sid => {
              try {
                const sessionPath = resolveSessionStatePath(mode, sid, root);
                if (existsSync(sessionPath)) {
                  const content = readFileSync(sessionPath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true;
                }
                return false;
              } catch {
                return false;
              }
            });

        if (activeSessions.length > 0) {
          lines.push(`### Active Sessions (${activeSessions.length})`);
          for (const sid of activeSessions) {
            lines.push(`- ${sid}`);
          }
        } else {
          lines.push(`### Active Sessions\nNo active sessions for this mode.`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n')
          }]
        };
      }

      // All modes status
      const statuses = getAllModeStatuses(root, sessionId);
      const lines = sessionId
        ? [`## All Mode Statuses (session: ${sessionId})\n`]
        : ['## All Mode Statuses\n'];

      for (const status of statuses) {
        const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${status.stateFilePath}\``);

        // Show active sessions if no specific session_id
        if (!sessionId && MODE_CONFIGS[status.mode]) {
          const activeSessions = getActiveSessionsForMode(status.mode, root);
          if (activeSessions.length > 0) {
            lines.push(`   Active sessions: ${activeSessions.join(', ')}`);
          }
        }
      }

      // Also check extra state-only modes (not in MODE_CONFIGS)
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = sessionId
          ? resolveSessionStatePath(mode, sessionId, root)
          : getStatePath(mode, root);
        let active = false;
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            active = state.active === true;
          } catch {
            // Ignore parse errors
          }
        }
        const icon = active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${mode}**: ${active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${statePath}\``);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

/**
 * All state tools for registration
 */
export const stateTools = [
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
];
