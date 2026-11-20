import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    expect(prelude).toContain('pwd -L');
    expect(skillText).toContain('Run every shell block whole, in one Bash call: the tool keeps no variable from one call to the next');
  });

  // The same holds for $S, the script path the locator line sets: every line that uses it follows that line in its block.
  test('every line of the skill that uses $S sits in a shell block that sets it first, with the same locator line', () => {
    expect(locatorLine).not.toBe('');
    const users = bashBlocks().filter((block) => /\$\{?S\b/.test(block.replace(locatorLine, '')));
    // Six blocks run the seven commands (Step 1 and the npm line share one).
    expect(users).toHaveLength(6);
    expect(skillText.match(/^node "\$S" /gm)).toHaveLength(7);
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
