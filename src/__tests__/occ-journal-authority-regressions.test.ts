import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearStateFileLocked,
  occCommitMutation,
  occReadCurrentState,
  writeStateFileLockedCreateIf,
  writeStateFileLockedIf,
} from '../lib/mode-state-io.js';

const tmpRoots: string[] = [];

function freshStateFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-occ-authority-'));
  tmpRoots.push(root);
  return join(root, 'state.json');
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OCC journal authority regressions', () => {
  it('records a non-OCC canonical replacement even when the following conditional mutation skips', () => {
    const filePath = freshStateFile();
    expect(occCommitMutation(filePath, () => ({ state: { owner: 'original' }, result: true }))).not.toBeNull();

    // This represents an installed legacy/emergency writer publishing a new
    // canonical generation directly. Its compact bytes are a preservation
    // contract, not formatting input for a later OCC reader.
    const replacementRaw = '{"owner":"replacement"}';
    writeFileSync(filePath, replacementRaw);

    expect(writeStateFileLockedIf(
      filePath,
      (state) => state.owner === 'original',
      (state) => ({ ...state, mutated: true }),
    )).toBe('skipped');

    expect(readFileSync(filePath, 'utf8')).toBe(replacementRaw);
    // A reader using the journal must not return the pre-replacement state.
    expect(occReadCurrentState(filePath)).toEqual({ owner: 'replacement' });

    // This cannot be satisfied by merely making the reader prefer canonical:
    // the durable journal itself must have sequenced the replacement.
    const journalDir = `${filePath}.journal`;
    const latestComplete = readdirSync(journalDir)
      .map((name) => ({ name, match: /^(\d+)\.([0-9a-f-]{36})\.complete$/i.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0];
    expect(latestComplete).toBeDefined();
    const entryPath = join(journalDir, `${latestComplete!.match[1]}.${latestComplete!.match[2]}.json`);
    expect(JSON.parse(readFileSync(entryPath, 'utf8')).state).toEqual({ owner: 'replacement' });
  });

  it('commits a clear tombstone so the journal cannot resurrect a removed canonical state', () => {
    const filePath = freshStateFile();
    expect(occCommitMutation(filePath, () => ({ state: { owner: 'live' }, result: true }))).not.toBeNull();

    expect(clearStateFileLocked(filePath)).toBe(true);
    expect(occReadCurrentState(filePath)).toBeNull();

    expect(writeStateFileLockedCreateIf(
      filePath,
      (state) => state === null,
      () => ({ owner: 'created-after-clear' }),
    )).toBe('written');
    expect(occReadCurrentState(filePath)).toEqual({ owner: 'created-after-clear' });
  });
});
