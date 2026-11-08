import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  activateTeamInstanceUnderLock,
  createTeamInstanceBinding,
  disposeTeamInstance,
  releaseFailedStartupReservationUnderLock,
  retryTeamInstanceDisposal,
  reserveTeamInstance,
  withTeamInstanceLifecycleLock,
  type TeamInstanceIo,
} from '../team-instance.js';
import {
  absPath,
  canonicalTeamOmcRoot,
  teamInstanceLifecycleLockPath,
  teamStateRoot,
  teamWorkspaceHash,
  TeamPaths,
} from '../state-paths.js';
import type { TeamInstanceBinding, TeamInstanceDisposalAuthorization } from '../types.js';

const AUTHORIZATION: TeamInstanceDisposalAuthorization = {
  protocol: 'caller-owned-final-state-v1',
  providers: 'disposed',
  panes: 'disposed',
  worktrees: 'disposed',
};

let cwd: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousOmcStateDir: string | undefined;

function id(last: string): string {
  return `00000000-0000-4000-8000-00000000000${last}`;
}

function writeBoundConfig(binding: TeamInstanceBinding, instanceId = binding.instance_id): void {
  mkdirSync(binding.state_root, { recursive: true });
  writeFileSync(join(binding.state_root, 'config.json'), JSON.stringify({
    name: binding.team_name,
    instance_id: instanceId,
    leader_cwd: binding.cwd,
    team_state_root: binding.state_root,
  }));
}

async function activate(binding: TeamInstanceBinding): Promise<void> {
  await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name,
    () => activateTeamInstanceUnderLock(binding));
}

