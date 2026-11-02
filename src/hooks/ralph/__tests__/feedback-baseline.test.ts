import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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