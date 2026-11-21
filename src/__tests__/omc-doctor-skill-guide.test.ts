import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  backupDir,
  bashBlocks,
  blockOf,
  CACHE_VERSIONS,
  CLAUDE_MD_OPTOUT,
  CLAUDE_MD_VERSION,
  commands,
  digitVersions,
  GUIDE_CALL,
  GUIDE_GUARD,
  guideSection,
  guideText,
  locatorLine,
  makeCache,
  movedAside,
  PLUGIN_ID,
  ROOT,
  skillText,
  STEP1,
  writeRegistry,
} from './helpers/omc-doctor-cache-fixture.js';

// The skill leaves the details of the rarer cases to a guide file beside the script (scripts/omc-doctor-guide.md), which
// `node "$S" guide <section>` prints. These tests keep the two halves of that split together: every reference of the skill
// names a section that exists, every section is named by a rule, what makes a cache repair safe stays in the skill itself,
// a cache repair does not start without the guide, and the steps that do not need the guide do not notice its absence.
const posix = process.platform !== 'win32';
const sectionNames = guideText
  .split(/^(?=## )/m)
  .filter((part) => part.startsWith('## '))
  .map((part) => part.slice(3, part.indexOf('\n')).trim());

// The paragraph of the skill that introduces the Guide block, and the skill without it.
const guideStart = skillText.indexOf('### Guide: the details on request');
const guideEnd = skillText.indexOf('### Step 1');
const guideParagraph = skillText.slice(guideStart, guideEnd);
const skillOutsideGuide = skillText.slice(0, guideStart) + skillText.slice(guideEnd);
const heading = (name: string): string => {
  const start = skillText.indexOf(`### ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const from = skillText.indexOf('\n', start);
  const end = skillText.slice(from).search(/\n(### |## |---\n)/);
  return skillText.slice(start, end < 0 ? undefined : from + end);
};

describe('omc-doctor: the skill and its guide point at each other', () => {
  test('the guide file has the sections the skill is written for, and the Guide paragraph lists exactly them', () => {
    expect(sectionNames).toEqual(['channel-unknown', 'channel-plugin-dir', 'latest-grammar', 'versions-order', 'cache-guard', 'paths-and-locator']);
    expect(guideStart).toBeGreaterThan(0);
    expect(guideEnd).toBeGreaterThan(guideStart);
    const listed = [...guideParagraph.split('Print a section')[0].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((match) => match[1]);
    expect([...listed].sort()).toEqual([...sectionNames].sort());
  });

  test('every place of the skill that names a section of the guide names one that exists', () => {
    const named = [...skillText.matchAll(/guide section `([a-z0-9-]+)`/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThanOrEqual(sectionNames.length);
    for (const name of named) expect({ name, exists: sectionNames.includes(name) }).toEqual({ name, exists: true });
    // The guide names sections of itself the same way.
    for (const name of [...guideText.matchAll(/\(section `([a-z0-9-]+)`\)/g)].map((match) => match[1])) {
      expect({ name, exists: sectionNames.includes(name) }).toEqual({ name, exists: true });
    }
  });

  test('every section of the guide is named by a rule of the skill outside the Guide paragraph', () => {
    for (const name of sectionNames) {
      expect({ name, named: skillOutsideGuide.includes(`guide section \`${name}\``) }).toEqual({ name, named: true });
    }
  });

  test('the guide does not point at a place of the skill by its position', () => {
    expect(guideText).not.toMatch(/\b(next item|previous item|rule below|command below|line below|block above)\b/);
  });

  test('what makes a cache repair safe stays in the skill: the no-prune rule, the protection sources, the fail-closed exit code and the backup place', () => {
    const guard = heading('Fix: Outdated Plugin');
    for (const rule of [
      'Diagnostics do not authorize removal or setup changes',
      'Do not prune cache versions by age, lexical/version order, or presence of a newer version',
      'A cache version is protected and must never be moved aside when it is pinned in',
      'the `installPath` of any other plugin or `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` points into it',
      'or when a running session occupies it',
      '.omc/cache-occupancy/',
      'an old date alone never ignores a record, and this command never deletes one',
      'Every refusal',
      'ends the command with exit code 1, so that it cannot be taken for a success',
      'If every cached version is protected, move nothing and report the protection instead of running the command below.',
      'plugins/backups/oh-my-claudecode/',
      'outside `plugins/cache/`',
    ]) {
      expect({ rule, kept: guard.includes(rule) }).toEqual({ rule, kept: true });
    }
    const stale = heading('Fix: Stale Cache');
    for (const rule of ['Diagnostics do not authorize removal or setup changes', 'Do not prune cache versions by age', 'Everything the **Cache guard** of "Fix: Outdated Plugin" above says applies to the command below unchanged', 'Move aside only unprotected versions, and report the protected versions kept.']) {
      expect({ rule, kept: stale.includes(rule) }).toEqual({ rule, kept: true });
    }
  });

  test('every verdict of Step 1 stays in the skill: the severity of each channel and version case does not depend on the guide', () => {
    const step1 = heading('Step 1: Check Plugin Version');
    for (const verdict of [
      'CRITICAL - plugin files missing',
      'CRITICAL - plugin not installed',
      'WARN - an install is there',
      'not a missing install and never CRITICAL',
      'If `Channel: unknown`: CRITICAL - the install channel cannot be established',
      'name no updater and do not compare versions',
      'If `Channel: plugin-dir`',
      'the Plugin Version check is OK with the detail `plugin-dir checkout, version unknown`',
      'WARN - registry and loaded code disagree',
      'WARN - outdated plugin',
      'If `Latest: (unavailable)` on a marketplace channel or `npm latest: (unavailable)` on the npm channel: report that the latest version could not be checked, not a WARN',
      'WARN - stale cache',
    ]) {
      expect({ verdict, kept: step1.includes(verdict) }).toEqual({ verdict, kept: true });
    }
  });

  test('each cache repair command is preceded by the order to read the cache-guard section, and not to run the command when that fails', () => {
    for (const [name, command] of [['Fix: Outdated Plugin', commands[0]], ['Fix: Stale Cache', commands[1]]]) {
      const text = heading(name);
      const order = 'run the Guide block above with `cache-guard` in place of `SECTION`';
      expect({ name, ordered: text.includes(order) }).toEqual({ name, ordered: true });
      expect({ name, stops: /do not run the command below/.test(text.slice(text.indexOf(order))) }).toEqual({ name, stops: true });
      expect(text.indexOf(order), name).toBeLessThan(text.indexOf('```bash'));
      const lines = blockOf(command).split('\n');
      expect(lines[2]).toBe(GUIDE_GUARD);
    }
  });

  test('the Guide block is the locator line and one call that prints the named section', () => {
    const blocks = bashBlocks().filter((block) => block.split('\n').includes(GUIDE_CALL));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].split('\n')).toEqual(['# Print one section of the guide (cross-platform)', locatorLine, GUIDE_CALL]);
    expect(guideParagraph).toContain('exit code 1 and a message when the file is missing');
    expect(guideParagraph).toContain('exit code 2 for a name that is no section');
  });
});

