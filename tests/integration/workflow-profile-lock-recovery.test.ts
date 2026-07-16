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

function processStart(pid = process.pid): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
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
      acquireStateFileLockSync(path: string, attempts?: number): { fd: number; lockPath: string; owner: ReturnType<typeof owner> } | null;
      releaseStateFileLockSync(lock: unknown): void;
      recoverEmergencyStateFile(path: string): boolean;
    }>;
  }

  it('reclaims a valid abandoned owner and PID-reuse identity', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    writeFileSync(lockPath, JSON.stringify(owner({ pid: 999999999, processStart: '1' })));
    const abandoned = lockApi.acquireStateFileLockSync(statePath, 2);
    expect(abandoned).not.toBeNull();
    lockApi.releaseStateFileLockSync(abandoned);

    writeFileSync(lockPath, JSON.stringify(owner({ processStart: String(Number(processStart()) + 1) })));
    const reused = lockApi.acquireStateFileLockSync(statePath, 2);
    expect(reused).not.toBeNull();
    lockApi.releaseStateFileLockSync(reused);
  });

  it('never reclaims a verifiably live holder', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    const live = owner();
    writeFileSync(lockPath, JSON.stringify(live));
    expect(lockApi.acquireStateFileLockSync(statePath, 2)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(live);
  });

  it('fails closed with deterministic diagnostics for corrupt metadata', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    writeFileSync(lockPath, 'corrupt');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(lockApi.acquireStateFileLockSync(statePath, 2)).toBeNull();
    expect(error).toHaveBeenCalledWith(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
    expect(readFileSync(lockPath, 'utf8')).toBe('corrupt');
  });

  it('does not let an old owner release a replacement lock', async () => {
    const { statePath, lockPath } = fixture();
    const lockApi = await api();
    const old = lockApi.acquireStateFileLockSync(statePath, 2)!;
    unlinkSync(lockPath);
    const replacement = owner();
    writeFileSync(lockPath, JSON.stringify(replacement));
    lockApi.releaseStateFileLockSync(old);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('serializes concurrent reclaimers without removing a live replacement', async () => {
    const { statePath, lockPath } = fixture();
    writeFileSync(lockPath, JSON.stringify(owner({ pid: 999999999, processStart: '1' })));
    const logPath = `${statePath}.critical.log`;
    const childScript = String.raw`
      import { appendFileSync } from 'node:fs';
      const [modulePath, statePath, logPath, id] = process.argv.slice(1);
      const api = await import(modulePath);
      const lock = api.acquireStateFileLockSync(statePath, 100);
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
