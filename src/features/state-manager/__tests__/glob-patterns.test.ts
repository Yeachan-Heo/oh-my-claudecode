import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { TEST_STATE_DIR, TEST_WORKTREE_ROOT } = vi.hoisted(() => ({
  TEST_STATE_DIR: '/tmp/omc-glob-test-state',
  TEST_WORKTREE_ROOT: '/tmp/omc-glob-test-worktree',
}));

vi.mock('../../../lib/worktree-paths.js', () => ({
  OmcPaths: {
    STATE: TEST_STATE_DIR,
  },
  getWorktreeRoot: () => TEST_WORKTREE_ROOT,
  validateWorkingDirectory: () => '/',
  getOmcRoot: (dir?: string) => `${dir ?? TEST_WORKTREE_ROOT}/.omc`,
}));

import { listStates, cleanupOrphanedStates } from '../index.js';

describe('state-manager glob patterns', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    fs.mkdirSync(TEST_WORKTREE_ROOT, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_WORKTREE_ROOT, { recursive: true, force: true });
  });

  function writeState(name: string, ageDays = 0): string {
    const filePath = path.join(TEST_STATE_DIR, `${name}.json`);
    fs.writeFileSync(filePath, '{}', 'utf-8');
    if (ageDays > 0) {
      const when = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(filePath, when, when);
    }
    return filePath;
  }

  // The mocked local state dir may also be reported as the global one, so de-duplicate.
  const names = (pattern: string) =>
    [...new Set(listStates({ pattern }).map((s) => s.name))].sort();

  it('treats regex metacharacters in a list pattern literally', () => {
    writeState('a.b');
    writeState('aXb');
    writeState('state(1)');

    expect(names('a.b')).toEqual(['a.b']);
    expect(names('state(1)')).toEqual(['state(1)']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still expands * as a wildcard', () => {
    writeState('ralph-state');
    writeState('ralph-state-2');
    writeState('team-state');

    expect(names('ralph-*')).toEqual(['ralph-state', 'ralph-state-2']);
    expect(names('*-state')).toEqual(['ralph-state', 'team-state']);
  });

  it('honors exclude patterns containing regex metacharacters during cleanup', () => {
    const keep = writeState('keep(1)', 60);
    const lookalike = writeState('keep1', 60);
    const dotted = writeState('a.b', 60);
    const dottedLookalike = writeState('aXb', 60);

    const result = cleanupOrphanedStates({
      maxAgeDays: 30,
      exclude: ['keep(1)', 'a.b'],
    });

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(dotted)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(false);
    expect(fs.existsSync(dottedLookalike)).toBe(false);
  });
});