// A plugin root of its own (the script, and the guide when asked), so that the locator line of a block finds it first.
const pluginRoot = (base: string, withGuide: boolean) => {
  const root = path.join(base, 'plugin');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts', 'omc-doctor.mjs'), path.join(root, 'scripts', 'omc-doctor.mjs'));
  if (withGuide) copyFileSync(path.join(ROOT, 'scripts', 'omc-doctor-guide.md'), path.join(root, 'scripts', 'omc-doctor-guide.md'));
  return root;
};
const bash = (block: string, configDir: string, root: string) =>
  spawnSync('bash', ['-c', block], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, HOME: configDir, USERPROFILE: configDir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: root },
  });
// The first lines of the Step 1 block up to the call of the step1 command: the npm line after it needs the network.
const step1Block = () => {
  const lines = blockOf(STEP1).split('\n');
  return lines.slice(0, lines.indexOf(`node "$S" ${STEP1}`) + 1).join('\n');
};
const guideBlock = (section: string) => {
  const lines = bashBlocks().find((block) => block.split('\n').includes(GUIDE_CALL))!.split('\n');
  return [...lines.slice(0, -1), `node "$S" guide ${section}`].join('\n');
};

// POSIX only: the blocks run through bash and the fixtures are plain files.
describe.skipIf(!posix)('omc-doctor: a payload without the guide file', { timeout: 180_000 }, () => {
  const withBase = (body: (base: string, dir: string, cache: string) => void) => {
    const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-no-guide-'));
    const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
    try {
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
      body(base, dir, cache);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('the cache repair blocks end with exit code 1 and a message before anything is moved, and run when the guide is there', () => {
    for (const command of commands) {
      withBase((base, dir, cache) => {
        const result = bash(blockOf(command), dir, pluginRoot(base, false));
        expect({ command, status: result.status, stdout: result.stdout }).toEqual({ command, status: 1, stdout: '' });
        expect(result.stderr).toContain('omc-doctor: guide not found');
        expect(result.stderr).toContain(path.join(base, 'plugin', 'scripts', 'omc-doctor-guide.md'));
        expect({ command, versions: digitVersions(cache), moved: movedAside(dir), backups: existsSync(backupDir(dir)) }).toEqual({ command, versions: '5.8.0,5.9.0', moved: 0, backups: false });
      });
      withBase((base, dir, cache) => {
        const result = bash(blockOf(command), dir, pluginRoot(base, true));
        expect({ command, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ command, status: 0, versions: '5.9.0', moved: 1 });
      });
    }
  });

  test('the Guide block prints the section with the guide, ends with 1 and a message without it, and with 2 for a name that is no section', () => {
    withBase((base, dir) => {
      const printed = bash(guideBlock('cache-guard'), dir, pluginRoot(base, true));
      expect({ status: printed.status, stderr: printed.stderr }).toEqual({ status: 0, stderr: '' });
      expect(printed.stdout).toBe(guideSection('cache-guard') + '\n');
      const unknown = bash(blockOf(commands[0]).split('\n').slice(0, 2).join('\n') + '\n' + GUIDE_CALL, dir, pluginRoot(base, true));
      expect({ status: unknown.status, stdout: unknown.stdout }).toEqual({ status: 2, stdout: '' });
      rmSync(path.join(base, 'plugin', 'scripts', 'omc-doctor-guide.md'));
      const missing = bash(guideBlock('cache-guard'), dir, path.join(base, 'plugin'));
      expect({ status: missing.status, stdout: missing.stdout }).toEqual({ status: 1, stdout: '' });
      expect(missing.stderr).toContain('omc-doctor: guide not found');
    });
  });

  test('the steps that do not need the guide give the same output with and without it', () => {
    withBase((base, dir) => {
      const blocks = [step1Block(), blockOf(CLAUDE_MD_OPTOUT), blockOf(CLAUDE_MD_VERSION), blockOf(CACHE_VERSIONS)];
      for (const block of blocks) {
        const without = bash(block, dir, pluginRoot(base, false));
        const guideRoot = pluginRoot(path.join(base, 'with'), true);
        const withGuide = bash(block, dir, guideRoot);
        expect({ block: block.split('\n').pop(), status: without.status, stderr: without.stderr }).toEqual({ block: block.split('\n').pop(), status: 0, stderr: '' });
        expect({ status: without.status, stdout: without.stdout }).toEqual({ status: withGuide.status, stdout: withGuide.stdout });
        expect(without.stdout.length).toBeGreaterThan(0);
      }
    });
  });
});
