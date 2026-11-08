import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeStateFileLockedCreateIf, writeStateFileLockedIf } from '../mode-state-io.js';

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function fixture(mode = 'ralph'): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'omc-mode-activation-'));
  fixtures.push(root);
  const path = join(root, 'state', 'sessions', 's1', `${mode}-state.json`);
  mkdirSync(dirname(path), { recursive: true });
  return { root, path };
}

function starts(root: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(root, 'state', 'runs', 'ledger.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'start');
  } catch {
    return [];
  }
}

const always = () => true;
const set = (next: Record<string, unknown>) => () => next;

describe('run-ledger start edges from conditional state writes', () => {
  it('logs a start when a missing state is created active', () => {
    const { root, path } = fixture();
    expect(writeStateFileLockedCreateIf(path, always, set({ active: true }))).toBe('written');
    expect(starts(root)).toEqual([expect.objectContaining({ run: 'ralph', sessionId: 's1', event: 'start' })]);
  });

  it('does not log again for an active-to-active write', () => {
    const { root, path } = fixture();
    writeStateFileLockedCreateIf(path, always, set({ active: true }));
    writeStateFileLockedCreateIf(path, always, set({ active: true, iteration: 2 }));
    writeStateFileLockedIf(path, always, (current) => ({ ...current, iteration: 3 }));
    expect(starts(root)).toHaveLength(1);
  });

  it('logs a start when an inactive state becomes active', () => {
    const { root, path } = fixture();
    writeStateFileLockedCreateIf(path, always, set({ active: false }));
    expect(starts(root)).toHaveLength(0);
    expect(writeStateFileLockedIf(path, always, (current) => ({ ...current, active: true }))).toBe('written');
    expect(starts(root)).toHaveLength(1);
  });

  it('does not log when a run is deactivated', () => {
    const { root, path } = fixture();
    writeStateFileLockedCreateIf(path, always, set({ active: false }));
    writeStateFileLockedIf(path, always, (current) => ({ ...current, active: false, iteration: 2 }));
    expect(starts(root)).toHaveLength(0);
  });

  it('ignores modes the ledger does not watch', () => {
    const { root, path } = fixture('deep-interview');
    writeStateFileLockedCreateIf(path, always, set({ active: true }));
    expect(starts(root)).toHaveLength(0);
  });

  it('logs the next run even when another process removed the previous state', () => {
    const { root, path } = fixture();
    writeStateFileLockedCreateIf(path, always, set({ active: true }));
    unlinkSync(path);
    writeStateFileLockedCreateIf(path, always, set({ active: true }));
    expect(starts(root)).toHaveLength(2);
  });
});
