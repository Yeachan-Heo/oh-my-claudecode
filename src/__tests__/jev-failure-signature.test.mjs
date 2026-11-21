/**
 * Tests for scripts/lib/jev-failure-signature.mjs: the masked error signature (line numbers,
 * times, temp paths and hex do not change it; different errors differ; cut to 200), the series
 * key (tool, signature) and its path-keyed variant for mutating commands, and the nudge/final
 * threshold overrides.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FINAL_THRESHOLD,
  DEFAULT_NUDGE_THRESHOLD,
  SIGNATURE_MAX,
  errorSeriesKey,
  failureSignature,
  finalThreshold,
  hashSignature,
  mutatedFilePath,
  nudgeThreshold,
} from '../../scripts/lib/jev-failure-signature.mjs';

describe('failureSignature', () => {
  it('masks line numbers, times, temp paths and hex so one loop keeps one signature', () => {
    // line numbers (numbers masked to #)
    expect(failureSignature('Error: boom at /p/app.ts:42:15')).toBe(failureSignature('Error: boom at /p/app.ts:99:22'));
    // times and dates
    expect(failureSignature('request failed after 1723 ms')).toBe(failureSignature('request failed after 2048 ms'));
    expect(failureSignature('at 2026-11-14 10:31:22.123 the build broke')).toBe(failureSignature('at 2026-11-14 10:31:59.999 the build broke'));
    // temp paths
    expect(failureSignature("Error: ENOENT: no such file or directory, open '/tmp/aaa/x.json'"))
      .toBe(failureSignature("Error: ENOENT: no such file or directory, open '/tmp/bbb/x.json'"));
    expect(failureSignature("open '/tmp/file1.txt' failed")).toBe(failureSignature("open '/tmp/file2.txt' failed"));
    // long hex (hash, message id)
    expect(failureSignature('got reply 4f3d2c1b0a9f8e7d for task')).toBe(failureSignature('got reply 0a1b2c3d4e5f6071 for task'));
    // different errors, different signatures
    expect(failureSignature('Error: ENOENT: no such file or directory')).not.toBe(failureSignature('Error: EACCES: permission denied'));
    expect(failureSignature('Error: ENOENT')).not.toBe(failureSignature('Warning: deprecation'));
    // first line only
    expect(failureSignature('first line\n--\nbacktrace xyz')).toBe(failureSignature('first line\n--\nbacktrace abc'));
    expect(failureSignature('\n\n  second is not the first \nend')).toBe(failureSignature('second is not the first'));
  });

  it('cuts the signature to SIGNATURE_MAX characters deterministically', () => {
    const long = `Error: ${'x'.repeat(400)}`;
    expect(failureSignature(long).length).toBe(SIGNATURE_MAX);
    expect(failureSignature(long)).toBe(`Error: ${'x'.repeat(SIGNATURE_MAX - 'Error: '.length)}`);
  });

  it('handles empty and null errors', () => {
    expect(failureSignature('')).toBe('');
    expect(failureSignature(null)).toBe('');
  });
});

describe('thresholds', () => {
  it('keeps the documented defaults 3 and 4', () => {
    expect(DEFAULT_NUDGE_THRESHOLD).toBe(3);
    expect(DEFAULT_FINAL_THRESHOLD).toBe(4);
    expect(nudgeThreshold({})).toBe(3);
    expect(finalThreshold({})).toBe(4);
  });

  it('honors environment overrides and falls back on invalid values', () => {
    expect(nudgeThreshold({ OMC_JEV_FAILURE_SERIES_NUDGE: '5' })).toBe(5);
    expect(finalThreshold({ OMC_JEV_FAILURE_SERIES_FINAL: '6' })).toBe(6);
    expect(nudgeThreshold({ OMC_JEV_FAILURE_SERIES_NUDGE: 'x' })).toBe(3);
  });
});

describe('finalThreshold fallback', () => {
  it('falls back to the default on invalid values', () => {
    expect(finalThreshold({ OMC_JEV_FAILURE_SERIES_FINAL: '-2' })).toBe(4);
    expect(finalThreshold({ OMC_JEV_FAILURE_SERIES_FINAL: '0' })).toBe(4);
    expect(finalThreshold({ OMC_JEV_FAILURE_SERIES_FINAL: undefined })).toBe(4);
  });
});

describe('errorSeriesKey', () => {
  it('keys plain errors by (tool, signature)', () => {
    const a = errorSeriesKey('Bash', { command: 'grep x .' }, 'Error: ENOENT: no such file or directory');
    const b = errorSeriesKey('Bash', { command: 'grep y .' }, 'Error: EACCES: permission denied');
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(errorSeriesKey('Bash', { command: 'grep z .' }, 'Error: ENOENT: no such file or directory').key);
    expect(a.key).not.toBe(errorSeriesKey('Read', { file_path: 'a' }, 'Error: ENOENT').key);
    expect(a.key).toMatch(/^Bash\|[0-9a-f]{16}$/);
    expect(a.path).toBeNull();
    expect(a.pathHash).toBeNull();
  });

  it('keys mutating commands on the same file by (tool, path)', () => {
    const rm1 = errorSeriesKey('Bash', { command: 'rm -f /tmp/file-a.json' }, 'Error: EPERM: operation not permitted');
    const rm2 = errorSeriesKey('Bash', { command: 'rm -f /tmp/file-a.json' }, 'rm: cannot remove: Is a directory');
    expect(rm1.key).toBe(rm2.key);
    expect(rm1.key).toMatch(/^mut\|Bash\|[0-9a-f]{16}$/);
    expect(rm1.path).toBe('/tmp/file-a.json');
    expect(rm1.key).not.toBe(errorSeriesKey('Bash', { command: 'rm -f /tmp/file-b.json' }, 'Error: EPERM: operation not permitted').key);
  });

  it('recognizes mutating commands and rejects non-mutating ones', () => {
    expect(mutatedFilePath('Bash', { command: 'mv old.txt new.txt' })).toBe('new.txt');
    expect(mutatedFilePath('Bash', { command: "sed -i 's/a/b/' config.yml" })).toBe('config.yml');
    expect(mutatedFilePath('Bash', { command: "sed 's/a/b/' config.yml" })).toBeNull();
    expect(mutatedFilePath('Bash', { command: 'tee result.log < input' })).toBe('result.log');
    expect(mutatedFilePath('Bash', { command: 'git apply patch.diff' })).toBe('patch.diff');
    expect(mutatedFilePath('Bash', { command: 'git status' })).toBeNull();
    expect(mutatedFilePath('Bash', { command: 'rm -f file > /dev/null' })).toBe('file');
    expect(mutatedFilePath('Bash', { command: 'cat file && rm file' })).toBeNull();
    expect(mutatedFilePath('Bash', { command: 'echo hello' })).toBeNull();
    expect(mutatedFilePath('Read', { file_path: '/tmp/file-a.json' })).toBeNull();
  });
});

describe('hashSignature', () => {
  it('hashes the signature deterministically into 16 hex characters', () => {
    expect(hashSignature('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashSignature('abc')).toBe(hashSignature('abc'));
    expect(hashSignature('abc')).not.toBe(hashSignature('abd'));
  });
});
