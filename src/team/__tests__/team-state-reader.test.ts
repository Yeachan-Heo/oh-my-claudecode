import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTeamState } from '../team-state-reader.js';
import { TeamPaths, absPath } from '../state-paths.js';

let cwd: string;
const teamName = 'reader-team';
const configPath = () => absPath(cwd, TeamPaths.config(teamName));
const manifestPath = () => absPath(cwd, TeamPaths.manifest(teamName));
function write(path: string, value: unknown): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function config(revision?: number) { return { name: teamName, tmux_session: 'config-session', workers: [{ name: 'config-worker' }], ...(revision === undefined ? {} : { state_revision: revision }) }; }
function manifest(revision?: number) { return { name: teamName, tmux_session: 'manifest-session', leader: { worker_id: 'leader', role: 'leader', session_id: 'leader-session' }, workers: [{ name: 'manifest-worker' }], ...(revision === undefined ? {} : { state_revision: revision }) }; }

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-team-state-reader-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

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
});
