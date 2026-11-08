import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NTFS file IDs are 64-bit and are often above Number.MAX_SAFE_INTEGER
// (observed here: 32651097304794447). As a JS Number, two IDs that differ only in
// the low bits round to the same value. Model two such directories exactly.
const lossyIds = new Map<string, bigint>();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((p: string, opts?: { bigint?: boolean }) => {
    const real = actual.statSync(p, opts as never) as import('node:fs').Stats | import('node:fs').BigIntStats;
    const id = lossyIds.get(String(p));
    if (id === undefined) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: opts?.bigint ? id : Number(id) });
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

const { scanDirectories } = await import('../deepinit-manifest.js');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); lossyIds.clear(); });

describe('deepinit scanDirectories with 64-bit file IDs', () => {
  it('does not treat two distinct directories as a symlink loop when their IDs collide as Numbers', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-deepinit-ino-')); roots.push(root);
    for (const name of ['a', 'b']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'index.ts'), ''); }
    lossyIds.set(join(root, 'a'), 2n ** 53n);
    lossyIds.set(join(root, 'b'), 2n ** 53n + 1n);
    expect(Number(2n ** 53n)).toBe(Number(2n ** 53n + 1n)); // the precision loss itself
    expect(Object.keys(scanDirectories(root)).sort()).toEqual(['a', 'b']); // upstream/dev: ['a']
  });
});
