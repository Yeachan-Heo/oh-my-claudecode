import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const readHold = vi.hoisted(() => ({
  current: null as null | { path: string; entered: () => void; release: Promise<void> },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFileGated = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    const hold = readHold.current;
    if (hold && String(args[0]) === hold.path) {
      readHold.current = null;
      hold.entered();
      await hold.release;
    }
    return result;
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile: readFileGated }, readFile: readFileGated };
});

import {
  enqueueDispatchRequest,
  transitionDispatchRequest,
  type TeamDispatchRequest,
} from '../dispatch-queue.js';

const teamName = 'integrity-team';
const timestamp = '2026-07-13T00:00:00.000Z';
const deadProcessStart = process.platform === 'darwin' ? 'darwin:1:0' : process.platform === 'win32' ? 'win32:1' : 'linux:1';

function pending(overrides: Partial<TeamDispatchRequest> = {}): TeamDispatchRequest {
  return {
    request_id: 'request-1',
    kind: 'nudge',
    team_name: teamName,
    to_worker: 'worker-1',
    trigger_message: 'Check your inbox.',
    transport_preference: 'hook_preferred_with_fallback',
    fallback_allowed: true,
    status: 'pending',
    attempt_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

const futureRow = {
  request_id: 'future-1',
  kind: 'webhook',
  team_name: teamName,
  to_worker: 'worker-2',
  endpoint: 'https://example.invalid/hook',
  status: 'pending',
};

describe('dispatch queue store integrity', () => {
  let cwd: string;
  let dispatchDir: string;
  let storePath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-dispatch-integrity-'));
    for (const key of ['HOME', 'USERPROFILE', 'OMC_STATE_DIR', 'OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS']) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
    process.env.OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS = '1000';
    dispatchDir = join(cwd, '.omc', 'state', 'team', teamName, 'dispatch');
    storePath = join(dispatchDir, 'requests.json');
    await mkdir(dispatchDir, { recursive: true });
  });

  afterEach(async () => {
    readHold.current = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await chmod(storePath, 0o600).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });

  async function storedRows(): Promise<Record<string, unknown>[]> {
    return JSON.parse(await readFile(storePath, 'utf8')) as Record<string, unknown>[];
  }

  describe('corrupt store', () => {
    it.each([
      ['malformed JSON', `[${JSON.stringify(pending())},`],
      ['a non-array document', JSON.stringify({ requests: [pending()] })],
    ])('enqueue refuses to overwrite %s', async (_label, bytes) => {
      await writeFile(storePath, bytes, 'utf8');

      await expect(enqueueDispatchRequest(teamName, {
        kind: 'nudge', to_worker: 'worker-1', trigger_message: 'New work.',
      }, cwd)).rejects.toThrow(/invalid dispatch store/);

      await expect(readFile(storePath, 'utf8')).resolves.toBe(bytes);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'enqueue refuses to overwrite a store it cannot read',
      async () => {
        const bytes = JSON.stringify([pending()]);
        await writeFile(storePath, bytes, 'utf8');
        await chmod(storePath, 0o000);

        await expect(enqueueDispatchRequest(teamName, {
          kind: 'nudge', to_worker: 'worker-1', trigger_message: 'New work.',
        }, cwd)).rejects.toThrow(/invalid dispatch store/);

        await chmod(storePath, 0o600);
        await expect(readFile(storePath, 'utf8')).resolves.toBe(bytes);
      },
    );
  });

  describe('rows this version does not recognize', () => {
    it('enqueue preserves them verbatim', async () => {
      await writeFile(storePath, JSON.stringify([futureRow]), 'utf8');

      const { request } = await enqueueDispatchRequest(teamName, {
        kind: 'nudge', to_worker: 'worker-1', trigger_message: 'New work.',
      }, cwd);

      const rows = await storedRows();
      expect(rows).toContainEqual(futureRow);
      expect(rows.map((row) => row.request_id)).toEqual(['future-1', request.request_id]);
    });

    it('transition preserves them verbatim', async () => {
      await writeFile(storePath, JSON.stringify([futureRow, pending()]), 'utf8');

      await expect(transitionDispatchRequest(teamName, 'request-1', 'pending', 'notified', {}, cwd))
        .resolves.toMatchObject({ request_id: 'request-1', status: 'notified' });

      const rows = await storedRows();
      expect(rows[0]).toEqual(futureRow);
      expect(rows[1]).toMatchObject({ request_id: 'request-1', status: 'notified' });
    });
  });

  describe('lock', () => {
    it('does not steal the lock from a live holder, however old the lock is', async () => {
      process.env.OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS = '10000';
      await enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'seed' }, cwd);

      let releaseHolder!: () => void;
      const holderInside = new Promise<void>((entered) => {
        readHold.current = {
          path: storePath,
          entered,
          release: new Promise<void>((resolve) => { releaseHolder = resolve; }),
        };
      });
      const holder = enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'holder' }, cwd);
      await holderInside;

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      for (const entry of await readdir(dispatchDir)) {
        if (entry !== 'requests.json') await utimes(join(dispatchDir, entry), tenMinutesAgo, tenMinutesAgo);
      }

      let contenderSettled = false;
      const contender = enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'contender' }, cwd)
        .finally(() => { contenderSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const contenderSettledWhileHeld = contenderSettled;
      releaseHolder();
      await Promise.all([holder, contender]);

      expect(contenderSettledWhileHeld).toBe(false);
      expect((await storedRows()).map((row) => row.trigger_message)).toEqual(['seed', 'holder', 'contender']);
    });

    it('reclaims both locks a dead writer of this version left behind', async () => {
      const lockPath = join(dispatchDir, 'requests.lock');
      const legacyLockDir = join(dispatchDir, '.lock');
      const deadHolder = { pid: 2_147_483_647, process_started_at: deadProcessStart, nonce: 'dead-holder' };
      await writeFile(lockPath, JSON.stringify({
        schema_version: 1, ...deadHolder, created_at: new Date().toISOString(),
      }), 'utf8');
      await mkdir(legacyLockDir);
      await writeFile(join(legacyLockDir, 'owner'), JSON.stringify(deadHolder), 'utf8');

      await enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'after crash' }, cwd);

      expect((await storedRows()).map((row) => row.trigger_message)).toEqual(['after crash']);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(legacyLockDir)).toBe(false);
    });

    it('waits for a directory lock held by an older version instead of losing its update', async () => {
      process.env.OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS = '10000';
      await enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'seed' }, cwd);
      const legacyLockDir = join(dispatchDir, '.lock');
      await mkdir(legacyLockDir);
      await writeFile(join(legacyLockDir, 'owner'), '12345.1.abc', 'utf8');
      const oldWriterSnapshot = await storedRows();

      let newWriterSettled = false;
      const newWriter = enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'new writer' }, cwd)
        .finally(() => { newWriterSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settledWhileOldWriterHeld = newWriterSettled;
      await writeFile(storePath, JSON.stringify([
        ...oldWriterSnapshot,
        pending({ request_id: 'old-writer', trigger_message: 'old writer' }),
      ]), 'utf8');
      await rm(legacyLockDir, { recursive: true, force: true });
      await newWriter;

      expect((await storedRows()).map((row) => row.trigger_message)).toEqual(['seed', 'old writer', 'new writer']);
      expect(settledWhileOldWriterHeld).toBe(false);
    });

    it('reclaims a directory lock an older version abandoned past its stale window', async () => {
      const legacyLockDir = join(dispatchDir, '.lock');
      await mkdir(legacyLockDir);
      await writeFile(join(legacyLockDir, 'owner'), '12345.1.abc', 'utf8');
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      await utimes(legacyLockDir, sixMinutesAgo, sixMinutesAgo);

      await enqueueDispatchRequest(teamName, { kind: 'nudge', to_worker: 'worker-1', trigger_message: 'after upgrade' }, cwd);

      expect((await storedRows()).map((row) => row.trigger_message)).toEqual(['after upgrade']);
      expect(existsSync(legacyLockDir)).toBe(false);
    });
  });
});
