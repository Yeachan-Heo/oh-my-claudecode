import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * NTFS file ids are `(sequence << 48) | mftIndex`. Once the sequence number
 * reaches 32 the id exceeds Number.MAX_SAFE_INTEGER, and a Number `ino`
 * rounds distinct files onto one value. Every identity helper that guards a
 * lock or a publication must therefore stat with `{ bigint: true }`.
 */
const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

function functionBody(content: string, signature: string): string {
  const start = content.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  return content.substring(start, content.indexOf('\n}', start) + 2);
}

describe('file identity helpers stat with BigInt ids', () => {
  it.each([
    ['scripts/lib/state-lock.mjs', 'function ownerArtifactIdentity(path)'],
    ['src/lib/mode-state-io.ts', 'function lockArtifactIdentity(path: string)'],
    ['src/lib/mode-state-io.ts', 'function fileIdentity(path: string)'],
    ['scripts/lib/atomic-write.mjs', 'function fileIdentity(path)'],
    ['templates/hooks/lib/atomic-write.mjs', 'function fileIdentity(path)'],
    ['src/lib/atomic-write.ts', 'function descriptorStats('],
    ['src/lib/atomic-write.ts', 'function pathnameStats('],
    ['src/tools/deepinit-manifest.ts', 'function scanDirectories('],
  ])('%s %s', (file, signature) => {
    expect(functionBody(read(...file.split('/')), signature)).toContain('{ bigint: true }');
  });

  it('plugin-cache sameFileSystemIdentity compares BigInt dev and ino', () => {
    const body = functionBody(read('src', 'utils', 'plugin-cache-validation.ts'), 'function sameFileSystemIdentity(');
    expect(body).toContain("typeof left.ino === 'bigint'");
    expect(body).toContain("typeof right.ino === 'bigint'");
  });

  it('state-lock twins compare identities through the zero-dev tolerant helper', () => {
    const mjs = read('scripts', 'lib', 'state-lock.mjs');
    expect(functionBody(mjs, 'function sameArtifactIdentity(a, b)')).toContain("process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)");
    expect(mjs).not.toMatch(/\.dev [!=]== \w+\.dev (\|\||&&) \w+\.ino/);
  });

  it('mode-state-io compares every identity, including state generations, through sameFileIdentity', () => {
    const ts = read('src', 'lib', 'mode-state-io.ts');
    expect(functionBody(ts, 'function sameStateFileGeneration(')).toContain('sameFileIdentity(identity, expected)');
    expect(ts).not.toMatch(/\.dev [!=]== \w+\.dev (\|\||&&) \w+\.ino/);
  });
});
