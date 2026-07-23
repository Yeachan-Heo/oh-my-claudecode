import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const created: string[] = [];
const modules = [
  join(root, 'scripts', 'lib', 'atomic-write.mjs'),
  join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs'),
];

// processStart is retained for the EMERGENCY JOURNAL / recovery-claim subsystem
// (which is still liveness-based). The mutation lock is now LEASE-based and no
// longer probes process liveness, so mutation-lock tests plant lease owners via
// leaseOwner() below. On Linux we read the real /proc start time; on other
// platforms we return a stable synthetic value so the recovery-claim tests can
// run locally (production's processStartIdentity does the same for non-Linux).
function processStart(pid = process.pid): string {
  if (process.platform !== 'linux') return '1';
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

// The shipped hook helpers retain the deployed v1 lease wire format for
// backward compatibility. It is distinguished from the old v1 liveness shape
// below by `expires_at` (rather than `processStart`).
function leaseOwner(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    version: 1,
    pid: process.pid,
    createdAt: new Date(now).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
    nonce: randomUUID(),
    ...overrides,
  };
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    pid: process.pid,
    processStart: processStart(),
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
    ...overrides,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-lock-'));
  created.push(dir);
  const statePath = join(dir, 'state', 'autopilot-state.json');
  mkdirSync(join(dir, 'state'), { recursive: true });
  return { statePath, lockPath: `${statePath}.mutation.lock` };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
  delete process.env.OMC_TEST_FLOCK_AVAILABLE;
});

