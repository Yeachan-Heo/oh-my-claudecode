import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveManifestProjection, readTeamState } from '../team-state-reader.js';
import { TeamPaths, absPath } from '../state-paths.js';

let cwd: string;
const teamName = 'reader-team';
const configPath = () => absPath(cwd, TeamPaths.config(teamName));
const manifestPath = () => absPath(cwd, TeamPaths.manifest(teamName));
function write(path: string, value: unknown): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function config(revision?: number) { return { name: teamName, tmux_session: 'config-session', workers: [{ name: 'config-worker' }], ...(revision === undefined ? {} : { state_revision: revision }) }; }
function manifest(revision?: number) { return { name: teamName, tmux_session: 'manifest-session', leader: { worker_id: 'leader', role: 'leader', session_id: 'leader-session' }, workers: [{ name: 'manifest-worker' }], ...(revision === undefined ? {} : { state_revision: revision }) }; }

function isolateFixtureRoot(root: string): () => void {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  const stateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.OMC_STATE_DIR;
  return () => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
    if (stateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = stateDir;
  };
}

let restoreFixtureEnv: (() => void) | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omc-team-state-reader-'));
  restoreFixtureEnv = isolateFixtureRoot(cwd);
});
afterEach(() => {
  const restore = restoreFixtureEnv;
  restoreFixtureEnv = undefined;
  try {
    restore?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe('team state reader authority table', () => {
  it('returns absent when both records are absent, and preserves legacy merge behavior only for two legacy records', () => {
    expect(readTeamState(cwd, teamName)).toMatchObject({ classification: 'absent', state: null, manifestSync: 'repair_required' });
    write(configPath(), config());
    write(manifestPath(), manifest());
    const legacy = readTeamState(cwd, teamName);
    expect(legacy).toMatchObject({ classification: 'legacy_merged', manifestSync: 'synced' });
    expect(legacy.state).toMatchObject({ tmux_session: 'config-session', workers: [{ name: 'config-worker' }] });
  });

  it('makes revisioned config authoritative over a stale revisioned projection and preserves leader session from config', () => {
    write(configPath(), config(4));
    write(manifestPath(), manifest(3));
    const snapshot = readTeamState(cwd, teamName);
    expect(snapshot).toMatchObject({ classification: 'config_authoritative', manifestSync: 'repair_required' });
    expect(snapshot.state).toMatchObject({ tmux_session: 'config-session', workers: [{ name: 'config-worker' }] });
  });

  it('accepts a matching revisioned projection only as safe backfill, never as worker or session authority', () => {
    write(configPath(), { ...config(4), leader_cwd: undefined });
    write(manifestPath(), { ...manifest(4), leader_cwd: '/project', tmux_session: 'wrong-session', workers: [{ name: 'wrong-worker' }] });
    const snapshot = readTeamState(cwd, teamName);
    expect(snapshot).toMatchObject({ classification: 'config_authoritative', manifestSync: 'synced' });
    expect(snapshot.state).toMatchObject({ leader_cwd: '/project', tmux_session: 'config-session', workers: [{ name: 'config-worker' }] });
  });

  it('classifies malformed config and manifest-only legacy records without trusting malformed state', () => {
    mkdirSync(join(configPath(), '..'), { recursive: true });
    writeFileSync(configPath(), '{bad-json');
    write(manifestPath(), manifest());
    expect(readTeamState(cwd, teamName)).toMatchObject({ classification: 'invalid_config', state: null, config: { source: 'malformed' } });
    rmSync(configPath());
    expect(readTeamState(cwd, teamName)).toMatchObject({ classification: 'manifest_only_legacy', state: { tmux_session: 'manifest-session' } });
  });

  it('projects Claude-session ownership instead of the tmux target', () => {
    const projection = deriveManifestProjection({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: 'reader-team:0',
      leader_session_id: 'pid-claude-owner',
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }, {
      schema_version: 2,
      name: teamName,
      task: 'demo',
      leader: { session_id: 'reader-team:0', worker_id: 'leader', role: 'leader' },
      policy: {
        display_mode: 'split_pane',
        worker_launch_mode: 'interactive',
        dispatch_mode: 'hook_preferred_with_fallback',
        dispatch_ack_timeout_ms: 3000,
      },
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: false,
        cleanup_requires_all_workers_inactive: false,
      },
      permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'default', network_access: false },
      tmux_session: 'reader-team:0',
      worker_count: 0,
      workers: [],
      next_task_id: 1,
      created_at: new Date().toISOString(),
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    expect(projection.leader.session_id).toBe('pid-claude-owner');
    expect(projection.tmux_session).toBe('reader-team:0');
  });
});
