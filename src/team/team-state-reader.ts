import { existsSync, readFileSync } from 'fs';

import type { TeamConfig, TeamManifestV2 } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';

export type TeamStateSource = 'absent' | 'legacy' | 'revisioned' | 'malformed' | 'io_error';
export type TeamStateClassification =
  | 'absent'
  | 'legacy_merged'
  | 'config_authoritative'
  | 'manifest_only_legacy'
  | 'invalid_config'
  | 'io_error';

export interface RawTeamState<T> {
  source: TeamStateSource;
  value: T | null;
  error?: string;
}

export interface TeamStateSnapshot {
  classification: TeamStateClassification;
  config: RawTeamState<TeamConfig>;
  manifest: RawTeamState<TeamManifestV2>;
  /** Safe reader view. Revisioned config fields always win. */
  state: TeamConfig | TeamManifestV2 | null;
  manifestSync: 'synced' | 'repair_required';
}

function rawJson<T>(path: string): RawTeamState<T> {
  if (!existsSync(path)) return { source: 'absent', value: null };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { source: 'malformed', value: null };
    return { source: typeof (value as { state_revision?: unknown }).state_revision === 'number' ? 'revisioned' : 'legacy', value: value as T };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return { source: code ? 'io_error' : 'malformed', value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function manifestOnly(config: TeamConfig, manifest: TeamManifestV2 | null): TeamConfig {
  if (!manifest) return config;
  const projected = manifest as unknown as Record<string, unknown>;
  // Only fields absent from config are safe projection backfill. Never accept worker/session,
  // lifecycle/counters/policy/governance data from a revisioned projection.
  const backfill: Record<string, unknown> = {};
  for (const key of ['permissions_snapshot', 'leader_cwd', 'team_state_root', 'workspace_mode', 'worktree_mode', 'lifecycle_profile', 'leader_pane_id', 'hud_pane_id', 'resize_hook_name', 'resize_hook_target']) {
    if ((config as unknown as Record<string, unknown>)[key] === undefined && projected[key] !== undefined) backfill[key] = projected[key];
  }
  return { ...backfill, ...config, tmux_session: config.tmux_session } as TeamConfig;
}

/**
 * Read config and manifest independently. Once config carries a numeric revision it is the
 * authority even if the projection is stale, malformed, or unavailable.
 */
export function readTeamState(cwd: string, teamName: string): TeamStateSnapshot {
  const config = rawJson<TeamConfig>(absPath(cwd, TeamPaths.config(teamName)));
  const manifest = rawJson<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName)));

  if (config.source === 'io_error') {
    return { classification: 'io_error', config, manifest, state: null, manifestSync: 'repair_required' };
  }
  if (config.source === 'revisioned' && config.value) {
    const matching = manifest.source === 'revisioned' && manifest.value
      && (manifest.value as unknown as { state_revision?: number }).state_revision === config.value.state_revision;
    return {
      classification: 'config_authoritative',
      config,
      manifest,
      state: manifestOnly(config.value, matching ? manifest.value : null),
      manifestSync: matching ? 'synced' : 'repair_required',
    };
  }
  if (manifest.source === 'io_error') return { classification: 'io_error', config, manifest, state: null, manifestSync: 'repair_required' };
  if (config.source === 'malformed') return { classification: 'invalid_config', config, manifest, state: null, manifestSync: 'repair_required' };
  if (config.source === 'legacy' && config.value && manifest.source === 'legacy' && manifest.value) {
    // Legacy merging is deliberately limited to the pre-revision world.
    return { classification: 'legacy_merged', config, manifest, state: { ...manifest.value, ...config.value, tmux_session: config.value.tmux_session } as TeamConfig, manifestSync: 'synced' };
  }
  if (config.source === 'legacy' && config.value) return { classification: 'legacy_merged', config, manifest, state: config.value, manifestSync: manifest.source === 'absent' ? 'repair_required' : 'synced' };
  if (config.source === 'absent' && manifest.source === 'legacy' && manifest.value) return { classification: 'manifest_only_legacy', config, manifest, state: manifest.value, manifestSync: 'synced' };
  if (config.source === 'absent' && manifest.source === 'absent') return { classification: 'absent', config, manifest, state: null, manifestSync: 'repair_required' };
  return { classification: 'invalid_config', config, manifest, state: null, manifestSync: 'repair_required' };
}

/** Build the projection shape from authoritative configuration without reading a stale manifest. */
export function deriveManifestProjection(config: TeamConfig, existing?: TeamManifestV2 | null): TeamManifestV2 {
  const source = existing as Partial<TeamManifestV2> | undefined;
  return {
    schema_version: 2,
    name: config.name,
    task: config.task,
    leader: { ...(source?.leader ?? { worker_id: 'leader', role: 'leader' }), session_id: config.tmux_session },
    policy: config.policy ?? source?.policy ?? { display_mode: 'split_pane', worker_launch_mode: config.worker_launch_mode, dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 3000 },
    governance: config.governance ?? source?.governance ?? { delegation_only: false, plan_approval_required: false, nested_teams_allowed: false, one_team_per_leader_session: false, cleanup_requires_all_workers_inactive: false },
    permissions_snapshot: source?.permissions_snapshot ?? { approval_mode: 'default', sandbox_mode: 'default', network_access: false },
    tmux_session: config.tmux_session,
    worker_count: config.worker_count,
    workers: config.workers,
    next_task_id: config.next_task_id,
    created_at: config.created_at,
    leader_cwd: config.leader_cwd,
    team_state_root: config.team_state_root,
    workspace_mode: config.workspace_mode,
    worktree_mode: config.worktree_mode,
    lifecycle_profile: config.lifecycle_profile,
    leader_pane_id: config.leader_pane_id,
    hud_pane_id: config.hud_pane_id,
    resize_hook_name: config.resize_hook_name,
    resize_hook_target: config.resize_hook_target,
    next_worker_index: config.next_worker_index,
    // Retain revision in the durable projection although old manifest typings predate it.
    state_revision: config.state_revision,
  } as TeamManifestV2;
}
