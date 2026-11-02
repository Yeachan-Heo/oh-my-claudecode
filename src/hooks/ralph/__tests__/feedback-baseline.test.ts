import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  baselinePath,
  diffAgainstBaseline,
  FEEDBACK_BASELINE_HISTORY_DIRNAME,
  MAX_FEEDBACK_BASELINE_HISTORY,
  readBaseline,
  recordBaseline,
  signatureLines,
  writeBaseline,
  type CommandBaseline,
  type FeedbackBaseline,
} from '../feedback-baseline.js';

// chmod-based failure injection does not restrict UID 0, so those tests would
// assert failure against a write that actually succeeds under root.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

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

  it('normalizes parenthesized pytest clock durations so identical runs fingerprint identically', () => {
    const first = signatureLines('1 failed, 200 passed in 194.32s (0:03:14)');
    const second = signatureLines('1 failed, 200 passed in 201.07s (0:03:21)');
    expect(first).toEqual(second);
    expect(first).toEqual(['1 failed, 200 passed in <v> <v>']);
  });

  it('normalizes pytest clock durations with hours and fractional seconds', () => {
    expect(signatureLines('1 failed, 200 passed in 194.32s (1:02:45)')).toEqual(['1 failed, 200 passed in <v> <v>']);
    expect(signatureLines('1 failed, 200 passed in 194.32s (0:03:14.123)')).toEqual(['1 failed, 200 passed in <v> <v>']);
  });

  it('normalizes two-component m:ss clock durations (third component is optional)', () => {
    const first = signatureLines('1 failed, 200 passed in 194.32s (3:14)');
    const second = signatureLines('1 failed, 200 passed in 201.07s (3:21)');
    expect(first).toEqual(second);
    expect(first).toEqual(['1 failed, 200 passed in <v> <v>']);
  });

  it('normalizes clock durations behind integer-second prefixes (no decimal part)', () => {
    const first = signatureLines('1 failed, 200 passed in 194s (3:14)');
    const second = signatureLines('1 failed, 200 passed in 201s (3:21)');
    expect(first).toEqual(second);
    expect(first).toEqual(['1 failed, 200 passed in <v> <v>']);
  });

  it('keeps the pytest summary clock normalized only in its duration context', () => {
    const first = signatureLines('1 failed, 200 passed in 194.32s (0:03:14)');
    const second = signatureLines('1 failed, 200 passed in 194.32s (0:03:21)');
    expect(first).toEqual(second);
    expect(first).toEqual(['1 failed, 200 passed in <v> <v>']);
  });

  it('does not erase clock-like assertion values: a changed failure reason stays distinct', () => {
    const first = signatureLines("AssertionError: assert '(12:15)' == '(12:16)'");
    const second = signatureLines("AssertionError: assert '(12:17)' == '(12:18)'");
    expect(first).toEqual(["AssertionError: assert '(12:15)' == '(12:16)'"]);
    expect(second).toEqual(["AssertionError: assert '(12:17)' == '(12:18)'"]);
    expect(first).not.toEqual(second);
  });

  it('keeps failure text on a line that also carries a duration', () => {
    const lines = signatureLines('FAIL tests/test_x.py::test_foo - AssertionError in 194.32s (0:03:14)');
    expect(lines).toEqual(['FAIL tests/test_x.py::test_foo - AssertionError in <v> <v>']);
    expect(lines[0]).toContain('AssertionError');
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

  it('reports signatures under a command that disappeared from the current set as resolved', () => {
    const diff = diffAgainstBaseline(
      baseline({ test: { signatures: ['FAIL gone'] }, lint: { signatures: ['FAIL kept'] } }),
      { lint: { signatures: ['FAIL kept'] } },
    );
    expect(diff.newSignatures).toEqual([]);
    expect(diff.resolvedSignatures).toEqual(['test: FAIL gone']);
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

  it('keeps a replaced baseline in history and the newest document at the live path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      const first = recordBaseline(path, { test: { signatures: ['FAIL old'] } }, new Date('2026-09-30T00:00:00.000Z'));
      expect(first.previousPath).toBeUndefined();
      expect(first.added).toBe(0);
      expect(first.removed).toBe(0);

      const second = recordBaseline(path, { test: { signatures: ['FAIL old'] } }, new Date('2026-10-01T00:00:00.000Z'));
      expect(second.written).toBe(true);
      expect(second.previousPath).toBeDefined();
      expect(existsSync(second.previousPath as string)).toBe(true);
      const history = readdirSync(join(dir, 'state', 'sessions', 'sess-1', FEEDBACK_BASELINE_HISTORY_DIRNAME));
      expect(history).toHaveLength(1);
      expect(history[0]).toContain('2026-09-30T00-00-00.000Z-1.json');

      // The archived document is the first one; the live path holds the second.
      expect(readBaseline(second.previousPath as string)).toEqual({
        version: 1,
        recordedAt: '2026-09-30T00:00:00.000Z',
        commands: { test: { signatures: ['FAIL old'] } },
      });
      expect(readBaseline(path)?.recordedAt).toBe('2026-10-01T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports signatures added and removed by a re-record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      recordBaseline(path, { test: { signatures: ['FAIL a', 'FAIL b'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const result = recordBaseline(path, { test: { signatures: ['FAIL b', 'FAIL c', 'FAIL d'] } }, new Date('2026-10-01T00:00:00.000Z'));
      expect(result.added).toBe(2);
      expect(result.removed).toBe(1);
      expect(result.previousPath).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts the stored signatures a replacement removed when a command becomes unrunnable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      recordBaseline(path, { test: { signatures: ['FAIL a', 'FAIL b'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const result = recordBaseline(path, { test: { signatures: [], unrunnable: true } }, new Date('2026-10-01T00:00:00.000Z'));

      // The audit describes the document replacement, not the gate marker.
      expect(result.added).toBe(0);
      expect(result.removed).toBe(2);
      expect(result.becameUnrunnable).toEqual(['test']);
      // Gate semantics remain untouched: the command is still newly unrunnable.
      const diff = diffAgainstBaseline(readBaseline(result.previousPath as string), readBaseline(path)?.commands ?? {});
      expect(diff.newSignatures).toEqual(['test: <command became unrunnable>']);
      expect(diff.resolvedSignatures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps colliding same-timestamp archives distinct and retains the newest below the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      const now = new Date('2026-09-30T00:00:00.000Z');
      recordBaseline(path, { test: { signatures: ['FAIL 0'] } }, now);
      const secondDoc = readFileSync(path);
      const second = recordBaseline(path, { test: { signatures: ['FAIL 1'] } }, now);
      expect(second.previousPath).toBeDefined();
      expect(readFileSync(second.previousPath as string)).toEqual(secondDoc);

      const thirdDoc = readFileSync(path);
      const third = recordBaseline(path, { test: { signatures: ['FAIL 2'] } }, now);
      expect(third.previousPath).not.toBe(second.previousPath);
      expect(readFileSync(third.previousPath as string)).toEqual(thirdDoc);

      // Continue with the same `recordedAt` so every archive shares one stamp.
      const total = MAX_FEEDBACK_BASELINE_HISTORY + 5;
      let last = third;
      for (let index = 3; index <= total; index += 1) {
        last = recordBaseline(path, { test: { signatures: [`FAIL ${index}`] } }, now);
      }

      const historyDir = join(dir, 'state', 'sessions', 'sess-1', FEEDBACK_BASELINE_HISTORY_DIRNAME);
      const history = readdirSync(historyDir).filter((name) => name.endsWith('.json'));
      expect(history).toHaveLength(MAX_FEEDBACK_BASELINE_HISTORY);
      // The newest archive is the document the final write replaced.
      expect(readBaseline(last.previousPath as string)?.commands.test?.signatures).toEqual([`FAIL ${total - 1}`]);

      // Retention keeps the newest MAX documents, not whichever names sort first.
      const archived = history
        .map((name) => readBaseline(join(historyDir, name))?.commands.test?.signatures?.[0])
        .sort();
      const expected = Array.from({ length: MAX_FEEDBACK_BASELINE_HISTORY }, (_, offset) => `FAIL ${total - MAX_FEEDBACK_BASELINE_HISTORY + offset}`);
      expect(archived).toEqual(expected.sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the history at the configured maximum, pruning the oldest entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      const total = MAX_FEEDBACK_BASELINE_HISTORY + 5;
      for (let index = 0; index < total; index += 1) {
        recordBaseline(
          path,
          { test: { signatures: [`FAIL ${index}`] } },
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        );
      }
      const history = readdirSync(join(dir, 'state', 'sessions', 'sess-1', FEEDBACK_BASELINE_HISTORY_DIRNAME)).sort();
      expect(history).toHaveLength(MAX_FEEDBACK_BASELINE_HISTORY);
      // The first four records were pruned; the oldest survivor is record 4.
      expect(history[0]).toContain('2026-01-01T00-00-04.000Z');
      expect(readBaseline(path)?.commands.test?.signatures).toEqual([`FAIL ${total - 1}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prunes the archive it just created when newer-named entries fill the history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      recordBaseline(path, { test: { signatures: ['FAIL original'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const historyDir = join(dir, 'state', 'sessions', 'sess-1', FEEDBACK_BASELINE_HISTORY_DIRNAME);
      mkdirSync(historyDir, { recursive: true });
      // Entries that sort AFTER the new archive's old `recordedAt` stem.
      for (let index = 0; index < MAX_FEEDBACK_BASELINE_HISTORY; index += 1) {
        writeFileSync(join(historyDir, `2099-01-01T00-00-${String(index).padStart(2, '0')}.000Z-1.json`), '{}\n', 'utf8');
      }

      const result = recordBaseline(path, { test: { signatures: ['FAIL next'] } }, new Date('2026-10-01T00:00:00.000Z'));

      expect(result.written).toBe(true);
      expect(result.previousPath).toBeDefined();
      expect(existsSync(result.previousPath as string)).toBe(true);
      expect(readBaseline(result.previousPath as string)?.commands.test?.signatures).toEqual(['FAIL original']);
      expect(readdirSync(historyDir).filter((name) => name.endsWith('.json'))).toHaveLength(MAX_FEEDBACK_BASELINE_HISTORY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without touching the live baseline when history cannot be archived', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      recordBaseline(path, { test: { signatures: ['FAIL original'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const before = readFileSync(path);
      // A regular file where the history directory must go makes archiving fail.
      writeFileSync(join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME), 'not a directory', 'utf8');

      const result = recordBaseline(path, { test: { signatures: ['FAIL changed'] } }, new Date('2026-10-01T00:00:00.000Z'));

      expect(result.written).toBe(false);
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('covers archive-failure path: fails when history directory is unwritable (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    const path = baselinePath(dir, 'sess-1');
    try {
      recordBaseline(path, { test: { signatures: ['FAIL original'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const before = readFileSync(path);
      const historyDir = join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME);
      mkdirSync(historyDir, { recursive: true });
      // Make the history directory read-only so copyFileSync fails.
      chmodSync(historyDir, 0o555);

      const result = recordBaseline(path, { test: { signatures: ['FAIL changed'] } }, new Date('2026-10-01T00:00:00.000Z'));

      expect(result.written).toBe(false);
      expect(readFileSync(path)).toEqual(before);
      // Verify no stale archive was created in the failed attempt.
      chmodSync(historyDir, 0o755);
      const history = readdirSync(historyDir).filter((name) => name.endsWith('.json'));
      expect(history).toHaveLength(0); // archiveBaseline failed, so no archive was created
    } finally {
      // Reset permissions before cleanup.
      try {
        chmodSync(join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME), 0o755);
      } catch (_err) {
        // Ignore cleanup errors when resetting permissions.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('retains the archived file when the live write fails, so a partial write keeps its intact recovery copy (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    const path = baselinePath(dir, 'sess-1');
    try {
      recordBaseline(path, { test: { signatures: ['FAIL first'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const before = readFileSync(path);
      const historyDir = join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME);

      // Make the baseline file read-only so writeFileSync fails after the archive.
      chmodSync(path, 0o444);
      const result = recordBaseline(path, { test: { signatures: ['FAIL second'] } }, new Date('2026-10-01T00:00:00.000Z'));
      expect(result.written).toBe(false);

      // The archive must survive: a partially written live file leaves it as the
      // only intact copy of the document that was being replaced.
      chmodSync(path, 0o644);
      const history = readdirSync(historyDir).filter((name) => name.endsWith('.json'));
      expect(history).toHaveLength(1);
      expect(readFileSync(join(historyDir, history[0]))).toEqual(before);
      expect(readBaseline(join(historyDir, history[0]))?.commands.test?.signatures).toEqual(['FAIL first']);
    } finally {
      try {
        chmodSync(path, 0o644);
      } catch (_err) {
        // Ignore cleanup errors when resetting permissions.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prunes the archive created by the current call, even when its timestamp sorts before newer entries (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      recordBaseline(path, { test: { signatures: ['FAIL v1'] } }, new Date('2026-09-30T00:00:00.000Z'));
      const historyDir = join(dir, 'state', 'sessions', 'sess-1', FEEDBACK_BASELINE_HISTORY_DIRNAME);
      mkdirSync(historyDir, { recursive: true });
      // Fill the history with entries that sort after the old baseline's timestamp.
      for (let index = 0; index < MAX_FEEDBACK_BASELINE_HISTORY; index += 1) {
        writeFileSync(join(historyDir, `2099-12-31T23-59-${String(index).padStart(2, '0')}.000Z-1.json`), '{"version":1}\n', 'utf8');
      }

      const result = recordBaseline(path, { test: { signatures: ['FAIL v2'] } }, new Date('2026-10-01T00:00:00.000Z'));

      expect(result.written).toBe(true);
      expect(result.previousPath).toBeDefined();
      expect(existsSync(result.previousPath as string)).toBe(true);
      expect(readBaseline(result.previousPath as string)?.commands.test?.signatures).toEqual(['FAIL v1']);
      const history = readdirSync(historyDir).filter((n) => n.endsWith('.json'));
      expect(history).toHaveLength(MAX_FEEDBACK_BASELINE_HISTORY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles concurrent archive creation: retries collision detection until a unique filename is found (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      const now = new Date('2026-09-30T00:00:00.000Z');
      recordBaseline(path, { test: { signatures: ['FAIL first'] } }, now);

      // Simulate a collision: pre-create the archive that would be created next.
      const secondDoc = readFileSync(path);
      const secondPath = recordBaseline(path, { test: { signatures: ['FAIL second'] } }, now).previousPath;
      expect(secondPath).toBeDefined();
      expect(existsSync(secondPath as string)).toBe(true);

      // Re-record with the same timestamp; archiveBaseline should find the collision and use the next counter.
      const thirdDoc = readFileSync(path);
      const third = recordBaseline(path, { test: { signatures: ['FAIL third'] } }, now);
      expect(third.previousPath).toBeDefined();
      expect(third.previousPath).not.toBe(secondPath);
      expect(existsSync(third.previousPath as string)).toBe(true);
      expect(readFileSync(third.previousPath as string)).toEqual(thirdDoc);

      // Verify all archives are byte-identical to what they replaced.
      expect(readFileSync(secondPath as string)).toEqual(secondDoc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mark a newly added unrunnable command as "became unrunnable" (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      // First record has no lint command.
      recordBaseline(path, { test: { signatures: ['FAIL a'] } }, new Date('2026-09-30T00:00:00.000Z'));
      // Second record adds a lint command that is unavailable (unrunnable).
      const result = recordBaseline(
        path,
        { test: { signatures: ['FAIL a'] }, lint: { signatures: [], unrunnable: true } },
        new Date('2026-10-01T00:00:00.000Z'),
      );

      // The newly added lint command should NOT appear in becameUnrunnable,
      // because it was never runnable in the replaced baseline.
      expect(result.becameUnrunnable).toBeUndefined();
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks an existing runnable command as "became unrunnable" in the audit (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      // First record has lint as runnable.
      recordBaseline(path, { test: { signatures: ['FAIL a'] }, lint: { signatures: ['FAIL lint'] } }, new Date('2026-09-30T00:00:00.000Z'));
      // Second record marks lint as unrunnable.
      const result = recordBaseline(
        path,
        { test: { signatures: ['FAIL a'] }, lint: { signatures: [], unrunnable: true } },
        new Date('2026-10-01T00:00:00.000Z'),
      );

      // The lint command transitions from runnable to unrunnable, so it should be reported.
      expect(result.becameUnrunnable).toEqual(['lint']);
      expect(result.removed).toBe(1); // One signature from lint was removed.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts removed commands when a feedback command is dropped entirely (issue #4798)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-'));
    try {
      const path = baselinePath(dir, 'sess-1');
      // First record has both test and lint.
      recordBaseline(
        path,
        { test: { signatures: ['FAIL test-a', 'FAIL test-b'] }, lint: { signatures: ['FAIL lint-a'] } },
        new Date('2026-09-30T00:00:00.000Z'),
      );
      // Second record drops lint entirely (removed command).
      const result = recordBaseline(path, { test: { signatures: ['FAIL test-a', 'FAIL test-b'] } }, new Date('2026-10-01T00:00:00.000Z'));

      // The audit must count signatures from the removed lint command.
      expect(result.removed).toBe(1);
      expect(result.added).toBe(0);
      // The replacement is auditable in history: the archive keeps the dropped
      // command and its signature, while the live document no longer has it.
      const archived = readBaseline(result.previousPath as string);
      expect(archived?.commands.lint).toEqual({ signatures: ['FAIL lint-a'] });
      expect(readBaseline(path)?.commands ?? {}).not.toHaveProperty('lint');
      // The audit must report the union of old and new command keys.
      const diff = diffAgainstBaseline(archived, readBaseline(path)?.commands ?? {});
      expect(diff.resolvedSignatures).toEqual(['lint: FAIL lint-a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const WORKER_SOURCE = (moduleUrl: string): string => `
import { existsSync, writeFileSync } from 'node:fs';
import { recordBaseline } from ${JSON.stringify(moduleUrl)};

const [baselinePath, signature, readySelf, readyOther] = process.argv.slice(2);
writeFileSync(readySelf, '');
const deadline = Date.now() + 10000;
while (!existsSync(readyOther)) {
  if (Date.now() > deadline) break;
  await new Promise((done) => setTimeout(done, 5));
}
const result = recordBaseline(
  baselinePath,
  { test: { signatures: ['FAIL ' + signature] } },
  new Date('2026-10-01T00:00:00.000Z'),
);
process.stdout.write(JSON.stringify({ written: result.written, previousPath: result.previousPath ?? null }));
`;

function runWorker(
  children: ChildProcess[],
  workerPath: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`worker timed out\nstderr: ${stderr}`));
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, stdout, stderr });
    });
  });
}

describe('cross-process baseline serialization', () => {
  it('serializes overlapping writers so each replacement archives the document that preceded it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-fb-xproc-'));
    const children: ChildProcess[] = [];
    try {
      const path = baselinePath(dir, 'sess-1');
      expect(
        recordBaseline(path, { test: { signatures: ['FAIL original'] } }, new Date('2026-09-30T00:00:00.000Z')).written,
      ).toBe(true);

      const workerPath = join(dir, 'worker.mjs');
      writeFileSync(
        workerPath,
        WORKER_SOURCE(pathToFileURL(join(repoRoot, 'src/hooks/ralph/feedback-baseline.ts')).href),
        'utf8',
      );

      const readyA = join(dir, 'ready-a');
      const readyB = join(dir, 'ready-b');
      // Each worker waits for the OTHER's ready file, so the two recordBaseline
      // transactions genuinely overlap instead of running back to back.
      const [a, b] = await Promise.all([
        runWorker(children, workerPath, [path, 'writer-a', readyA, readyB]),
        runWorker(children, workerPath, [path, 'writer-b', readyB, readyA]),
      ]);

      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const resultA = JSON.parse(a.stdout.trim()) as { written: boolean; previousPath: string | null };
      const resultB = JSON.parse(b.stdout.trim()) as { written: boolean; previousPath: string | null };
      expect(resultA.written).toBe(true);
      expect(resultB.written).toBe(true);
      expect(resultA.previousPath).not.toBeNull();
      expect(resultB.previousPath).not.toBeNull();
      // Distinct archives are the whole point: the second writer must archive
      // the first replacement instead of overwriting it unarchived.
      expect(resultA.previousPath).not.toBe(resultB.previousPath);

      const archived = [readBaseline(resultA.previousPath as string), readBaseline(resultB.previousPath as string)];
      const archivedSignals = archived.map((doc) => doc?.commands.test?.signatures?.[0]);
      const liveSignal = readBaseline(path)?.commands.test?.signatures?.[0];

      expect(['FAIL writer-a', 'FAIL writer-b']).toContain(liveSignal);
      const firstWriterSignal = liveSignal === 'FAIL writer-a' ? 'FAIL writer-b' : 'FAIL writer-a';
      // Together the archives preserve the original and the first replacement.
      expect(archivedSignals).toContain('FAIL original');
      expect(archivedSignals).toContain(firstWriterSignal);
      // The lock must not leak after either transaction.
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('pytest summary normalization (issue #4795)', () => {
  it('adding a passing test does not register as a new failure', () => {
    const baseline1 = baseline({
      'python3 -m pytest -q': { signatures: signatureLines('200 passed in 0.31s') },
    });
    const current = {
      'python3 -m pytest -q': { signatures: signatureLines('201 passed in 0.32s') },
    };
    const diff = diffAgainstBaseline(baseline1, current);
    expect(diff.newSignatures).toEqual([]);
  });

  it('keeps pytest summaries that report failures and flags them as new against a green baseline', () => {
    const green = baseline({
      'python3 -m pytest -q': { signatures: signatureLines('200 passed in 0.31s') },
    });
    const current = {
      'python3 -m pytest -q': { signatures: signatureLines('1 failed, 200 passed in 0.32s') },
    };
    expect(current['python3 -m pytest -q'].signatures).toContain('1 failed, 200 passed in <v>');
    const diff = diffAgainstBaseline(green, current);
    expect(diff.newSignatures).toEqual(['python3 -m pytest -q: 1 failed, 200 passed in <v>']);
  });

  it('excludes all-pass summaries regardless of whether the duration is normalized to <v> tokens', () => {
    // This PR alone: the parenthesized wall-clock duration is still literal.
    expect(signatureLines('459 passed, 14 warnings in 194.32s (0:03:14)')).toEqual([]);
    // Composed with the duration PR: every duration fragment is already "<v>".
    expect(signatureLines('459 passed, 14 warnings in <v> <v>')).toEqual([]);
    // Failures are still signal in either normalized shape.
    expect(signatureLines('1 failed, 200 passed in <v> <v>')).toContain('1 failed, 200 passed in <v> <v>');
  });
});

describe('node:test TAP output normalization (issue #4215)', () => {
  it('normalizes node:test prefix-style duration_ms values so reruns do not report new failures', () => {
    const run1 = signatureLines(
      `TAP version 13
ok 1 - test
  ---
  duration_ms: 0.925297
  ...`,
    );
    const run2 = signatureLines(
      `TAP version 13
ok 1 - test
  ---
  duration_ms: 1.542103
  ...`,
    );
    // Both runs should produce identical signatures despite different durations.
    expect(run1).toEqual(run2);
    expect(run1.some((line) => line.includes('duration_ms'))).toBe(false);
  });

  it('excludes pass/test count summary lines to prevent false positives when tests are added', () => {
    const output = `TAP version 13
ok 1 - a
ok 2 - b
1..2
# tests 2
# pass 2
# fail 0
# duration_ms 10.5`;
    const lines = signatureLines(output);
    // Pass/test counters should be excluded.
    expect(lines).not.toContain('# tests 2');
    expect(lines).not.toContain('# pass 2');
    // No # lines should remain when there are no failures.
    expect(lines).toEqual([]);
  });

  it('keeps failure count summary lines to detect real regressions', () => {
    const output = `TAP version 13
not ok 1 - boom
1..1
# tests 1
# fail 1`;
    const lines = signatureLines(output);
    // Failure counter should be kept.
    expect(lines).toContain('# fail 1');
  });

  it('unchanged rerun produces no new failure signatures (issue #4215 regression)', () => {
    // Simulate baseline from first run with same failures and durations.
    const run1Output = `TAP version 13
ok 1 - passing test
  ---
  duration_ms: 0.925297
  type: 'test'
  ...
not ok 2 - failing test
  ---
  duration_ms: 0.600102
  type: 'test'
  error: boom
  ...
1..2
# tests 2
# pass 1
# fail 1
# duration_ms 10.5`;

    const baseline1 = baseline({
      test: {
        signatures: signatureLines(run1Output),
      },
    });

    // Simulate second run with same failures but different durations and pass counts.
    const run2Output = `TAP version 13
ok 1 - passing test
  ---
  duration_ms: 1.234567
  type: 'test'
  ...
not ok 2 - failing test
  ---
  duration_ms: 0.987654
  type: 'test'
  error: boom
  ...
1..2
# tests 2
# pass 1
# fail 1
# duration_ms 12.3`;

    const current = {
      test: {
        signatures: signatureLines(run2Output),
      },
    };

    const diff = diffAgainstBaseline(baseline1, current);
    // Should report no NEW failures (duration and pass count changed, but not the actual failures).
    expect(diff.newSignatures).toEqual([]);
  });

  it('adding a passing test does not register as a new failure (issue #4215 regression)', () => {
    // Baseline with 1 passing test.
    const baseline1 = baseline({
      test: {
        signatures: signatureLines(
          `TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.5
  ...
1..1
# tests 1
# pass 1
# duration_ms 2.5`,
        ),
      },
    });

    // New run with 2 passing tests.
    const current = {
      test: {
        signatures: signatureLines(
          `TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.6
  ...
ok 2 - test b
  ---
  duration_ms: 0.7
  ...
1..2
# tests 2
# pass 2
# duration_ms 3.2`,
        ),
      },
    };

    const diff = diffAgainstBaseline(baseline1, current);
    // No new failures even though the pass count changed.
    expect(diff.newSignatures).toEqual([]);
  });

  it('adding a genuinely new failing test is correctly detected', () => {
    // Baseline with 1 passing test.
    const baseline1 = baseline({
      test: {
        signatures: signatureLines(
          `TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.5
  ...
1..1
# tests 1
# pass 1
# duration_ms 2.5`,
        ),
      },
    });

    // New run with 1 passing test and 1 new failing test.
    const current = {
      test: {
        signatures: signatureLines(
          `TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.6
  ...
not ok 2 - test b new failure
  ---
  duration_ms: 0.7
  error: Expected 1 to equal 2
  ...
1..2
# tests 2
# pass 1
# fail 1
# duration_ms 3.2`,
        ),
      },
    };

    const diff = diffAgainstBaseline(baseline1, current);
    // New failure should be detected.
    expect(diff.newSignatures.some((s) => s.includes('not ok 2'))).toBe(true);
  });

  it('normalizes both colon and space-separated TAP duration formats', () => {
    const withColon = signatureLines('duration_ms: 123.45');
    const withSpace = signatureLines('duration_ms 123.45');
    expect(withColon).toEqual(withSpace);
    expect(withColon.some((line) => line.includes('duration'))).toBe(false);
  });
});

describe('pytest progress lines (issue #4794)', () => {
  it('does not fingerprint progress dots, so 200 vs 201 passing tests yields no new signatures', () => {
    const run1 = signatureLines(`${'.'.repeat(200)} [ 36%]\n${'.'.repeat(200)} [100%]`);
    const run2 = signatureLines(`${'.'.repeat(201)} [ 35%]\n${'.'.repeat(201)} [100%]`);
    expect(run1).toEqual([]);
    expect(run2).toEqual([]);
    const diff = diffAgainstBaseline(baseline({ test: { signatures: run1 } }), { test: { signatures: run2 } });
    expect(diff.newSignatures).toEqual([]);
  });

  it('drops an all-pass progress line but keeps a line carrying a failure marker', () => {
    // pytest -qq emits only the progress line for a quiet run; a red run's F is the sole failure signal.
    expect(signatureLines('.                                              [100%]')).toEqual([]);
    const lines = signatureLines('.F                                              [100%]');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('F');
  });

  it('still keeps real pytest failure lines and a failing progress line', () => {
    const lines = signatureLines(`${'.'.repeat(200)}F [ 36%]\nFAILED tests/test_x.py::test_y - assert 1 == 2`);
    expect(lines).toContain('FAILED tests/test_x.py::test_y - assert 1 == 2');
    expect(lines).toContain(`${'.'.repeat(200)}F [ 36%]`);
  });
});