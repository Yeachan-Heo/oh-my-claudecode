import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import type { TeamPipelinePhase } from './team-pipeline/types.js';

export interface CanonicalTeamStateCandidate {
  teamName: string;
  sessionId: string;
  stage: TeamPipelinePhase;
  active: boolean;
  startedAt: string;
  updatedAt: string;
  task: string;
  leaderCwd?: string;
  teamStateRoot?: string;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isTerminalCanonicalPhase(phase: string): boolean {
  return phase === 'completed' || phase === 'failed';
}

function mapCanonicalPhaseToStage(phase: string): TeamPipelinePhase | null {
  switch (phase) {
    case 'initializing':
    case 'planning':
      return 'team-plan';
    case 'executing':
      return 'team-exec';
    case 'fixing':
      return 'team-fix';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

function buildCandidate(
  teamName: string,
  sessionId: string,
  stage: TeamPipelinePhase,
  task: string,
  leaderCwd?: string,
  teamStateRoot?: string,
  startedAt?: string,
  updatedAt?: string,
): CanonicalTeamStateCandidate {
  return {
    teamName,
    sessionId,
    stage,
    active: stage !== 'complete' && stage !== 'failed',
    startedAt: startedAt || updatedAt || new Date().toISOString(),
    updatedAt: updatedAt || startedAt || new Date().toISOString(),
    task,
    leaderCwd,
    teamStateRoot,
  };
}

/**
 * Read the canonical live team candidate for the current session.
 *
 * This is a read-only fallback used when coarse `team-state.json` drifted,
 * disappeared, or was marked inactive even though the canonical team config
 * and phase files still describe a live run.
 */
export function readCanonicalTeamStateCandidate(
  directory: string,
  sessionId?: string,
): CanonicalTeamStateCandidate | null {
  const currentSessionId = safeString(sessionId);
  if (!currentSessionId) return null;

  const teamRoot = join(getOmcRoot(directory), 'state', 'team');
  if (!existsSync(teamRoot)) return null;

  const entries = readdirSync(teamRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const teamName = safeString(entry.name);
    if (!teamName) continue;

    const teamDir = join(teamRoot, teamName);
    const manifest = readJson<{
      name?: unknown;
      task?: unknown;
      leader?: { session_id?: unknown };
      leader_cwd?: unknown;
      team_state_root?: unknown;
      created_at?: unknown;
    }>(join(teamDir, 'manifest.json'));
    const phaseState = readJson<{
      current_phase?: unknown;
      updated_at?: unknown;
    }>(join(teamDir, 'phase-state.json'));
    if (!manifest || !phaseState) continue;

    const ownerSessionId = safeString(manifest.leader?.session_id);
    if (ownerSessionId !== currentSessionId) continue;

    const rawPhase = safeString(phaseState.current_phase);
    const stage = mapCanonicalPhaseToStage(rawPhase);
    if (!stage) continue;

    const task = safeString(manifest.task) || teamName;
    const startedAt = safeString(manifest.created_at);
    const updatedAt = safeString(phaseState.updated_at);
    return buildCandidate(
      teamName,
      ownerSessionId,
      stage,
      task,
      safeString(manifest.leader_cwd) || undefined,
      safeString(manifest.team_state_root) || undefined,
      startedAt || undefined,
      updatedAt || undefined,
    );
  }

  return null;
}

export function canonicalTeamStateIsTerminal(candidate: CanonicalTeamStateCandidate | null): boolean {
  return !candidate ? false : isTerminalCanonicalPhase(candidate.stage);
}
