import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  baselinePath,
  diffAgainstBaseline,
  readBaseline,
  signatureLines,
  writeBaseline,
  type CommandBaseline,
  type FeedbackBaseline,
} from '../feedback-baseline.js';

function baseline(commands: Record<string, CommandBaseline>): FeedbackBaseline {
  return { version: 1, recordedAt: '2026-09-30T00:00:00.000Z', commands };
}

describe('signatureLines', () => {
  it('strips ANSI, durations, timestamps, and volatile ids so the same failure fingerprints identically across runs', () => {
    const first = signatureLines('\x1b[31mFAIL\x1b[0m suite/a.test.ts > boom in 123ms\nError: expected 1 to be 2');
    const second = signatureLines('FAIL suite/a.test.ts > boom in 4.5s\nError: expected 1 to be 2');
    expect(first).toEqual(second);
    expect(first.some((line) => line.includes('123ms'))).toBe(false);
  });

  it('keeps failure and summary lines but drops pure progress chatter', () => {
    const lines = signatureLines('Running tests...\n✓ ok\nFAIL a > b\nTest Files  1 failed | 2 passed\n');
    expect(lines).toContain('FAIL a > b');
    // Whitespace is collapsed so run-to-run formatting jitter cannot fake a new failure.
    expect(lines).toContain('Test Files 1 failed | 2 passed');
    expect(lines).not.toContain('Running tests...');
    expect(lines).not.toContain('✓ ok');
  });

  it('deduplicates, sorts, and caps runaway output', () => {
    const many = Array.from({ length: 500 }, (_, i) => `FAIL case ${i}`).join('\n');
    const lines = signatureLines(`${many}\nFAIL case 0`);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(new Set(lines).size).toBe(lines.length);
    expect([...lines].sort()).toEqual(lines);
  });
});

describe('diffAgainstBaseline', () => {
  it('reports only signatures absent from the baseline as new', () => {
    const diff = diffAgainstBaseline(
      baseline({ test: { signatures: ['FAIL old'] } }),
      { test: { signatures: ['FAIL old', 'FAIL new'] } },
    );
    expect(diff.newSignatures).toEqual(['test: FAIL new']);
    expect(diff.resolvedSignatures).toEqual([]);
  });

  it('treats the same test failing for a different reason as new (error line changed)', () => {
    const diff = diffAgainstBaseline(
      baseline({ test: { signatures: ['boom > expected 1 to be 2'] } }),
      { test: { signatures: ['boom > expected 1 to be 3'] } },
    );
    expect(diff.newSignatures).toEqual(['test: boom > expected 1 to be 3']);
  });

  it('treats baseline-only failures as resolved noise, never as new', () => {
    const diff = diffAgainstBaseline(
      baseline({ test: { signatures: ['FAIL env-specific'] } }),
      { test: { signatures: [] } },
    );
    expect(diff.newSignatures).toEqual([]);
    expect(diff.resolvedSignatures).toEqual(['test: FAIL env-specific']);
  });

  it('treats a command that used to run and now cannot execute as new', () => {
    const diff = diffAgainstBaseline(
      baseline({ test: { signatures: ['FAIL a'] } }),
      { test: { signatures: [], unrunnable: true } },
    );
    expect(diff.newSignatures).toEqual(['test: <command became unrunnable>']);
  });

  it('treats a command missing from the baseline as all-new, and a same-shape unrunnable as noise', () => {
    expect(diffAgainstBaseline(baseline({}), { lint: { signatures: ['FAIL lint'] } }).newSignatures).toEqual(['lint: FAIL lint']);
    expect(
      diffAgainstBaseline(baseline({ test: { signatures: [], unrunnable: true } }), { test: { signatures: [], unrunnable: true } }).newSignatures,
    ).toEqual([]);
  });

  it('with no baseline, reports everything present as new for the caller to interpret', () => {
    expect(diffAgainstBaseline(null, { test: { signatures: ['FAIL a', 'FAIL b'] } }).newSignatures).toEqual(['test: FAIL a', 'test: FAIL b']);
  });
});

describe('baseline IO', () => {
  it('round-trips a baseline and rejects malformed documents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      expect(path).toContain(join('state', 'sessions', 'sess-1', 'feedback-baseline.json'));
      expect(writeBaseline(path, { test: { signatures: ['FAIL a'] } })).toBe(true);
      expect(readBaseline(path)?.commands.test?.signatures).toEqual(['FAIL a']);
      expect(readBaseline(join(dir, 'nope.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});