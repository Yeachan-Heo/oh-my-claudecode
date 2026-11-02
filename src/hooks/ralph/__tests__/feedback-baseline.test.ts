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

describe('vitest summary clock', () => {
  const assertion = "AssertionError: expected 'a' to be 'b' // Object.is equality";
  // vitest's run output (colors off). "Start at" is the wall-clock time the run started, so it differs on every run.
  function vitestRun(startAt: string, failure: string | null = assertion): string {
    const lines = failure ? [' FAIL  src/math.test.js > fails', failure, ''] : [];
    lines.push(
      failure ? ' Test Files  1 failed | 1 passed (2)' : ' Test Files  1 passed (1)',
      failure ? '      Tests  1 failed | 2 passed (3)' : '      Tests  2 passed (2)',
      `   Start at  ${startAt}`,
      '   Duration  3.18s (transform 90ms, setup 0ms, import 119ms, tests 5ms, environment 0ms)',
    );
    return lines.join('\n');
  }

  it('fingerprints an unchanged green rerun identically', () => {
    const first = signatureLines(vitestRun('00:09:56', null));
    expect(first).toEqual(signatureLines(vitestRun('00:55:29', null)));
    expect(first.some((line) => line.includes('Start at'))).toBe(false);
  });

  it('reports no new failure for an unchanged red rerun and keeps its failure lines', () => {
    const first = signatureLines(vitestRun('00:09:56'));
    const second = signatureLines(vitestRun('00:55:29'));
    expect(first).toEqual(second);
    expect(first.some((line) => line.includes('Start at'))).toBe(false);
    expect(first).toContain('FAIL src/math.test.js > fails');
    expect(first).toContain(assertion);
    const diff = diffAgainstBaseline(baseline({ 'npm run test': { signatures: first } }), { 'npm run test': { signatures: second } });
    expect(diff.newSignatures).toEqual([]);
  });

  it('keeps a Start at clock that is part of an assertion message', () => {
    const line = "AssertionError: expected 'Start at 10:00:00' to be 'Start at 10:00:01' // Object.is equality";
    expect(signatureLines(line)).toEqual([line]);
  });

  it('keeps a Start at line that is not exactly the summary clock', () => {
    // vitest's diff lines for a multi-line string mismatch, a clock followed by more text, and a non-clock value.
    const lines = ['- Start at 10:00:01', '+ Start at 10:00:00', 'Start at 10:00:00 UTC', 'Start at noon'];
    expect(signatureLines(lines.join('\n'))).toEqual([...lines].sort());
  });

  it('still reports a changed assertion as new', () => {
    const changed = "AssertionError: expected 'a' to be 'c' // Object.is equality";
    const diff = diffAgainstBaseline(
      baseline({ 'npm run test': { signatures: signatureLines(vitestRun('00:09:56')) } }),
      { 'npm run test': { signatures: signatureLines(vitestRun('00:55:29', changed)) } },
    );
    expect(diff.newSignatures).toEqual([`npm run test: ${changed}`]);
  });
});
