import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const fsControl = vi.hoisted(() => ({
  racePath: undefined as string | undefined,
  replacement: undefined as Record<string, unknown> | undefined,
  injected: false,
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      actual.renameSync(from, to);
      if (from === fsControl.racePath && !fsControl.injected && fsControl.replacement) {
        fsControl.injected = true;
        actual.writeFileSync(from, JSON.stringify(fsControl.replacement));
      }
    },
  };
});

import { getStateMutationLockFailureMessage, withStateFileMutationLock } from '../mode-state-io.js';

const directories: string[] = [];

function processStart(): string {
  const identity = getProcessStartIdentitySync(process.pid);
  if (identity === null) throw new Error('current process identity unavailable');
  return identity;
}

function owner(pid: number, processStart: string): Record<string, unknown> {
  return {
    version: 1,
    pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
}

afterEach(() => {
  fsControl.racePath = undefined;
  fsControl.replacement = undefined;
  fsControl.injected = false;
  delete process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('state mutation lock fallback', () => {
  it('does not delete a replacement owner observed during stale reclamation', () => {
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE = '1';
    const directory = mkdtempSync(join(tmpdir(), 'mode-state-lock-race-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const lockPath = `${statePath}.mutation.lock`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner(999999999, '1')));
    fsControl.racePath = lockPath;
    fsControl.replacement = owner(process.pid, processStart());

    const result = withStateFileMutationLock(statePath, () => 'held');

    expect(fsControl.injected).toBe(true);
    expect(result).toEqual({ acquired: false, value: undefined });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(fsControl.replacement);
    expect(getStateMutationLockFailureMessage()).toContain('contention');
  });
});
