import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, bashBlocks, CACHE_VERSIONS, CLAUDE_MD_OPTOUT, CLAUDE_MD_VERSION, PLUGIN_ID, runCommand, skillText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

// Step 4 reads CLAUDE.md, the companion file it names and the other CLAUDE-*.md files of the config directory, and the
// opt-out probe reads .omc-config.json. Only a regular file is read, like the registry in Step 1, because opening a FIFO
// without a writer never returns. A FIFO or a directory is no companion of the scan (the shell block of the skill lists
// regular files only), but one in the place of CLAUDE.md, of the file CLAUDE.md names or of .omc-config.json is there and
// cannot be used: the command says so (unreadable, not a regular file) instead of printing it as a missing marker or as
// an enabled opt-out.
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
  test('a FIFO in the place of CLAUDE.md is an unreadable CLAUDE.md, not one without a marker, and the command returns', () => {
    const dir = world();
    try {
      fifo(path.join(dir, 'CLAUDE.md'));
      const out = run(step4, dir);
      expect(out).toContain('CLAUDE.md OMC version: (unreadable)');
      expect(out).toContain(`OMC version source: ${path.join(dir, 'CLAUDE.md')} (not a regular file)`);
      expect(out).toContain('Latest cached plugin version: 5.9.0');
      expect(out).toContain('VERSION CHECK SKIPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FIFO in the place of the companion file that CLAUDE.md names is unreadable too, and the command returns', () => {
    const dir = world();
    try {
      writeFileSync(path.join(dir, 'CLAUDE.md'), 'See CLAUDE-extra.md for the rest.\n');
      fifo(path.join(dir, 'CLAUDE-extra.md'));
      expect(run(step4, dir)).toContain('CLAUDE.md OMC version: (unreadable)');
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

  test('a FIFO in the place of .omc-config.json is neither enabled nor disabled, and the probe returns', () => {
    const dir = world();
    try {
      fifo(path.join(dir, '.omc-config.json'));
      expect(run(probe, dir)).toBe('CLAUDE.md management unknown: could not read .omc-config.json (not a regular file)\n');
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
      // Valid JSON that holds no claudeMdEnabled key is a file without the key: enabled, whatever its shape.
      for (const text of ['null', '[]', '5', '"x"']) {
        writeFileSync(path.join(dir, '.omc-config.json'), text);
        expect({ text, out: run(probe, dir).trim() }).toEqual({ text, out: 'CLAUDE.md management enabled' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A state that cannot be told from a plain value by the text of one line is named: a file that is there and cannot be
// used (a directory, a link to nothing, an empty file where JSON is wanted) is not a missing file, a file without the
// marker or an enabled opt-out, and a plugin cache that cannot be read is not an empty one. The cases with links are POSIX
// only (a link to nothing is made with a relative target that is not there). No case uses a permission bit: a test run as
// root, as in some CI containers, reads any file, so a file that cannot be read is made with a link to nothing or with a
// file in the place of a directory.
const GONE = 'no-such-target';
const MARKER = '<!-- OMC:VERSION:5.9.0 -->\n';
describe.skipIf(!posix)('omc-doctor claude-md-version names a CLAUDE source it cannot read', { timeout: 120_000 }, () => {
  const check = (setup: (dir: string) => void) => {
    const dir = world();
    try {
      setup(dir);
      return { dir, out: run(step4, dir) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test.each([
    ['a directory in the place of CLAUDE.md', (d: string) => mkdirSync(path.join(d, 'CLAUDE.md')), 'not a regular file'],
    ['a link to nothing in the place of CLAUDE.md', (d: string) => symlinkSync(GONE, path.join(d, 'CLAUDE.md')), 'ENOENT'],
    ['a link to nothing as the default companion', (d: string) => { writeFileSync(path.join(d, 'CLAUDE.md'), 'No marker.\n'); symlinkSync(GONE, path.join(d, 'CLAUDE-omc.md')); }, 'ENOENT'],
    ['a link to nothing as the companion CLAUDE.md names', (d: string) => { writeFileSync(path.join(d, 'CLAUDE.md'), 'See CLAUDE-extra.md.\n'); symlinkSync(GONE, path.join(d, 'CLAUDE-extra.md')); }, 'ENOENT'],
    // The marker of a file ahead of the one that has it could have decided, so an unreadable CLAUDE.md is not skipped.
    ['a link to nothing in the place of CLAUDE.md and a marker in the companion', (d: string) => { symlinkSync(GONE, path.join(d, 'CLAUDE.md')); writeFileSync(path.join(d, 'CLAUDE-omc.md'), MARKER); }, 'ENOENT'],
  ])('%s is unreadable, not a CLAUDE.md without a marker, and no version is compared', (_label, setup, reason) => {
    const { dir, out } = check(setup);
    expect(out).toContain('CLAUDE.md OMC version: (unreadable)');
    expect(out).toMatch(new RegExp(`OMC version source: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/CLAUDE[^ ]*[.]md \\(${reason}\\)`));
    expect(out).toContain('Latest cached plugin version: 5.9.0');
    expect(out).toContain('VERSION CHECK SKIPPED: a CLAUDE source cannot be read');
    expect(out).not.toMatch(/missing marker|VERSION (MATCH|DRIFT)/);
  });

  test('a directory or a FIFO named CLAUDE-omc.md is no companion, as for any other CLAUDE-*.md: the next file decides', () => {
    for (const make of [(f: string) => mkdirSync(f), fifo]) {
      const out = check((d) => { writeFileSync(path.join(d, 'CLAUDE.md'), 'No marker.\n'); make(path.join(d, 'CLAUDE-omc.md')); writeFileSync(path.join(d, 'CLAUDE-z.md'), MARKER); }).out;
      expect(out).toContain('CLAUDE.md OMC version: 5.9.0');
      expect(out).toContain('VERSION MATCH');
    }
  });

  test('CLAUDE-omc.md is read first, ahead of a CLAUDE-*.md that sorts before it', () => {
    const out = check((d) => {
      writeFileSync(path.join(d, 'CLAUDE.md'), 'No marker.\n');
      writeFileSync(path.join(d, 'CLAUDE-a.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
      writeFileSync(path.join(d, 'CLAUDE-omc.md'), MARKER);
    }).out;
    expect(out).toContain('CLAUDE.md OMC version: 5.9.0');
  });

  test('what is not there is skipped, and an unreadable file after the one that decides does not matter', () => {
    // CLAUDE.md names a file that is not there: a CLAUDE.md without a marker, as before.
    expect(check((d) => writeFileSync(path.join(d, 'CLAUDE.md'), 'See CLAUDE-gone.md.\n')).out).toContain('CLAUDE.md OMC version: (missing marker)');
    // No CLAUDE.md at all: the same.
    expect(check(() => {}).out).toContain('CLAUDE.md OMC version: (missing marker)');
    // The marker of CLAUDE.md decides; the companion after it is a link to nothing.
    const decided = check((d) => { writeFileSync(path.join(d, 'CLAUDE.md'), MARKER); symlinkSync(GONE, path.join(d, 'CLAUDE-omc.md')); }).out;
    expect(decided).toContain('CLAUDE.md OMC version: 5.9.0');
    expect(decided).toContain('VERSION MATCH');
  });

  test('a plugin cache that cannot be read is an unknown version with a note, an empty or missing one is none', () => {
    const cases: Array<[string, (d: string) => void, boolean]> = [
      ['a link to nothing as the cache directory', (d) => { rmSync(path.join(d, 'plugins', 'cache', 'omc'), { recursive: true }); mkdirSync(path.join(d, 'plugins', 'cache', 'omc')); symlinkSync(GONE, path.join(d, 'plugins', 'cache', 'omc', 'oh-my-claudecode')); }, true],
      ['a file as the cache directory', (d) => { rmSync(path.join(d, 'plugins', 'cache', 'omc', 'oh-my-claudecode'), { recursive: true }); writeFileSync(path.join(d, 'plugins', 'cache', 'omc', 'oh-my-claudecode'), 'x'); }, true],
      ['an empty cache directory', (d) => { rmSync(path.join(d, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0'), { recursive: true }); }, false],
      ['no cache directory', (d) => { rmSync(path.join(d, 'plugins', 'cache'), { recursive: true }); }, false],
    ];
    for (const [label, setup, unreadable] of cases) {
      const { dir, out } = check((d) => { writeFileSync(path.join(d, 'CLAUDE.md'), MARKER); setup(d); });
      const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
      expect({ label, unknown: out.includes('Latest cached plugin version: (unknown)'), none: out.includes('Latest cached plugin version: (none)') }).toEqual({ label, unknown: unreadable, none: !unreadable });
      expect({ label, note: out.includes(`Note: the plugin cache ${cache} cannot be read, so its version is unknown`) }).toEqual({ label, note: unreadable });
      expect({ label, skipped: out.includes(unreadable ? 'VERSION CHECK SKIPPED: the plugin cache cannot be read, so no version is compared' : 'VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache') }).toEqual({ label, skipped: true });
      expect(out).not.toMatch(/VERSION (MATCH|DRIFT)/);
    }
  });

  test('one cache of two marketplaces that cannot be read leaves the version unknown even when the other names one', () => {
    const { out } = check((d) => {
      writeFileSync(path.join(d, 'CLAUDE.md'), MARKER);
      writeRegistry(d, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }], 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.9.0' }] });
      mkdirSync(path.join(d, 'plugins', 'cache', 'oh-my-claudecode'), { recursive: true });
      symlinkSync(GONE, path.join(d, 'plugins', 'cache', 'oh-my-claudecode', 'oh-my-claudecode'));
    });
    expect(out).toContain('Latest cached plugin version: (unknown)');
    expect(out).toContain('VERSION CHECK SKIPPED: the plugin cache cannot be read');
  });

  test('a registry that cannot be used leaves open which cache the session runs: unknown, not the cache of omc', () => {
    for (const [label, setup] of [
      ['text that is not JSON', (d: string) => writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), '{not json')],
      ['a link to nothing', (d: string) => symlinkSync(GONE, path.join(d, 'plugins', 'installed_plugins.json'))],
      ['an entry list that is not a list', (d: string) => writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), JSON.stringify({ [PLUGIN_ID]: 'x' }))],
      // As in Step 1, a look-alike key with no supported ID could be an install of OMC, so the cache of omc is not assumed.
      ['a look-alike key and no supported ID', (d: string) => writeRegistry(d, { 'oh-my-claudecode-fork@mkt': [{ scope: 'user', version: '5.9.0' }] })],
    ] as const) {
      const { out } = check((d) => { writeFileSync(path.join(d, 'CLAUDE.md'), MARKER); setup(d); });
      expect({ label, unknown: out.includes('Latest cached plugin version: (unknown)'), skipped: out.includes('VERSION CHECK SKIPPED: installed_plugins.json cannot be used, so no cache is chosen') }).toEqual({ label, unknown: true, skipped: true });
      expect(out).not.toMatch(/VERSION (MATCH|DRIFT)/);
    }
    // No registry at all is the npm channel, and a look-alike key beside a supported ID changes nothing: the cache of omc is compared.
    expect(check((d) => writeFileSync(path.join(d, 'CLAUDE.md'), MARKER)).out).toContain('VERSION MATCH');
    const beside = check((d) => { writeFileSync(path.join(d, 'CLAUDE.md'), MARKER); writeRegistry(d, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }], 'oh-my-claudecode-fork@mkt': [{ scope: 'user', version: '5.9.0' }] }); }).out;
    expect(beside).toContain('VERSION MATCH');
  });

  test('Step 6 says it could not read a cache that is a file or a link to nothing, and 0 versions only for one that is not there', () => {
    for (const make of [(c: string) => writeFileSync(c, 'x'), (c: string) => symlinkSync(GONE, c)]) {
      const dir = world();
      try {
        const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        rmSync(cache, { recursive: true });
        make(cache);
        expect(run(CACHE_VERSIONS, dir).trim()).toMatch(/^could not read .*oh-my-claudecode \((ENOTDIR|ENOENT)\)$/);
        rmSync(cache, { force: true });
        expect(run(CACHE_VERSIONS, dir)).toBe('0 versions\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// Nothing here needs a link or a FIFO, so the cases run on every platform.
describe('omc-doctor opt-out probe names a file it cannot use', { timeout: 120_000 }, () => {
  test('a directory, an empty file and text that is not JSON give unknown with the reason, never enabled', () => {
    const dir = world();
    try {
      const file = path.join(dir, '.omc-config.json');
      mkdirSync(file);
      expect(run(probe, dir)).toBe('CLAUDE.md management unknown: could not read .omc-config.json (not a regular file)\n');
      rmSync(file, { recursive: true });
      for (const text of ['', '   \n', '{not json', '{"claudeMdEnabled": false,}']) {
        writeFileSync(file, text);
        expect({ text, out: run(probe, dir) }).toEqual({ text, out: 'CLAUDE.md management unknown: could not read .omc-config.json (not valid JSON)\n' });
      }
      writeFileSync(file, '{"claudeMdEnabled": false}');
      expect(run(probe, dir)).toBe('CLAUDE.md management disabled by claudeMdEnabled: false\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The marker line of the shell block of Step 4: grep fails with 2 for a file it cannot read and with 1 for one without
// the marker, and only the second is "missing".
describe.skipIf(!posix)('omc-doctor Step 4 shell block tells a CLAUDE.md it cannot read from one without the marker', { timeout: 120_000 }, () => {
  const block = bashBlocks().find((b) => b.includes('Has OMC config"')) ?? '';
  const markerLine = (setup: (dir: string) => void) => {
    const dir = world();
    try {
      setup(dir);
      const out = spawnSync('/bin/bash', ['-c', block], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir } }).stdout;
      return out.split('\n').find((line) => /OMC config|Could not read/.test(line) && !line.includes('companion'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test('a marker, no marker, no file, a directory and a link to nothing', () => {
    expect(block).not.toBe('');
    expect(markerLine((d) => writeFileSync(path.join(d, 'CLAUDE.md'), '<!-- OMC:START -->\n'))).toBe('Has OMC config');
    expect(markerLine((d) => writeFileSync(path.join(d, 'CLAUDE.md'), 'No marker.\n'))).toBe('Missing OMC config in CLAUDE.md');
    expect(markerLine(() => {})).toBe('Missing OMC config in CLAUDE.md');
    expect(markerLine((d) => mkdirSync(path.join(d, 'CLAUDE.md')))).toBe('Could not read CLAUDE.md');
    expect(markerLine((d) => symlinkSync(GONE, path.join(d, 'CLAUDE.md')))).toBe('Could not read CLAUDE.md');
  });
});

// The rules are written where the model reads them: the fix writes CLAUDE.md, so it has to stop for a file that is there and
// cannot be read (a link to nothing would be written through to a target somewhere else), and the diagnosis names the lines.
describe('omc-doctor skill: the CLAUDE.md fix and the diagnosis name the lines of Step 4 for a file that cannot be used', () => {
  test('the fix is skipped for a CLAUDE.md that cannot be read, and the diagnosis and the opt-out rule name the new lines', () => {
    expect(skillText).toContain('and when it printed `Could not read CLAUDE.md` or the version `(unreadable)`: write nothing through a file that cannot be read.');
    expect(skillText).toContain('`Could not read CLAUDE.md`: WARN, it is there and unreadable');
    expect(skillText).toContain('`(unreadable)` as the CLAUDE.md version or a `Note:` about an unreadable plugin cache or an unusable `installed_plugins.json`: WARN');
    expect(skillText).toContain('`not a regular file`, or `not valid JSON`');
    expect(skillText).toContain('`(none)`, `(unknown)` and `(unreadable)` are no versions');
  });
});
