import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, CLAUDE_MD_OPTOUT, CLAUDE_MD_VERSION, runCommand } from './helpers/omc-doctor-cache-fixture.js';

// Step 4 reads CLAUDE.md, the companion file it names and the other CLAUDE-*.md files of the config directory, and the
// opt-out probe reads .omc-config.json. Only a regular file is read, like the registry in Step 1: a FIFO (or any special
// file) in the place of one is skipped as if it were missing, because opening a FIFO without a writer never returns.
const step4 = CLAUDE_MD_VERSION;
const probe = CLAUDE_MD_OPTOUT;
const posix = process.platform !== 'win32';

const world = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-step4-'));
  mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  addCache(dir, ['5.9.0']);
  return dir;
};
const fifo = (file: string) => {
  const made = spawnSync('mkfifo', [file], { encoding: 'utf8' });
  expect({ file: path.basename(file), status: made.status }).toEqual({ file: path.basename(file), status: 0 });
};
// A hung command is killed by the timeout and reports it as `error`, so a pass shows the command returned by itself.
const run = (command: string, dir: string) => {
  const result = runCommand(command, dir, { timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
};

describe.skipIf(!posix)('omc-doctor Step 4 and the opt-out probe read regular files only', { timeout: 120_000 }, () => {
  test('a FIFO in the place of CLAUDE.md is a CLAUDE.md without a marker, and the command returns', () => {
    const dir = world();
    try {
      fifo(path.join(dir, 'CLAUDE.md'));
      const out = run(step4, dir);
      expect(out).toContain('CLAUDE.md OMC version: (missing marker)');
      expect(out).toContain('Latest cached plugin version: 5.9.0');
      expect(out).toContain('VERSION CHECK SKIPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FIFO in the place of the companion file that CLAUDE.md names is skipped', () => {
    const dir = world();
    try {
      writeFileSync(path.join(dir, 'CLAUDE.md'), 'See CLAUDE-extra.md for the rest.\n');
      fifo(path.join(dir, 'CLAUDE-extra.md'));
      expect(run(step4, dir)).toContain('CLAUDE.md OMC version: (missing marker)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FIFO among the CLAUDE-*.md files is skipped and the next file with the marker decides', () => {
    const dir = world();
    try {
      writeFileSync(path.join(dir, 'CLAUDE.md'), 'No marker here.\n');
      fifo(path.join(dir, 'CLAUDE-a.md'));
      writeFileSync(path.join(dir, 'CLAUDE-b.md'), '<!-- OMC:VERSION:5.9.0 -->\n');
      const out = run(step4, dir);
      expect(out).toContain('CLAUDE.md OMC version: 5.9.0');
      expect(out).toContain(`OMC version source: ${path.join(dir, 'CLAUDE-b.md')}`);
      expect(out).toContain('VERSION MATCH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a directory named like a companion file is skipped too', () => {
    const dir = world();
    try {
      writeFileSync(path.join(dir, 'CLAUDE.md'), 'No marker here.\n');
      mkdirSync(path.join(dir, 'CLAUDE-a.md'));
      writeFileSync(path.join(dir, 'CLAUDE-b.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
      const out = run(step4, dir);
      expect(out).toContain('CLAUDE.md OMC version: 5.8.0');
      expect(out).toContain('VERSION DRIFT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FIFO in the place of .omc-config.json leaves CLAUDE.md management enabled, and the probe returns', () => {
    const dir = world();
    try {
      fifo(path.join(dir, '.omc-config.json'));
      expect(run(probe, dir)).toContain('CLAUDE.md management enabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The probe answers from the file of the profile it is given, so the profile has to carry one: without it every
// directory answers "enabled" and a probe that reads the wrong directory is not noticed.
describe('omc-doctor opt-out probe', { timeout: 120_000 }, () => {
  test('a regular .omc-config.json decides: claudeMdEnabled false disables, anything else enables', () => {
    const dir = world();
    try {
      for (const [content, expected] of [
        [{ claudeMdEnabled: false }, 'CLAUDE.md management disabled by claudeMdEnabled: false'],
        [{ claudeMdEnabled: true }, 'CLAUDE.md management enabled'],
        [{}, 'CLAUDE.md management enabled'],
      ] as const) {
        writeFileSync(path.join(dir, '.omc-config.json'), JSON.stringify(content));
        expect({ content, out: run(probe, dir).trim() }).toEqual({ content, out: expected });
      }
      writeFileSync(path.join(dir, '.omc-config.json'), '{not json');
      expect(run(probe, dir).trim()).toBe('CLAUDE.md management enabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