describe.each(modules)('recoverable workflow mutation lock (%s)', (modulePath) => {
  async function api() {
    return import(`${pathToFileURL(modulePath).href}?test=${randomUUID()}`) as Promise<{
      acquireStateFileLockSync(path: string, attempts?: number, requireExclusive?: boolean): { fd: number; lockPath: string; owner: ReturnType<typeof leaseOwner> } | { unlocked: true } | null;
      releaseStateFileLockSync(lock: unknown): void;
      recoverEmergencyStateFile(path: string): boolean;
    }>;
  }

  it('fails closed for a legacy liveness owner', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    const legacy = owner({ pid: 999999999, processStart: '1' });
    writeFileSync(lockPath, JSON.stringify(legacy));

    expect(lockApi.acquireStateFileLockSync(statePath, 2, true)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(legacy);
  });

  it('never reclaims a valid unexpired lease', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    // A valid lease whose expires_at is in the future is "held" (not
    // reclaimable). The lease is the sole reclaim key - no process liveness is
    // probed - so a future expires_at must block reacquisition for the whole
    // retry window and leave the holder's lock untouched.
    const live = leaseOwner({ expires_at: new Date(Date.now() + 60000).toISOString() });
    writeFileSync(lockPath, JSON.stringify(live));
    // requireExclusive forces the reclaim branch to actually run on flock-less
    // hosts (otherwise the non-exclusive flock-less path returns {unlocked:true}
    // without inspecting the lock). On Linux (real flock) it runs the guarded
    // flock reclaim; both paths share the same lease policy.
    expect(lockApi.acquireStateFileLockSync(statePath, 2, true)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(live);
  });

  it('reclaims a lock with corrupt metadata by lease policy', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    // The lease contract treats a readable-but-unparseable owner as having no
    // valid lease on record, so the owner cannot be live: RECLAIM (unlink) and
    // retry. (Fail-closed applies only to an I/O-unreadable lock, e.g. EACCES -
    // not to corrupt JSON.) A corrupt lock is therefore reclaimed and replaced
    // with a fresh valid lease owner.
    writeFileSync(lockPath, 'corrupt');
    // requireExclusive forces the reclaim branch to run on flock-less hosts so
    // the corrupt lock is actually unlinked and reacquired (the non-exclusive
    // flock-less path would otherwise no-op). On Linux the guarded flock reclaim
    // runs; both paths reclaim corrupt metadata by the same lease policy.
    const reclaimed = lockApi.acquireStateFileLockSync(statePath, 2, true);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed).not.toHaveProperty('unlocked');
    const next = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(next.version).toBe(1);
    expect(next.expires_at).toBeTypeOf('string');
    expect(Number.isFinite(Date.parse(next.expires_at as string))).toBe(true);
    expect(next.nonce).toMatch(/^[0-9a-f-]{36}$/i);
    lockApi.releaseStateFileLockSync(reclaimed);
  });

  it('does not let an old owner release a replacement lock', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    const old = lockApi.acquireStateFileLockSync(statePath, 2, true)!;
    unlinkSync(lockPath);
    const replacement = leaseOwner();
    writeFileSync(lockPath, JSON.stringify(replacement));
    lockApi.releaseStateFileLockSync(old);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('serializes concurrent reclaimers without removing a live replacement', async () => {
    const { statePath, lockPath } = fixture();
    writeFileSync(lockPath, JSON.stringify(leaseOwner({
      pid: 999999999,
      expires_at: new Date(Date.now() - 1).toISOString(),
    })));
    const logPath = `${statePath}.critical.log`;
    const childScript = String.raw`
      import { appendFileSync } from 'node:fs';
      const [modulePath, statePath, logPath, id] = process.argv.slice(1);
      const api = await import(modulePath);
      const lock = api.acquireStateFileLockSync(statePath, 100, true);
      if (!lock) process.exit(2);
      appendFileSync(logPath, id + ':start\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      appendFileSync(logPath, id + ':end\n');
      api.releaseStateFileLockSync(lock);
    `;
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, pathToFileURL(modulePath).href, statePath, logPath, id], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`reclaimer ${id} exited ${code}`)));
    });

    await Promise.all([run('a'), run('b')]);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0].endsWith(':start')).toBe(true);
    expect(lines[1]).toBe(`${lines[0][0]}:end`);
    expect(lines[2].endsWith(':start')).toBe(true);
    expect(lines[3]).toBe(`${lines[2][0]}:end`);
  });

  it('releases its own lock without external flock', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const first = lockApi.acquireStateFileLockSync(statePath, 2);
    expect(first).not.toBeNull();
    lockApi.releaseStateFileLockSync(first);
    expect(existsSync(lockPath)).toBe(false);
    const second = lockApi.acquireStateFileLockSync(statePath, 2);
    expect(second).not.toBeNull();
    lockApi.releaseStateFileLockSync(second);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe.each(modules)('guarded emergency recovery claim (%s)', (modulePath) => {
  async function api() {
    return import(`${pathToFileURL(modulePath).href}?recovery=${randomUUID()}`) as Promise<{
      recoverEmergencyStateFile(path: string): boolean;
    }>;
  }

  function writeDeadJournal(statePath: string, raw: string): void {
    const transactionId = randomUUID();
    const quarantinePath = `${statePath}.emergency-quarantine.${transactionId}`;
    const next = JSON.stringify({ active: false, run: 'recovered' });
    writeFileSync(`${quarantinePath}.payload`, next);
    writeFileSync(`${statePath}.emergency-journal.json`, JSON.stringify({
      version: 1,
      transactionId,
      owner: { pid: 999999999, processStart: '1', nonce: randomUUID() },
      originalDigest: createHash('sha256').update(raw).digest('hex'),
      intendedDigest: createHash('sha256').update(next).digest('hex'),
      intent: 'publish',
      quarantinePath,
      phase: 'prepared',
    }));
  }

  it('serializes stale-claim recovery and releases the exact claim before reacquisition', async () => {
    const { statePath } = fixture();
    const recovery = await api();
    const raw = JSON.stringify({ active: true, run: 'original' });
    const claimPath = `${statePath}.emergency-recovery.claim`;
    writeFileSync(statePath, raw);
    writeDeadJournal(statePath, raw);
    writeFileSync(claimPath, JSON.stringify(owner({ pid: 999999999, processStart: '1' })));

    expect(recovery.recoverEmergencyStateFile(statePath)).toBe(true);
    expect(existsSync(claimPath)).toBe(false);
    writeFileSync(statePath, raw);
    writeDeadJournal(statePath, raw);
    expect(recovery.recoverEmergencyStateFile(statePath)).toBe(true);
    expect(existsSync(claimPath)).toBe(false);
  });

  it('does not reclaim an existing stale recovery claim without flock', async () => {
    const { statePath } = fixture();
    const recovery = await api();
    const raw = JSON.stringify({ active: true, run: 'original' });
    const claimPath = `${statePath}.emergency-recovery.claim`;
    const stale = owner({ pid: 999999999, processStart: '1' });
    writeFileSync(statePath, raw);
    writeDeadJournal(statePath, raw);
    writeFileSync(claimPath, JSON.stringify(stale));
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

    expect(recovery.recoverEmergencyStateFile(statePath)).toBe(false);
    expect(JSON.parse(readFileSync(claimPath, 'utf8'))).toEqual(stale);
    expect(readFileSync(statePath, 'utf8')).toBe(raw);
  });
});
