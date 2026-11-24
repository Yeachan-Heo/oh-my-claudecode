import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../../scripts/lib/cache-occupancy.mjs';

// Occupancy records as the tests of the omc-doctor cache commands write them.

// The start identity the SessionStart publisher records for this process (the platform's own form).
// On Windows the probe starts PowerShell with a 3 s limit, so it is read once, with retries, and reused.
let identityOfThisProcess: string | undefined;
export function ownIdentity(): string {
  if (identityOfThisProcess) return identityOfThisProcess;
  const probe = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
  try {
    let published = false;
    for (let attempt = 0; attempt < 3 && !published; attempt++) published = publishCacheOccupancy(probe, probe, process.pid);
    expect(published).toBe(true);
    const directory = path.join(probe, '.omc', 'cache-occupancy');
    identityOfThisProcess = JSON.parse(readFileSync(path.join(directory, readdirSync(directory)[0]), 'utf8')).processStartIdentity as string;
    return identityOfThisProcess;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// Publishes a record for this process with the publisher the SessionStart hook uses.
export function publishOwn(root: string, dir: string): boolean {
  return publishCacheOccupancy(root, dir, process.pid, ownIdentity());
}

// An occupancy record that is valid for this live process unless `overrides` says otherwise.
export function writeRecord(dir: string, root: string, overrides: Record<string, unknown> = {}): string {
  const record = { version: 1, pid: process.pid, processStartIdentity: ownIdentity(), pluginRoot: root, updatedAt: new Date().toISOString(), ...overrides };
  const directory = path.join(dir, '.omc', 'cache-occupancy');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

// The pid of a child that has already exited.
export function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(typeof child.pid).toBe('number');
  return child.pid as number;
}

export const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

// `kill(pid, 0)` of the command's process reports EPERM for the pid in EPERM_PID: the process exists
// but belongs to another user (a user that is not root cannot signal it).
export const epermPreload = `const real = process.kill;
process.kill = function (pid, signal) {
if (signal === 0 && pid === Number(process.env.EPERM_PID)) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
return real.call(process, pid, signal);
};
`;
