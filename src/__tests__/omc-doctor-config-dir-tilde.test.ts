import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, backupDir, bashBlocks, CACHE_VERSIONS, CLAUDE_MD_OPTOUT, CLAUDE_MD_VERSION, codeOf, commands, flatCode, PLUGIN_ID, runBlock, scriptSection, SCRIPT, scriptText, STEP1, writeRegistry, realEntries } from './helpers/omc-doctor-cache-fixture.js';

// CLAUDE_CONFIG_DIR may hold a literal home path (`~`, `~/x`, `~\x`), for example from a settings env block; the
// runtime expands it (scripts/lib/config-dir.mjs). Every command of the omc-doctor script and every shell block of the
// skill that computes the directory must expand it the same way, so none of them probes a `~` directory under the
// working directory.
// The shell blocks as written (they are run), selected by what they read outside their comment lines.
const blocks = bashBlocks().filter((b) => b.split('\n').some((l) => !l.startsWith('#') && l.includes('CLAUDE_CONFIG_DIR')));
const EXPAND = String.raw`const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim(); const configDir = !configured ? path.join(home, '.claude') : configured === '~' ? home : /^~[/\\]/.test(configured) ? path.join(home, configured.slice(2)) : path.normalize(configured);`;
// A relative value is made absolute against the physical working directory (pwd -P, where process.cwd() and the file system
// start), then the text is folded as the runtime folds it (path.normalize) before anything reads the directory, whether or not it exists.
// A path of Windows (a drive, a UNC path, a root on the current drive) is kept as written and skips both steps.
const WINDOWS = String.raw`case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) `;
const ABSOLUTE = String.raw`case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; `;
const FOLD = String.raw`O=; R=$C; while [ -n "$R" ]; do P=${'${R%%/*}'}; case $R in */*) R=${'${R#*/}'};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${'${O%/*}'};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${'${O:-/}'};; *) C=${'${O#/}'}; C=${'${C:-.}'};; esac; `;
const PRELUDE = String.raw`C="${'${CLAUDE_CONFIG_DIR:-$HOME/.claude}'}"; C=${'${C#"${C%%[![:space:]]*}"}'}; C=${'${C%"${C##*[![:space:]]}"}'}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${'${C#??}'};; esac; `.concat(WINDOWS, ABSOLUTE, FOLD.replace(/; $/, ''), ';; esac');
const posix = process.platform !== 'win32';

