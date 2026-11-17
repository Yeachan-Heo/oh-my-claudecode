import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = resolve(HERE, '../../../scripts/record-pane-frames.mjs');

interface RecorderRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rpf-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('record-pane-frames extract', () => {
  function extract(from: string, ...extra: string[]): RecorderRun & { corpus: string } {
    const corpus = join(root, 'corpus');
    const result = spawnSync(process.execPath, [
      RECORDER, 'extract', '--from', from, '--state', 'idle', '--provider', 'claude', '--version', '1.0.0',
      '--corpus', corpus, ...extra,
    ], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, corpus };
  }

  it('keeps a pane line that starts with "=== " inside its frame', () => {
    const from = join(root, 'frames.txt');
    const second = 'building\n=== test results ===\n3 passed\n> \n';
    writeFileSync(from, `=== 1763340000.100\nfirst\n=== 1763340000.250\n${second}`);

    const last = extract(from);
    expect(last.code).toBe(0);
    expect(readFileSync(join(last.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe(second);

    expect(extract(from, '--frame', '0').code).toBe(0);
    expect(readFileSync(join(last.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe('first\n');
  });

  it('files a plain text file that starts with "=== " as one frame', () => {
    const from = join(root, 'plain.txt');
    const text = '=== summary ===\nall good\n> \n';
    writeFileSync(from, text);

    const result = extract(from);
    expect(result.code).toBe(0);
    expect(readFileSync(join(result.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe(text);
  });

  it('replaces the manifest entry for a state instead of adding a second one', () => {
    const from = join(root, 'frames.txt');
    writeFileSync(from, '=== 1763340000.100\nfirst\n=== 1763340000.250\nsecond\n');

    const first = extract(from, '--frame', '0', '--note', 'old');
    extract(from, '--frame', '1', '--cols', '80');

    const manifest = JSON.parse(readFileSync(join(first.corpus, 'manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ file: 'claude/1.0.0/idle.txt', state: 'idle', cols: 80, source: 'recorded' });
    expect(manifest[0]).not.toHaveProperty('note');
    expect(String(manifest[0]!.origin)).toMatch(/frames\.txt#1$/);
  });

  it('refuses a frame index the recording does not have', () => {
    const from = join(root, 'frames.txt');
    writeFileSync(from, '=== 1763340000.100\nonly\n');

    const result = extract(from, '--frame', '4');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--frame 4 is out of range (0..0)');
    expect(existsSync(join(result.corpus, 'manifest.json'))).toBe(false);
  });
});