beforeEach(() => {
  cwd = mkdtempSync(join(realpathSync(tmpdir()), 'omc-team-instance-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousOmcStateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
  rmSync(cwd, { recursive: true, force: true });
});

describe('team instance reservation and cleanup contract', () => {
  it('rejects simultaneous reservations for the same canonical team name', async () => {
    const first = reserveTeamInstance({ teamName: 'instance-team', cwd, instanceId: id('1') });
    const second = reserveTeamInstance({ teamName: 'instance-team', cwd, instanceId: id('2') });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'team_instance_reservation_conflict' } });
  });

  it('rejects a concurrent second start even when it reuses the same explicit UUID', async () => {
    const instanceId = id('a');
    const first = reserveTeamInstance({ teamName: 'same-uuid', cwd, instanceId });
    const second = reserveTeamInstance({ teamName: 'same-uuid', cwd, instanceId });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected'))
      .toMatchObject({ reason: { code: 'team_instance_reservation_conflict' } });
  });

  it('serializes reservations from shared-root subdirectories and symlink aliases', async () => {
    const sharedRoot = join(cwd, 'central-state');
    const left = join(cwd, 'repo-left');
    const right = join(cwd, 'repo-right');
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    process.env.OMC_STATE_DIR = sharedRoot;

    const subdirectoryResults = await Promise.allSettled([
      reserveTeamInstance({ teamName: 'shared-root', cwd: left, instanceId: id('1') }),
      reserveTeamInstance({ teamName: 'shared-root', cwd: right, instanceId: id('2') }),
    ]);
    expect(subdirectoryResults.filter(result => result.status === 'fulfilled')).toHaveLength(1);

    const alias = join(cwd, 'repo-alias');
    try {
      symlinkSync(left, alias, 'dir');
    } catch {
      return;
    }
    expect(teamWorkspaceHash(left, 'alias-root')).toBe(teamWorkspaceHash(alias, 'alias-root'));
    expect(teamInstanceLifecycleLockPath(left, 'alias-root'))
      .toBe(teamInstanceLifecycleLockPath(alias, 'alias-root'));
    const aliasResults = await Promise.allSettled([
      reserveTeamInstance({ teamName: 'alias-root', cwd: left, instanceId: id('3') }),
      reserveTeamInstance({ teamName: 'alias-root', cwd: alias, instanceId: id('4') }),
    ]);
    expect(aliasResults.filter(result => result.status === 'fulfilled')).toHaveLength(1);

    const storageTarget = join(cwd, 'storage-target');
    const storageAlias = join(cwd, 'storage-alias');
    mkdirSync(storageTarget, { recursive: true });
    symlinkSync(storageTarget, storageAlias, 'dir');
    process.env.OMC_STATE_DIR = storageTarget;
    const targetBinding = createTeamInstanceBinding({ teamName: 'empty-storage-alias', cwd: left, instanceId: id('5') });
    await reserveTeamInstance({ teamName: targetBinding.team_name, cwd: left, instanceId: targetBinding.instance_id });
    process.env.OMC_STATE_DIR = storageAlias;
    const aliasBinding = createTeamInstanceBinding({ teamName: 'empty-storage-alias', cwd: left, instanceId: id('6') });
    expect(aliasBinding.workspace_hash).toBe(targetBinding.workspace_hash);
    expect(aliasBinding.state_root).toBe(targetBinding.state_root);
    await expect(reserveTeamInstance({
      teamName: aliasBinding.team_name,
      cwd: left,
      instanceId: aliasBinding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_reservation_conflict' });
  });

  it('rejects a disposable team-root symlink before reservation effects', async () => {
    const binding = createTeamInstanceBinding({ teamName: 'state-link', cwd, instanceId: id('2') });
    const external = join(cwd, 'external-state');
    mkdirSync(external, { recursive: true });
    mkdirSync(dirname(binding.state_root), { recursive: true });
    symlinkSync(external, binding.state_root, 'dir');

    await expect(reserveTeamInstance({
      teamName: binding.team_name,
      cwd: binding.cwd,
      instanceId: binding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_state_corrupt' });
    expect(existsSync(join(external, 'config.json'))).toBe(false);
  });

  it('rejects a symlinked external authority parent before publishing a reservation', async () => {
    const binding = createTeamInstanceBinding({ teamName: 'authority-link', cwd, instanceId: id('3') });
    const storageRoot = canonicalTeamOmcRoot(cwd);
    const authorityParent = join(storageRoot, 'state', 'team-recovery');
    const external = join(cwd, 'external-authority');
    mkdirSync(join(storageRoot, 'state'), { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, authorityParent, 'dir');

    await expect(reserveTeamInstance({
      teamName: binding.team_name,
      cwd: binding.cwd,
      instanceId: binding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_state_corrupt' });
    expect(existsSync(join(external, 'team-instances'))).toBe(false);
  });

  it('preserves a newer same-name instance when retrying stale detached cleanup', async () => {
    const old = await reserveTeamInstance({ teamName: 'same-name', cwd, instanceId: id('1') });
    writeBoundConfig(old);
    await activate(old);

    const failRemoval: TeamInstanceIo = {
      removeTree: async () => { throw new Error('injected_partial_remove'); },
    };
    await expect(disposeTeamInstance(old, AUTHORIZATION, { io: failRemoval }))
      .rejects.toMatchObject({ code: 'team_instance_remove_failed' });

    const newer = await reserveTeamInstance({ teamName: 'same-name', cwd, instanceId: id('2') });
    writeBoundConfig(newer);
    await activate(newer);
    const replacementStateTarget = join(cwd, 'replacement-state-target');
    mkdirSync(replacementStateTarget, { recursive: true });
    writeFileSync(join(replacementStateTarget, 'config.json'), readFileSync(join(newer.state_root, 'config.json')));
    rmSync(newer.state_root, { recursive: true, force: true });
    symlinkSync(replacementStateTarget, newer.state_root, 'dir');
    const replacementReservationTarget = join(cwd, 'replacement-reservation.json');
    writeFileSync(replacementReservationTarget, readFileSync(old.reservation_path));
    rmSync(old.reservation_path, { force: true });
    symlinkSync(replacementReservationTarget, old.reservation_path);
    await expect(retryTeamInstanceDisposal(old, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });

    expect(existsSync(newer.state_root)).toBe(true);
    expect(existsSync(absPath(old.cwd, TeamPaths.teamInstanceDetachedRoot(
      old.workspace_hash,
      old.team_name,
      old.instance_id,
    )))).toBe(false);
    expect(readFileSync(join(newer.state_root, 'config.json'), 'utf8')).toContain(newer.instance_id);
    expect(readFileSync(join(replacementStateTarget, 'config.json'), 'utf8')).toContain(newer.instance_id);
    expect(readFileSync(replacementReservationTarget, 'utf8')).toContain(newer.instance_id);
  });

  it('retries a partial detached deletion using only the original instance root', async () => {
    const binding = await reserveTeamInstance({ teamName: 'retry-team', cwd, instanceId: id('3') });
    writeBoundConfig(binding);
    await activate(binding);

    let removeAttempts = 0;
    const failOnce: TeamInstanceIo = {
      removeTree: async () => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          rmSync(join(absPath(binding.cwd, TeamPaths.teamInstanceDetachedRoot(
            binding.workspace_hash,
            binding.team_name,
            binding.instance_id,
          )), 'config.json'), { force: true });
          throw new Error('injected_remove_failure');
        }
      },
    };
    await expect(disposeTeamInstance(binding, AUTHORIZATION, { io: failOnce }))
      .rejects.toMatchObject({ code: 'team_instance_remove_failed' });
    expect(removeAttempts).toBe(1);

    await expect(retryTeamInstanceDisposal(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
    expect(removeAttempts).toBe(1);
    expect(existsSync(binding.state_root)).toBe(false);
  });

  it('rejects reuse of a UUID retained by partial cleanup authority', async () => {
    const binding = await reserveTeamInstance({ teamName: 'reuse-partial', cwd, instanceId: id('4') });
    writeBoundConfig(binding);
    await activate(binding);
    await expect(disposeTeamInstance(binding, AUTHORIZATION, {
      io: { removeTree: async () => { throw new Error('injected_partial_remove'); } },
    })).rejects.toMatchObject({ code: 'team_instance_remove_failed' });

    await expect(reserveTeamInstance({
      teamName: binding.team_name,
      cwd: binding.cwd,
      instanceId: binding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_reservation_conflict' });
  });

  it('rejects reuse of a UUID retained by completed cleanup authority', async () => {
    const binding = await reserveTeamInstance({ teamName: 'reuse-completed', cwd, instanceId: id('5') });
    writeBoundConfig(binding);
    await activate(binding);
    await expect(disposeTeamInstance(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });

    await expect(reserveTeamInstance({
      teamName: binding.team_name,
      cwd: binding.cwd,
      instanceId: binding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_reservation_conflict' });
  });

  it('fails closed when reservation authority is absent or corrupt', async () => {
    const binding = createTeamInstanceBinding({ teamName: 'authority-team', cwd, instanceId: id('4') });
    await expect(retryTeamInstanceDisposal(binding, AUTHORIZATION))
      .rejects.toMatchObject({ code: 'team_instance_authority_missing' });
    await expect(disposeTeamInstance(binding, AUTHORIZATION))
      .rejects.toMatchObject({ code: 'team_instance_authority_missing' });

    const reservation = await reserveTeamInstance({ teamName: 'authority-team', cwd, instanceId: id('5') });
    writeFileSync(reservation.reservation_path, '{corrupt');
    await expect(reserveTeamInstance({ teamName: 'authority-team', cwd, instanceId: reservation.instance_id }))
      .rejects.toMatchObject({ code: 'team_instance_authority_corrupt' });

    const unknown = await reserveTeamInstance({ teamName: 'unknown-state', cwd, instanceId: id('9') });
    mkdirSync(unknown.state_root, { recursive: true });
    writeFileSync(join(unknown.state_root, 'config.json'), JSON.stringify({ name: unknown.team_name }));
    await expect(activate(unknown)).rejects.toMatchObject({ code: 'team_instance_state_unknown' });

    const corruptReceipt = await reserveTeamInstance({ teamName: 'corrupt-receipt', cwd, instanceId: id('f') });
    writeBoundConfig(corruptReceipt);
    await activate(corruptReceipt);
    const receiptPath = absPath(corruptReceipt.cwd, TeamPaths.teamInstanceCleanupReceipt(
      corruptReceipt.workspace_hash,
      corruptReceipt.team_name,
      corruptReceipt.instance_id,
    ));
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, '{corrupt');
    await expect(disposeTeamInstance(corruptReceipt, AUTHORIZATION))
      .rejects.toMatchObject({ code: 'team_instance_authority_corrupt' });

    const corruptHistory = createTeamInstanceBinding({ teamName: 'corrupt-history', cwd, instanceId: id('0') });
    const historyRoot = absPath(corruptHistory.cwd, TeamPaths.teamInstanceCleanupRoot(
      corruptHistory.workspace_hash,
      corruptHistory.team_name,
      corruptHistory.instance_id,
    ));
    mkdirSync(historyRoot, { recursive: true });
    writeFileSync(join(historyRoot, 'not-a-receipt'), '{corrupt');
    await expect(reserveTeamInstance({
      teamName: corruptHistory.team_name,
      cwd: corruptHistory.cwd,
      instanceId: corruptHistory.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_reservation_conflict' });
  });

  it('does not rename state when cleanup receipt publication fails', async () => {
    const binding = await reserveTeamInstance({ teamName: 'receipt-team', cwd, instanceId: id('6') });
    writeBoundConfig(binding);
    await activate(binding);

    const failReceipt: TeamInstanceIo = {
      publishCleanupReceipt: async path => {
        // Exercise the failure window after the staging directory has been
        // created, while ensuring the permanent cleanup root is never made.
        mkdirSync(dirname(path), { recursive: true });
        throw new Error('injected_receipt_failure');
      },
    };
    await expect(disposeTeamInstance(binding, AUTHORIZATION, { io: failReceipt }))
      .rejects.toMatchObject({ code: 'team_instance_receipt_publish_failed' });
    expect(existsSync(binding.state_root)).toBe(true);
    const cleanupRoot = absPath(binding.cwd, TeamPaths.teamInstanceCleanupRoot(
      binding.workspace_hash,
      binding.team_name,
      binding.instance_id,
    ));
    expect(existsSync(cleanupRoot)).toBe(false);
    expect(existsSync(binding.reservation_path)).toBe(true);
    await expect(disposeTeamInstance(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
  });

  it('retains prepared receipt and original state when detach rename fails', async () => {
    const binding = await reserveTeamInstance({ teamName: 'rename-team', cwd, instanceId: id('7') });
    writeBoundConfig(binding);
    await activate(binding);

    const failRename: TeamInstanceIo = {
      renameStateRoot: async () => { throw new Error('injected_rename_failure'); },
    };
    await expect(disposeTeamInstance(binding, AUTHORIZATION, { io: failRename }))
      .rejects.toMatchObject({ code: 'team_instance_rename_failed' });
    expect(existsSync(binding.state_root)).toBe(true);
    await expect(retryTeamInstanceDisposal(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
  });

  it('preserves abandoned staging evidence while a revalidated initial disposal completes', async () => {
    const binding = await reserveTeamInstance({ teamName: 'abandoned-stage', cwd, instanceId: id('8') });
    writeBoundConfig(binding);
    await activate(binding);
    const cleanupRoot = absPath(binding.cwd, TeamPaths.teamInstanceCleanupRoot(
      binding.workspace_hash, binding.team_name, binding.instance_id,
    ));
    const abandonedRoot = `${cleanupRoot}.staging-12345-interrupted`;
    mkdirSync(abandonedRoot, { recursive: true });
    const abandonedReceipt = join(abandonedRoot, 'cleanup.json');
    writeFileSync(abandonedReceipt, '{"incomplete":');

    await expect(retryTeamInstanceDisposal(binding, AUTHORIZATION))
      .rejects.toMatchObject({ code: 'team_instance_authority_missing' });
    await expect(disposeTeamInstance(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
    expect(readFileSync(abandonedReceipt, 'utf8')).toBe('{"incomplete":');
    expect(existsSync(binding.state_root)).toBe(false);
    await expect(reserveTeamInstance({
      teamName: binding.team_name, cwd, instanceId: binding.instance_id,
    })).rejects.toMatchObject({ code: 'team_instance_reservation_conflict' });
  });

  it('rejects a prepared stale receipt before touching a replacement canonical root', async () => {
    const old = await reserveTeamInstance({ teamName: 'prepared-race', cwd, instanceId: id('d') });
    writeBoundConfig(old);
    await activate(old);
    const failRename: TeamInstanceIo = {
      renameStateRoot: async () => { throw new Error('injected_rename_failure'); },
    };
    await expect(disposeTeamInstance(old, AUTHORIZATION, { io: failRename }))
      .rejects.toMatchObject({ code: 'team_instance_rename_failed' });

    // Simulate an operator completing only the unsafe old-root removal; the
    // durable prepared receipt must not authorize adopting the replacement.
    unlinkSync(old.reservation_path);
    rmSync(old.state_root, { recursive: true, force: true });
    const newer = await reserveTeamInstance({ teamName: 'prepared-race', cwd, instanceId: id('e') });
    writeBoundConfig(newer);
    await activate(newer);
    await expect(retryTeamInstanceDisposal(old, AUTHORIZATION))
      .rejects.toMatchObject({ code: 'team_instance_newer_instance' });
    expect(existsSync(newer.state_root)).toBe(true);
  });

  it('retries after rename succeeds but detached receipt publication fails', async () => {
    const binding = await reserveTeamInstance({ teamName: 'detached-receipt-retry', cwd, instanceId: id('6') });
    writeBoundConfig(binding);
    await activate(binding);
    let detachedPublicationAttempts = 0;
    const failDetachedReceipt: TeamInstanceIo = {
      publishCleanupReceipt: async (path, record) => {
        if (record.phase === 'detached' && detachedPublicationAttempts++ === 0) {
          throw new Error('injected_detached_receipt_failure');
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(record));
      },
    };
    await expect(disposeTeamInstance(binding, AUTHORIZATION, { io: failDetachedReceipt }))
      .rejects.toMatchObject({ code: 'team_instance_receipt_publish_failed' });
    expect(existsSync(binding.state_root)).toBe(false);

    await expect(retryTeamInstanceDisposal(binding, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
  });

  it('retries after final receipt publication failure without reading a replacement root', async () => {
    const old = await reserveTeamInstance({ teamName: 'final-receipt-team', cwd, instanceId: id('b') });
    writeBoundConfig(old);
    await activate(old);

    const failFinalReceipt: TeamInstanceIo = {
      publishCleanupReceipt: async (path, record) => {
        if (record.phase === 'completed') throw new Error('injected_final_receipt_failure');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(record));
      },
    };
    await expect(disposeTeamInstance(old, AUTHORIZATION, { io: failFinalReceipt }))
      .rejects.toMatchObject({ code: 'team_instance_receipt_publish_failed' });

    const newer = await reserveTeamInstance({ teamName: 'final-receipt-team', cwd, instanceId: id('c') });
    writeBoundConfig(newer);
    await activate(newer);
    await expect(retryTeamInstanceDisposal(old, AUTHORIZATION)).resolves.toMatchObject({ outcome: 'cleaned' });
    expect(existsSync(newer.state_root)).toBe(true);
  });

  it('keeps pending reservations releasable only while their root is empty', async () => {
    const binding = await reserveTeamInstance({ teamName: 'pending-team', cwd, instanceId: id('8') });
    mkdirSync(teamStateRoot(cwd, binding.team_name), { recursive: true });
    writeFileSync(join(binding.state_root, 'unexpected.txt'), 'effect');
    await expect(withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, () =>
      releaseFailedStartupReservationUnderLock(binding),
    )).rejects.toMatchObject({ code: 'team_instance_startup_not_empty' });
  });
});