type World = { root: string; home: string; cwd: string; alt: string };
const world = (): World => {
  const root = mkdtempSync(path.join(tmpdir(), 'omc-doctor-tilde-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const alt = path.join(home, '.claude-alt');
  mkdirSync(path.join(alt, 'plugins'), { recursive: true });
  return { root, home, cwd, alt };
};

// A marketplace profile under `dir`: 5.8.0 pinned, 5.7.0 free to move, the marketplace clone at 5.9.0.
const profile = (dir: string) => {
  writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0') }] });
  addCache(dir, ['5.7.0', '5.8.0']);
  mkdirSync(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'omc', plugins: [{ name: 'oh-my-claudecode', version: '5.9.0' }] }));
  writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:START -->\n<!-- OMC:VERSION:5.8.0 -->\n');
  // Only this directory opts out: a probe that read another one (the default, the working directory) would print enabled.
  writeFileSync(path.join(dir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
  mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  writeFileSync(path.join(dir, 'hooks', 'keyword-detector.sh'), '#!/bin/bash\n');
};

// Runs a command of the script with the configured value, HOME and USERPROFILE at the fixture home and the working
// directory in an empty directory, where a wrongly probed `~` directory would show.
const runNode = (w: World, command: string, configured: string, platform?: string) => {
  const preload = path.join(w.root, 'platform.cjs');
  if (platform) writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
  const run = spawnSync(process.execPath, [...(platform ? ['--require', preload] : []), SCRIPT, command], {
    cwd: w.cwd, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: w.home, USERPROFILE: w.home, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  return run.stdout;
};

const runShell = (w: World, script: string, configured: string) => {
  const run = spawnSync('/bin/bash', ['-c', script], {
    cwd: w.cwd, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configured, HOME: w.home, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
  });
  expect(run.error).toBeUndefined();
  return run.stdout;
};

describe('omc-doctor: every command computes the config directory with one expression', { timeout: 120_000 }, () => {
  test('the script carries the expansion text once and reads the variable nowhere else', () => {
    const code = flatCode(codeOf(scriptText));
    expect(flatCode(scriptSection('config dir'))).toContain(EXPAND);
    expect(code.split(EXPAND)).toHaveLength(2);
    expect(code.split('CLAUDE_CONFIG_DIR')).toHaveLength(2);
    // Every command reads the directory through that one constant: no command spells the default .claude path of its own.
    expect(code.match(/'\.claude'/g)).toHaveLength(1);
  });

  test('every shell block that reads the variable starts with the same expansion line and reads it nowhere else', () => {
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(block.split('\n')[0]).toBe(PRELUDE);
      expect(block.split('\n').filter((l) => !l.startsWith('#')).join('\n').split('CLAUDE_CONFIG_DIR')).toHaveLength(2);
    }
  });
});

describe('omc-doctor: a config directory given as a home path reaches the real directory', { timeout: 120_000 }, () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['~/.claude-alt', '.claude-alt', undefined],
    ['~\\.claude-alt', '.claude-alt', 'win32'],
    // The same form on the real platform name: the expansion must not depend on a process that reports win32.
    ['~\\.claude-alt', '.claude-alt', undefined],
    ['  ~/.claude-alt  ', '.claude-alt', undefined],
    ['~', '', undefined],
  ];

  for (const [configured, below, platform] of cases) {
    test(`${JSON.stringify(configured)}${platform ? ` (the process reports ${platform})` : ''}: Step 1, Steps 4 and 6 and both repair commands use the home directory`, () => {
      const w = world();
      try {
        const dir = path.join(w.home, below);
        mkdirSync(path.join(dir, 'plugins'), { recursive: true });
        profile(dir);
        const step1 = runNode(w, STEP1, configured, platform);
        expect(step1).toContain('Channel: marketplace');
        expect(step1).toContain('Installed: 5.8.0');
        expect(step1).toContain('Latest: 5.9.0');
        expect(step1).toContain('Updater: claude plugin');
        expect(runNode(w, CLAUDE_MD_OPTOUT, configured, platform)).toContain('CLAUDE.md management disabled by claudeMdEnabled: false');
        expect(runNode(w, CACHE_VERSIONS, configured, platform)).toContain('2 version(s): ');
        // Step 4 is a shell block of the skill (the locator line and the call), so it runs through bash where one exists.
        if (posix) {
          const run = runBlock(CLAUDE_MD_VERSION, dir, { cwd: w.cwd, timeout: 20_000, env: { CLAUDE_CONFIG_DIR: configured, HOME: w.home } });
          expect(run.stdout).toContain('Latest cached plugin version: 5.8.0');
        }
        for (const command of commands) {
          profile(dir);
          const out = runNode(w, command, configured, platform);
          expect(out).toContain('Moved 1 unprotected version(s)');
          expect(realEntries(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode'))).toEqual(['5.8.0']);
          expect(readdirSync(backupDir(dir))).toHaveLength(1);
          rmSync(path.join(dir, 'plugins', 'backups'), { recursive: true, force: true });
        }
        expect(readdirSync(w.cwd)).toEqual([]);
      } finally {
        rmSync(w.root, { recursive: true, force: true });
      }
    });
  }

  test('a path without a tilde, an empty value and a tilde inside the path keep their meaning', () => {
    const w = world();
    try {
      const literal = path.join(w.home, '~', 'inner');
      const plain = path.join(w.root, 'plain');
      const cases: Array<[string, string]> = [[plain, plain], [`${plain}${path.sep}`, plain], ['', path.join(w.home, '.claude')], ['   ', path.join(w.home, '.claude')], [literal, literal]];
      for (const [configured, dir] of cases) {
        mkdirSync(path.join(dir, 'plugins'), { recursive: true });
        profile(dir);
        expect(runNode(w, STEP1, configured)).toContain('Installed: 5.8.0');
        for (const command of commands) {
          profile(dir);
          expect(runNode(w, command, configured)).toContain('Moved 1 unprotected version(s)');
          expect(realEntries(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode'))).toEqual(['5.8.0']);
          rmSync(path.join(dir, 'plugins', 'backups'), { recursive: true, force: true });
        }
      }
      expect(readdirSync(w.cwd)).toEqual([]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)('the shell blocks expand the same forms before they read or write', () => {
    const w = world();
    try {
      profile(w.alt);
      mkdirSync(path.join(w.alt, 'agents'), { recursive: true });
      for (const configured of ['~/.claude-alt', '~\\.claude-alt', '  ~/.claude-alt  ']) {
        const [step3, step4, step5, step7, fix] = blocks;
        expect(runShell(w, step3, configured)).toContain('keyword-detector.sh');
        expect(runShell(w, step4, configured)).toContain('Has OMC config');
        expect(runShell(w, step5, configured)).toContain('Config dir writable');
        expect(runShell(w, step7, configured)).toContain('total');
        expect(runShell(w, `${fix}\nprintf %s "$C"`, configured)).toBe(w.alt);
      }
      expect(runShell(w, `${PRELUDE}\nprintf %s "$C"`, '~')).toBe(w.home);
      expect(runShell(w, `${PRELUDE}\nprintf %s "$C"`, '')).toBe(path.join(w.home, '.claude'));
      expect(runShell(w, `${PRELUDE}\nprintf %s "$C"`, '   ')).toBe(path.join(w.home, '.claude'));
      expect(runShell(w, `${PRELUDE}\nprintf %s "$C"`, '  /x/y  ')).toBe('/x/y');
      expect(runShell(w, `${PRELUDE}\nprintf %s "$C"`, '/x/~/y')).toBe('/x/~/y');
      expect(existsSync(path.join(w.cwd, '~'))).toBe(false);
      expect(readdirSync(w.cwd)).toEqual([]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });
});
