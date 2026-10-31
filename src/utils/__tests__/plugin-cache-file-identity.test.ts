import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Two distinct links whose 64-bit file IDs differ only below Number precision.
const lossyIds = new Map<string, bigint>();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const lstatSync = ((p: string, opts?: { bigint?: boolean }) => {
    const real = actual.lstatSync(p, opts as never) as import('fs').Stats | import('fs').BigIntStats;
    const id = lossyIds.get(String(p).toLowerCase());
    if (id === undefined) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: opts?.bigint ? id : Number(id) });
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync };
});

const { isUsableVersionPath, sameFileSystemIdentity } = await import('../plugin-cache-validation.js');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); lossyIds.clear(); });

function pluginTree(root: string): void {
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({}));
}

describe('plugin cache stale-version traversal with 64-bit link IDs', () => {
  it('rejects a candidate whose scripts/ reaches the stale version through nested links with colliding Number IDs', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-cache-linkkey-')); roots.push(root);
    const stale = join(root, 'stale'); pluginTree(stale);
    mkdirSync(join(stale, 's')); writeFileSync(join(stale, 's', 'run.cjs'), '');
    const mid = join(root, 'mid'); symlinkSync(stale, mid, 'junction');               // L2: mid -> stale
    const candidate = join(root, 'candidate'); pluginTree(candidate);
    symlinkSync(join(mid, 's'), join(candidate, 'scripts'), 'junction');              // L1: candidate/scripts -> mid/s
    const staleIdentity = statSync(stale, { bigint: true });

    // Control: with exact link IDs the stale traversal is detected.
    expect(isUsableVersionPath(candidate, staleIdentity)).toBe(false);

    lossyIds.set(join(candidate, 'scripts').toLowerCase(), 2n ** 53n);
    lossyIds.set(mid.toLowerCase(), 2n ** 53n + 1n);
    expect(Number(2n ** 53n)).toBe(Number(2n ** 53n + 1n));
    expect(isUsableVersionPath(candidate, staleIdentity)).toBe(false); // upstream/dev: true (L2 mistaken for an active loop on L1)
  });
});

describe('sameFileSystemIdentity with 64-bit file IDs', () => {
  const dev = 312828405n;
  const low = 2n ** 53n;
  const high = 2n ** 53n + 1n;
  const stats = (ino: bigint, device = dev) => ({ dev: device, ino }) as BigIntStats;

  it('keeps IDs beyond 2^53 that differ only in their low bits distinct', () => {
    expect(Number(low)).toBe(Number(high));
    expect(sameFileSystemIdentity(stats(low), stats(high))).toBe(false);
  });

  it('matches equal IDs beyond 2^53 on the same device only', () => {
    expect(sameFileSystemIdentity(stats(high), stats(high))).toBe(true);
    expect(sameFileSystemIdentity(stats(high), stats(high, dev + 1n))).toBe(false);
  });

  it('never matches a zero inode', () => {
    expect(sameFileSystemIdentity(stats(0n), stats(0n))).toBe(false);
  });
});
