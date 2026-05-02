import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveCanonicalTeamStateRoot,
  resolveWorkerNotifyTeamStateRoot,
  resolveWorkerNotifyTeamStateRootPath,
  resolveWorkerTeamStateRoot,
  resolveWorkerTeamStateRootPath,
} from '../state-root.js';

describe('state-root OMX parity adapter', () => {
  async function withTemp<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    try {
      return await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function writeIdentity(
    root: string,
    teamName: string,
    workerName: string,
    worktreePath: string,
    teamStateRoot: string = root,
    layout: 'state_root' | 'team_root' = 'state_root',
  ) {
    const teamRoot = layout === 'team_root' ? root : join(root, 'team', teamName);
    const workerDir = join(teamRoot, 'workers', workerName);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, 'identity.json'), JSON.stringify({
      name: workerName,
      worktree_path: worktreePath,
      team_state_root: teamStateRoot,
    }, null, 2));
  }

  async function writeTeamMetadata(
    root: string,
    teamName: string,
    filename: 'config.json' | 'manifest.json' | 'manifest.v2.json',
    workers: Array<{ name: string }>,
    layout: 'state_root' | 'team_root' = 'state_root',
    extra: Record<string, unknown> = {},
  ) {
    const teamRoot = layout === 'team_root' ? root : join(root, 'team', teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, filename), JSON.stringify({
      name: teamName,
      workers,
      ...extra,
    }, null, 2));
  }

  it('resolves canonical leader root to .omc/state and honors OMC/OMX aliases', () => {
    expect(resolveCanonicalTeamStateRoot('/tmp/demo/project', {})).toBe('/tmp/demo/project/.omc/state');
    expect(resolveCanonicalTeamStateRoot('/tmp/demo/project', { OMC_TEAM_STATE_ROOT: '../shared/state' })).toBe('/tmp/demo/shared/state');
    expect(resolveCanonicalTeamStateRoot('/tmp/demo/project', { OMX_TEAM_STATE_ROOT: '/tmp/omx-alias' })).toBe('/tmp/omx-alias');
    expect(resolveCanonicalTeamStateRoot('/tmp/demo/project', { OMC_TEAM_STATE_ROOT: '/tmp/omc', OMX_TEAM_STATE_ROOT: '/tmp/omx' })).toBe('/tmp/omc');
  });

  it('validates worker roots with source-style .omc/state/team/<team> layout', async () => {
    await withTemp('omc-state-root-env-', async (root) => {
      const stateRoot = join(root, 'leader', '.omc', 'state');
      const worktree = join(root, 'worktree');
      await mkdir(worktree, { recursive: true });
      await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

      await expect(resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_STATE_ROOT: stateRoot,
      })).resolves.toBe(stateRoot);

      await expect(resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-2' }, {
        OMC_TEAM_STATE_ROOT: stateRoot,
      })).resolves.toBeNull();
    });
  });

  it('accepts OMC team-specific worker roots used by current runtime envs', async () => {
    await withTemp('omc-team-specific-root-', async (root) => {
      const teamRoot = join(root, '.omc', 'state', 'team', 'team-a');
      const worktree = join(root, 'worktree');
      await mkdir(worktree, { recursive: true });
      await writeIdentity(teamRoot, 'team-a', 'worker-1', worktree, teamRoot, 'team_root');

      const resolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_STATE_ROOT: teamRoot,
      });
      expect(resolved.ok).toBe(true);
      expect(resolved.stateRoot).toBe(teamRoot);
      expect(resolved.source).toBe('env');
    });
  });

  it('resolves from OMC_TEAM_LEADER_CWD and accepts OMX leader alias', async () => {
    await withTemp('omc-state-root-leader-', async (root) => {
      const leader = join(root, 'leader');
      const worktree = join(root, 'worker');
      const stateRoot = join(leader, '.omc', 'state');
      await mkdir(worktree, { recursive: true });
      await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

      const omcResolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_LEADER_CWD: leader,
      });
      expect(omcResolved.ok).toBe(true);
      expect(omcResolved.stateRoot).toBe(stateRoot);
      expect(omcResolved.source).toBe('leader_cwd');

      const omxResolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_LEADER_CWD: leader,
      });
      expect(omxResolved.ok).toBe(true);
      expect(omxResolved.stateRoot).toBe(stateRoot);
    });
  });

  it('does not guess cwd .omc/state for non-git worker notify resolution', async () => {
    await withTemp('omc-state-root-notify-no-cwd-', async (worktree) => {
      const stateRoot = join(worktree, '.omc', 'state');
      await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

      await expect(resolveWorkerNotifyTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {})).resolves.toBeNull();
      await expect(resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {})).resolves.toBe(stateRoot);
    });
  });

  it('accepts notify roots with canonical markers but no identity', async () => {
    await withTemp('omc-state-root-notify-markers-', async (root) => {
      const teamRoot = join(root, '.omc', 'state', 'team', 'team-a');
      const worktree = join(root, 'worktree');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await mkdir(worktree, { recursive: true });

      const workerDirResolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_STATE_ROOT: teamRoot,
      });
      expect(workerDirResolved.ok).toBe(true);
      expect(workerDirResolved.stateRoot).toBe(teamRoot);
      expect(workerDirResolved.source).toBe('worker_directory');

      const manifestRoot = join(root, 'manifest-root');
      await writeTeamMetadata(manifestRoot, 'team-a', 'manifest.json', [{ name: 'worker-2' }], 'team_root');
      const manifestResolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-2' }, {
        OMC_TEAM_STATE_ROOT: manifestRoot,
      });
      expect(manifestResolved.ok).toBe(true);
      expect(manifestResolved.source).toBe('manifest_metadata');
    });
  });

  it('rejects missing identity and worktree mismatch', async () => {
    await withTemp('omc-state-root-reject-', async (root) => {
      const stateRoot = join(root, 'state');
      const worktree = join(root, 'worker');
      const otherWorktree = join(root, 'other-worker');
      await mkdir(worktree, { recursive: true });
      await mkdir(otherWorktree, { recursive: true });

      await expect(resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_STATE_ROOT: stateRoot,
      })).resolves.toBeNull();

      await writeIdentity(stateRoot, 'team-a', 'worker-1', otherWorktree);
      const mismatch = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMC_TEAM_STATE_ROOT: stateRoot,
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.reason).toBe('identity_worktree_mismatch');
    });
  });
});
