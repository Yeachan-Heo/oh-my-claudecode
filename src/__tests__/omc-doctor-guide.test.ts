import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ROOT, SCRIPT, read } from './helpers/omc-doctor-cache-fixture.js';

// `guide <section>` prints one section of scripts/omc-doctor-guide.md, the details that the skill leaves out. The skill
// stops a cache repair on it, so a file that cannot be read has to end with a message and exit code 1, and a name that is
// no section with exit code 2. Plain Node on plain files: the same on every platform.
const GUIDE_FILE = path.join(ROOT, 'scripts', 'omc-doctor-guide.md');
const guideText = read('scripts/omc-doctor-guide.md');
const sectionsOf = (text: string) =>
  text
    .split(/^(?=## )/m)
    .filter((part) => part.startsWith('## '))
    .map((part) => ({ name: part.slice(3, part.indexOf('\n')).trim(), text: part.trimEnd() }));
const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 });

// A copy of the script in a directory of its own, with whatever the test puts beside it.
const withScript = (body: (dir: string, script: string) => void) => {
  const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor guide '));
  try {
    const dir = path.join(base, 'a dir', 'scripts');
    mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'omc-doctor.mjs');
    copyFileSync(SCRIPT, script);
    body(dir, script);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

describe('omc-doctor: the guide command prints one section of the guide file', { timeout: 120_000 }, () => {
  const sections = sectionsOf(guideText);

  test('the guide file is a list of named sections with a text each, and no name is used twice', () => {
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(section.text.split('\n').slice(1).join('\n').trim().length, section.name).toBeGreaterThan(100);
    }
    expect(new Set(sections.map((section) => section.name)).size).toBe(sections.length);
    // Nothing but the title and its introduction stands before the first section.
    expect(guideText.slice(0, guideText.indexOf('## ')).trim().split('\n')[0]).toBe('# omc-doctor guide');
  });

  test('every section is printed whole, heading included, with exit code 0 and nothing on stderr', () => {
    for (const section of sections) {
      const result = run(SCRIPT, 'guide', section.name);
      expect({ name: section.name, status: result.status, stderr: result.stderr }).toEqual({ name: section.name, status: 0, stderr: '' });
      expect(result.stdout).toBe(section.text + '\n');
    }
  });

  test('a name that is no section, a missing name and a name with a different case end with 2 and list the sections', () => {
    for (const args of [['nope'], [], [sections[0].name.toUpperCase()], [sections[0].name + ' '], ['## ' + sections[0].name], ['']]) {
      const result = run(SCRIPT, 'guide', ...args);
      expect({ args, status: result.status, stdout: result.stdout }).toEqual({ args, status: 2, stdout: '' });
      expect(result.stderr).toContain('omc-doctor.mjs: unknown guide section');
      for (const section of sections) expect(result.stderr).toContain(section.name);
    }
  });

  test('without the guide file beside the script the command ends with 1 and a message that names the file, and prints nothing', () => {
    withScript((dir, script) => {
      const result = run(script, 'guide', sections[0].name);
      expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 1, stdout: '' });
      expect(result.stderr).toContain('omc-doctor: guide not found');
      expect(result.stderr).toContain(path.join(dir, 'omc-doctor-guide.md'));
      expect(result.stderr).toContain('Reinstall or update the plugin');
      // The other commands do not need the guide and do not read it.
      expect(run(script, 'cache-versions').status).toBe(0);
    });
  });

  test('a directory, or an empty file, in the place of the guide file is no guide: exit 1 for the directory, exit 2 for the empty file', () => {
    withScript((dir, script) => {
      mkdirSync(path.join(dir, 'omc-doctor-guide.md'));
      const directory = run(script, 'guide', sections[0].name);
      expect({ status: directory.status, stdout: directory.stdout }).toEqual({ status: 1, stdout: '' });
      expect(directory.stderr).toContain('omc-doctor: guide not found');
    });
    withScript((dir, script) => {
      writeFileSync(path.join(dir, 'omc-doctor-guide.md'), '');
      const empty = run(script, 'guide', sections[0].name);
      expect({ status: empty.status, stdout: empty.stdout }).toEqual({ status: 2, stdout: '' });
    });
  });

  test('the guide is found beside the script wherever the script lies, also in a path with spaces, and a CRLF file is printed without CR', () => {
    withScript((dir, script) => {
      copyFileSync(GUIDE_FILE, path.join(dir, 'omc-doctor-guide.md'));
      const first = sections[0];
      expect(run(script, 'guide', first.name)).toMatchObject({ status: 0, stdout: first.text + '\n' });
      writeFileSync(path.join(dir, 'omc-doctor-guide.md'), guideText.replace(/\n/g, '\r\n'));
      const crlf = run(script, 'guide', first.name);
      expect(crlf).toMatchObject({ status: 0, stdout: first.text + '\n' });
      expect(crlf.stdout).not.toContain('\r');
    });
  });

  test('only the heading at the start of a line makes a section: a heading in a code span or in a deeper heading does not', () => {
    withScript((dir, script) => {
      writeFileSync(path.join(dir, 'omc-doctor-guide.md'), '# title\n\n## one\n\ntext with `## two` inside\n### three\n\n## two\n\nsecond\n');
      expect(run(script, 'guide', 'one').stdout).toBe('## one\n\ntext with `## two` inside\n### three\n');
      expect(run(script, 'guide', 'two').stdout).toBe('## two\n\nsecond\n');
      expect(run(script, 'guide', 'three').status).toBe(2);
    });
  });
});
