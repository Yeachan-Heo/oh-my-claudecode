import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { baselinePath, diffAgainstBaseline, readBaseline, signatureLines, writeBaseline, } from '../feedback-baseline.js';
function baseline(commands) {
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
        const diff = diffAgainstBaseline(baseline({ test: { signatures: ['FAIL old'] } }), { test: { signatures: ['FAIL old', 'FAIL new'] } });
        expect(diff.newSignatures).toEqual(['test: FAIL new']);
        expect(diff.resolvedSignatures).toEqual([]);
    });
    it('treats the same test failing for a different reason as new (error line changed)', () => {
        const diff = diffAgainstBaseline(baseline({ test: { signatures: ['boom > expected 1 to be 2'] } }), { test: { signatures: ['boom > expected 1 to be 3'] } });
        expect(diff.newSignatures).toEqual(['test: boom > expected 1 to be 3']);
    });
    it('treats baseline-only failures as resolved noise, never as new', () => {
        const diff = diffAgainstBaseline(baseline({ test: { signatures: ['FAIL env-specific'] } }), { test: { signatures: [] } });
        expect(diff.newSignatures).toEqual([]);
        expect(diff.resolvedSignatures).toEqual(['test: FAIL env-specific']);
    });
    it('treats a command that used to run and now cannot execute as new', () => {
        const diff = diffAgainstBaseline(baseline({ test: { signatures: ['FAIL a'] } }), { test: { signatures: [], unrunnable: true } });
        expect(diff.newSignatures).toEqual(['test: <command became unrunnable>']);
    });
    it('treats a command missing from the baseline as all-new, and a same-shape unrunnable as noise', () => {
        expect(diffAgainstBaseline(baseline({}), { lint: { signatures: ['FAIL lint'] } }).newSignatures).toEqual(['lint: FAIL lint']);
        expect(diffAgainstBaseline(baseline({ test: { signatures: [], unrunnable: true } }), { test: { signatures: [], unrunnable: true } }).newSignatures).toEqual([]);
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
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('node:test TAP output normalization (issue #4215)', () => {
    it('normalizes node:test prefix-style duration_ms values so reruns do not report new failures', () => {
        const run1 = signatureLines(`TAP version 13
ok 1 - test
  ---
  duration_ms: 0.925297
  ...`);
        const run2 = signatureLines(`TAP version 13
ok 1 - test
  ---
  duration_ms: 1.542103
  ...`);
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
                signatures: signatureLines(`TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.5
  ...
1..1
# tests 1
# pass 1
# duration_ms 2.5`),
            },
        });
        // New run with 2 passing tests.
        const current = {
            test: {
                signatures: signatureLines(`TAP version 13
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
# duration_ms 3.2`),
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
                signatures: signatureLines(`TAP version 13
ok 1 - test a
  ---
  duration_ms: 0.5
  ...
1..1
# tests 1
# pass 1
# duration_ms 2.5`),
            },
        });
        // New run with 1 passing test and 1 new failing test.
        const current = {
            test: {
                signatures: signatureLines(`TAP version 13
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
# duration_ms 3.2`),
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
//# sourceMappingURL=feedback-baseline.test.js.map