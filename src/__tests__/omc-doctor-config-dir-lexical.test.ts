import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCache, bashBlocks, CACHE_VERSIONS, CLAUDE_MD_VERSION, commands, locatorLine, PLUGIN_ID, runBlock, runCommand, skillText, STEP1, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
// @ts-expect-error Standalone runtime source is intentionally JavaScript-only.
import { getClaudeConfigDir } from '../../scripts/lib/config-dir.mjs';

// The runtime reads CLAUDE_CONFIG_DIR as text (getClaudeConfigDir normalizes it), so a `..` after a link folds the link
// away: `<base>/link/../cfg` is `<base>/cfg`. The file system reads the same path as the parent of the link's target. The
// script and the shell blocks of the skill follow the runtime, so they all read the same directory.
const posix = process.platform !== 'win32';

// The first line of a shell block, and the blocks that use the directory.
const blocks = bashBlocks().filter((b) => b.includes('"$C"'));
const prelude = blocks[0].split('\n')[0];

type Fixture = { base: string; textual: string; physical: string };
// `<base>/cfg` is where the runtime reads, `<base>/real/cfg` where the file system leads through `link/..` (a decoy with
// other versions), and `link` points at `<base>/real/x`.
const fixture = (): Fixture => {
  const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-lexical-'));
  const textual = path.join(base, 'cfg');
  const physical = path.join(base, 'real', 'cfg');
  mkdirSync(path.join(base, 'real', 'x'), { recursive: true });
  symlinkSync(path.join('real', 'x'), path.join(base, 'link'));
  for (const [dir, version] of [[textual, '5.8.0'], [physical, '5.1.0']] as const) {
    mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    writeFileSync(path.join(dir, 'hooks', version === '5.8.0' ? 'keyword-detector.sh' : 'decoy.sh'), '#!/bin/bash\n');
    writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version }] });
    addCache(dir, version === '5.8.0' ? ['5.7.0', '5.8.0'] : ['5.0.0', '5.1.0']);
    writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${version} -->\n`);
  }
  return { base, textual, physical };
};

const shell = (script: string, configured: string, home: string) =>
  spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: home, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });

describe.skipIf(!posix)('omc-doctor: a .. after a link in CLAUDE_CONFIG_DIR is read as the runtime reads it', { timeout: 120_000 }, () => {
  // The text is joined by hand: path.join would fold the .. before the script sees it, and the script would never be given
  // a .. that comes after a link (a file system that resolves the link first reads `real/cfg`, not `cfg`).
  const written = (f: Fixture) => `${f.base}/link/../cfg`;
  const forms = (f: Fixture): Array<[string, string]> => [
    ['an absolute path', written(f)],
    ['a path under the home directory', `~/link/../cfg`],
  ];

  test('the runtime, every script command and every shell block read the directory the text names', () => {
    const f = fixture();
    try {
      for (const [label, configured] of forms(f)) {
        // The runtime (scripts/lib/config-dir.mjs) with the same environment.
        const saved = { dir: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME };
        process.env.CLAUDE_CONFIG_DIR = configured;
        process.env.HOME = f.base;
        const runtime = getClaudeConfigDir() as string;
        process.env.CLAUDE_CONFIG_DIR = saved.dir;
        process.env.HOME = saved.home;
        if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        expect({ label, runtime }).toEqual({ label, runtime: f.textual });

        const env = { env: { CLAUDE_CONFIG_DIR: configured, HOME: f.base, USERPROFILE: f.base } };
        const one = runCommand(STEP1, f.textual, env);
        expect({ label, step1: one.stdout }).toEqual({ label, step1: expect.stringContaining('Installed: 5.8.0') });
        const four = runBlock(CLAUDE_MD_VERSION, f.textual, env);
        expect({ label, step4: four.stdout }).toEqual({ label, step4: expect.stringContaining('CLAUDE.md OMC version: 5.8.0') });
        expect({ label, step4: four.stdout }).toEqual({ label, step4: expect.stringContaining('Latest cached plugin version: 5.8.0') });
        expect({ label, step6: runCommand(CACHE_VERSIONS, f.textual, env).stdout }).toEqual({ label, step6: expect.stringMatching(/^2 version\(s\): /) });

        // The shell blocks: the directory after the first line is the one the runtime names, and the blocks read it.
        expect({ label, dir: shell(`${prelude}\nprintf %s "$C"`, configured, f.base).stdout }).toEqual({ label, dir: f.textual });
        const withHooks = blocks.find((b) => b.includes('hooks/*.sh')) ?? '';
        expect({ label, hooks: shell(withHooks, configured, f.base).stdout }).toEqual({ label, hooks: expect.stringContaining('keyword-detector.sh') });
        expect(shell(withHooks, configured, f.base).stdout).not.toContain('decoy.sh');
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test('a cache command given such a value cleans the directory the text names and leaves the other alone', () => {
    const f = fixture();
    try {
      for (const command of commands) {
        const result = runCommand(command, f.textual, { env: { CLAUDE_CONFIG_DIR: written(f), HOME: f.base, USERPROFILE: f.base } });
        expect(result.stdout).toContain('Moved 1 unprotected version(s)');
        expect(result.stdout).toContain(path.join(f.textual, 'plugins', 'backups'));
        rmSync(path.join(f.textual, 'plugins', 'backups'), { recursive: true, force: true });
        addCache(f.textual, ['5.7.0']);
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test('values without a .. keep their meaning: a link is not resolved, spaces and the home forms behave as before', () => {
    const f = fixture();
    try {
      symlinkSync(f.textual, path.join(f.base, 'alias'));
      const dir = (configured: string) => shell(`${prelude}\nprintf %s "$C"`, configured, f.base).stdout;
      expect(dir(path.join(f.base, 'alias'))).toBe(path.join(f.base, 'alias'));
      expect(dir(`  ${f.textual}  `)).toBe(f.textual);
      expect(dir('~/cfg')).toBe(f.textual);
      expect(dir('')).toBe(path.join(f.base, '.claude'));
      // A directory that does not exist is left as written (there is nothing to read in it either way).
      expect(dir(path.join(f.base, 'missing', 'dir'))).toBe(path.join(f.base, 'missing', 'dir'));
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});

// The same text must name the same directory when it is not there yet. `cd` folds a `..` after a link only for a target that
// exists, so a prelude that leaned on it left `<base>/link/../profile` as written when `<base>/profile` was missing, and the
// `mkdir -p` of Step 5 then followed the link and made `<parent of the link target>/profile`, a profile the runtime never
// reads. The shell blocks fold the text themselves, as the runtime does (path.normalize), before anything reads or writes.
// POSIX only: the fixture needs a symlink and the blocks run through bash.
describe.skipIf(!posix)('omc-doctor: a .. after a link names the same directory whether or not it exists', { timeout: 120_000 }, () => {
  // `<base>/profile` is where the runtime reads; `<base>/real/profile` is where a file system that follows the link leads.
  const world = () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-nonexistent-'));
    mkdirSync(path.join(base, 'real', 'x'), { recursive: true });
    symlinkSync(path.join('real', 'x'), path.join(base, 'link'));
    return base;
  };
  const runtimeDir = (configured: string, home: string) => {
    const saved = { dir: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME };
    process.env.CLAUDE_CONFIG_DIR = configured;
    process.env.HOME = home;
    try {
      return getClaudeConfigDir() as string;
    } finally {
      if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.dir;
      process.env.HOME = saved.home;
    }
  };
  const bashDir = (configured: string, home: string, cwd: string) =>
    spawnSync('/bin/bash', ['-c', `${prelude}\nprintf %s "$C"`], { encoding: 'utf8', timeout: 20_000, cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: home, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } }).stdout;

  test('the example of the review: link/../profile with a target that does not exist is the profile beside the link', () => {
    const base = world();
    try {
      const configured = `${base}/link/../profile`;
      const textual = path.join(base, 'profile');
      expect(existsSync(textual)).toBe(false);
      expect({ bash: bashDir(configured, base, base), runtime: runtimeDir(configured, base) }).toEqual({ bash: textual, runtime: textual });
      // Step 5 makes the directory: where the text names it, not under the parent of the link target.
      const step5 = blocks.find((b) => b.includes('mkdir -p "$C"')) ?? '';
      const ran = spawnSync('/bin/bash', ['-c', step5], { encoding: 'utf8', timeout: 20_000, cwd: base, env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: base, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });
      expect(ran.stdout).toContain('Config dir writable');
      expect({ intended: existsSync(textual), underLinkTarget: existsSync(path.join(base, 'real', 'profile')) }).toEqual({ intended: true, underLinkTarget: false });
      // The script reads the directory the shell block made: its Step 4 source is a file of that very directory.
      writeFileSync(path.join(textual, 'CLAUDE.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
      const four = runBlock(CLAUDE_MD_VERSION, textual, { env: { CLAUDE_CONFIG_DIR: configured, HOME: base, USERPROFILE: base }, cwd: base, timeout: 20_000 });
      expect(four.stdout).toContain(`OMC version source: ${path.join(textual, 'CLAUDE.md')}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the shell prelude, the runtime and the folded text agree for every form, with the target present and absent', () => {
    for (const exists of [false, true]) {
      const base = world();
      try {
        if (exists) mkdirSync(path.join(base, 'profile'), { recursive: true });
        const parent = path.dirname(base);
        const forms: Array<[string, string, string]> = [
          ['an absolute path', `${base}/link/../profile`, path.join(base, 'profile')],
          ['a path under the home directory', '~/link/../profile', path.join(base, 'profile')],
          ['a .. after the link that leaves the base', `${base}/link/../../out`, path.join(parent, 'out')],
          ['repeated separators, dots and a trailing separator', `${base}//profile///./sub/`, path.join(base, 'profile', 'sub')],
          ['surrounding spaces', `  ${base}/link/../profile  `, path.join(base, 'profile')],
          ['a .. past the root', '/../../nonexistent-omc-root/a/../b', '/nonexistent-omc-root/b'],
          ['the root itself', '/a/..', '/'],
          ['an empty value', '', path.join(base, '.claude')],
          ['a plain path', `${base}/profile`, path.join(base, 'profile')],
        ];
        for (const [label, configured, expected] of forms) {
          expect({ exists, label, bash: bashDir(configured, base, base), runtime: runtimeDir(configured, base) }).toEqual({ exists, label, bash: expected, runtime: expected });
        }
        // A relative value is read against the working directory: the runtime keeps the text, the shell makes it absolute.
        const relative = 'link/../profile';
        expect({ exists, bash: path.resolve(base, bashDir(relative, base, base)), runtime: path.resolve(base, runtimeDir(relative, base)) }).toEqual({ exists, bash: path.join(base, 'profile'), runtime: path.join(base, 'profile') });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  test('every block that uses the directory reads the text, so none of them reads the parent of the link target', () => {
    const base = world();
    try {
      const configured = `${base}/link/../profile`;
      const textual = path.join(base, 'profile');
      const decoy = path.join(base, 'real', 'profile');
      mkdirSync(path.join(textual, 'hooks'), { recursive: true });
      mkdirSync(path.join(decoy, 'hooks'), { recursive: true });
      writeFileSync(path.join(textual, 'hooks', 'keyword-detector.sh'), '#!/bin/bash\n');
      writeFileSync(path.join(decoy, 'hooks', 'decoy.sh'), '#!/bin/bash\n');
      const ran = (block: string) => spawnSync('/bin/bash', ['-c', block], { encoding: 'utf8', timeout: 20_000, cwd: base, env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: base, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } }).stdout;
      const listing = ran(blocks.find((b) => b.includes('hooks/*.sh')) ?? '');
      expect(listing).toContain('keyword-detector.sh');
      expect(listing).not.toContain('decoy.sh');
      for (const block of blocks) expect(ran(`${block.split('\n')[0]}\nprintf %s "$C"`)).toBe(textual);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// A relative value is read against the working directory, and node reads that directory physically: process.cwd() is the real
// path, so `../x` from a directory reached through a link is the parent of the link target, in the runtime, in the script and
// for every call the kernel resolves. A shell that cd-ed with the logical `..` and printed the result with `pwd -L` read the
// parent of the link instead. The blocks make a relative value absolute against the physical directory (`pwd -P`), then fold
// the text, so the shell, the runtime and the script name one directory. POSIX only: the fixture needs a symlink and the
// blocks run through bash.
describe.skipIf(!posix)('omc-doctor: a relative CLAUDE_CONFIG_DIR names one directory in the shell blocks, the runtime and the script', { timeout: 120_000 }, () => {
  const MODULE = fileURLToPath(new URL('../../scripts/lib/config-dir.mjs', import.meta.url));
  // `<base>/real/a/b` is the physical working directory, `<base>/work/lnk` leads to it. `<base>/work/x` is what the logical
  // `..` reaches, `<base>/real/a/x` what the physical one reaches; both hold a CLAUDE.md of another version.
  const world = (exists: boolean) => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'omc-doctor-relative-')));
    const cwd = path.join(base, 'real', 'a', 'b');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(path.join(base, 'work'), { recursive: true });
    symlinkSync(path.join('..', 'real', 'a', 'b'), path.join(base, 'work', 'lnk'));
    if (exists) {
      for (const [dir, version] of [[path.join(base, 'work', 'x'), '5.1.0'], [path.join(base, 'real', 'a', 'x'), '5.8.0'], [path.join(cwd, 'rel'), '5.8.0'], [path.join(base, 'cfg'), '5.8.0']] as const) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${version} -->\n`);
      }
    }
    return { base, cwd, link: path.join(base, 'work', 'lnk') };
  };
  const forms = (w: { base: string; cwd: string; link: string }): Array<[string, string, string]> => [
    ['a leading ..', '../x', path.join(w.base, 'real', 'a', 'x')],
    ['a leading .. and a trailing separator', '../x/', path.join(w.base, 'real', 'a', 'x')],
    ['a leading . and a .. after it', './../x', path.join(w.base, 'real', 'a', 'x')],
    ['a plain relative path', 'rel', path.join(w.cwd, 'rel')],
    ['a dot', '.', w.cwd],
    ['an absolute path through the link keeps the link', `${w.link}/rel`, `${w.link}/rel`],
    ['a path under the home directory', '~/cfg', path.join(w.base, 'cfg')],
  ];
  const env = (w: { base: string }, configured: string) => ({ ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: w.base, USERPROFILE: w.base, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' });

  test.each([true, false])('the first line of the blocks, getClaudeConfigDir() and the script read one directory from a working directory reached through a link (the directories exist: %s)', (exists) => {
    const w = world(exists);
    try {
      for (const [label, configured, expected] of forms(w)) {
        // The shell: the working directory is the link as the shell knows it (a cd, then the logical PWD).
        const bash = spawnSync('/bin/bash', ['-c', `cd "${w.link}" && ${prelude}\nprintf %s "$C"`], { encoding: 'utf8', timeout: 20_000, cwd: w.base, env: env(w, configured) }).stdout;
        // The runtime, run as a process whose working directory is the link: the relative text is read against the real one.
        const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `import path from 'node:path'; import { getClaudeConfigDir } from ${JSON.stringify(MODULE)}; process.stdout.write(path.resolve(process.cwd(), getClaudeConfigDir()));`], { encoding: 'utf8', timeout: 20_000, cwd: w.link, env: env(w, configured) }).stdout;
        expect({ exists, label, bash, runtime }).toEqual({ exists, label, bash: expected, runtime: expected });
        // The script reads the same directory: where the directory is there, its CLAUDE.md names the source it read.
        if (exists && label !== 'a dot') {
          const four = runBlock(CLAUDE_MD_VERSION, w.cwd, { cwd: w.link, timeout: 20_000, env: { CLAUDE_CONFIG_DIR: configured, HOME: w.base, USERPROFILE: w.base } });
          expect({ label, source: path.resolve(w.cwd, /OMC version source: (.*)/.exec(four.stdout)?.[1] ?? '') }).toEqual({ label, source: path.join(expected, 'CLAUDE.md') });
        }
      }
    } finally {
      rmSync(w.base, { recursive: true, force: true });
    }
  });
});

// A shell block is run whole, in one Bash call: the tool keeps no variable from one call to the next. So a line that uses
// `$C` is never outside the block that sets it, and the skill says to run a block whole.
describe('omc-doctor: no shell line uses $C outside the block that sets it', () => {
  test('every line of the skill that uses $C sits in a shell block whose first line sets it', () => {
    const lines = skillText.split('\n');
    let fence: { open: boolean; first: string; kind: string } = { open: false, first: '', kind: '' };
    const orphans: string[] = [];
    let uses = 0;
    lines.forEach((line, i) => {
      if (/^```/.test(line)) {
        fence = fence.open ? { open: false, first: '', kind: '' } : { open: true, first: lines[i + 1] ?? '', kind: line.slice(3).trim() };
        return;
      }
      // Only a line inside a fence can be run; the sentence that explains the rule mentions `$C` in prose.
      if (!fence.open || !/\$\{?C\b/.test(line)) return;
      uses++;
      const sets = fence.open && fence.kind === 'bash' && fence.first.startsWith('C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}";');
      if (!sets) orphans.push(`${i + 1}: ${line.slice(0, 80)}`);
    });
    expect(uses).toBeGreaterThan(10);
    expect(orphans).toEqual([]);
  });

  test('every shell block that uses the directory has the same first line, and the skill says to run a block whole', () => {
    expect(blocks).toHaveLength(5);
    for (const block of blocks) expect(block.split('\n')[0]).toBe(prelude);
    expect(prelude).toContain('pwd -P');
    expect(prelude).not.toContain('pwd -L');
    expect(skillText).toContain('Run every shell block whole, in one Bash call: the tool keeps no variable from one call to the next');
  });

  // The same holds for $S, the script path the locator line sets: every line that uses it follows that line in its block.
  test('every line of the skill that uses $S sits in a shell block that sets it first, with the same locator line', () => {
    expect(locatorLine).not.toBe('');
    const users = bashBlocks().filter((block) => /\$\{?S\b/.test(block.replace(locatorLine, '')));
    // Seven blocks use $S: six run the seven commands (Step 1 and the npm line share one), and the Guide block prints a section.
    expect(users).toHaveLength(7);
    // Ten calls: the seven commands, the call of the Guide block and the check of each of the two cache repair blocks that the guide can be printed.
    expect(skillText.match(/^node "\$S" /gm)).toHaveLength(10);
    for (const block of users) {
      const lines = block.split('\n');
      const set = lines.indexOf(locatorLine);
      expect(set).toBeGreaterThanOrEqual(0);
      const firstUse = lines.findIndex((line) => line !== locatorLine && /\$\{?S\b/.test(line));
      expect(firstUse).toBeGreaterThan(set);
    }
    // No fenced block outside the shell blocks, and no prose line, runs the script.
    const outside = skillText.replace(/```bash\n[\s\S]*?\n```/g, '');
    expect(outside).not.toMatch(/^node "\$S"/m);
  });
});
