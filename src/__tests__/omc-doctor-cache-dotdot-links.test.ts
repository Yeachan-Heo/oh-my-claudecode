import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ageVersions, backupDir, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, scriptOf, sharedSections, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1, versionCommand } from './helpers/omc-doctor-step1.js';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../scripts/lib/cache-occupancy.mjs';

// A path that goes through a link and then `..` names the parent of the link's target: the file system reads the
// components of a path in order. The commands resolve such a path the same way (one `chain` function, the same text in
// Step 1 and in both cache commands) instead of folding `..` as text first. On win32, Windows folds `..` before it
// follows a junction, so the results below differ there and the cases that need a link followed by `..` run on POSIX only.
const POSIX = process.platform !== 'win32';

describe('omc-doctor: one path resolver in Step 1 and in both cache commands', () => {
  const resolverOf = (command: string) => sharedSections(command).get('path resolver') ?? '';

  test('the resolver is the same text in every command that reads a path from the registry, the records or the root variables', () => {
    expect(commands).toHaveLength(2);
    const texts = [versionCommand ?? '', ...commands].map(resolverOf);
    expect(texts[0]).not.toBe('');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  test('no command folds `..` as text before it follows a link or resolves a path with the JavaScript realpath', () => {
    for (const command of [versionCommand ?? '', ...commands]) {
      const code = scriptOf(command).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      expect(code).not.toContain('realpathSync');
      expect(code).not.toMatch(/path\.resolve\(start\)/);
    }
  });
});

describe.skipIf(!POSIX)('omc-doctor: a protecting path that has `..` after a link is read as the file system reads it', { timeout: 120_000 }, () => {
  type Ctx = { dir: string; cache: string; at: (name: string) => string };
  // `protects` says whether the path ends in the cache version 5.9.0 or goes through it; `folded` says whether the same text
  // folded as text lands in it (the runtime folds an occupancy record that way, so every carrier is read by both readings).
  const layouts: Array<{ label: string; protects: boolean; folded?: boolean; build: (c: Ctx) => string }> = [
    {
      label: 'a link to a directory inside the version, then ..',
      protects: true,
      build: (c) => {
        symlinkSync(path.join(c.cache, '5.9.0', 'nested'), c.at('shortcut'));
        return `${c.at('shortcut')}${path.sep}..`;
      },
    },
    {
      label: 'a relative link, then ..',
      protects: true,
      build: (c) => {
        symlinkSync(path.join('plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0', 'nested'), c.at('shortcut'));
        return `${c.at('shortcut')}${path.sep}..`;
      },
    },
    {
      label: 'two .. in a row after a link',
      protects: true,
      build: (c) => {
        mkdirSync(path.join(c.cache, '5.9.0', 'nested', 'deeper'), { recursive: true });
        symlinkSync(path.join(c.cache, '5.9.0', 'nested', 'deeper'), c.at('shortcut'));
        return `${c.at('shortcut')}${path.sep}..${path.sep}..`;
      },
    },
    {
      label: 'a .. in the target of a link that follows another link',
      protects: true,
      build: (c) => {
        symlinkSync(path.join(c.cache, '5.9.0', 'nested'), c.at('hop'));
        symlinkSync(`hop${path.sep}..`, c.at('shortcut'));
        return c.at('shortcut');
      },
    },
    {
      label: 'a trailing separator after the ..',
      protects: true,
      build: (c) => {
        symlinkSync(path.join(c.cache, '5.9.0', 'nested'), c.at('shortcut'));
        return `${c.at('shortcut')}${path.sep}..${path.sep}`;
      },
    },
    {
      label: 'a link inside the version to a directory outside the cache, then ..',
      protects: true,
      build: (c) => {
        mkdirSync(c.at(path.join('outside', 'a', 'b')), { recursive: true });
        symlinkSync(c.at(path.join('outside', 'a', 'b')), path.join(c.cache, '5.9.0', 'ext'));
        // Read by the file system this is <dir>/outside/a, no part of the cache; read as text it is <cache>/5.9.0.
        return `${path.join(c.cache, '5.9.0', 'ext')}${path.sep}..`;
      },
    },
    {
      label: 'a link in the cache to a directory outside it, then .. and the version name',
      protects: false,
      folded: true,
      build: (c) => {
        mkdirSync(c.at(path.join('outside', 'a', 'b')), { recursive: true });
        symlinkSync(c.at(path.join('outside', 'a', 'b')), path.join(c.cache, 'ext'));
        // Read as text this is <cache>/5.9.0; read by the file system it is <dir>/outside/a/5.9.0, which does not exist.
        return `${path.join(c.cache, 'ext')}${path.sep}..${path.sep}5.9.0`;
      },
    },
    {
      label: 'a link to a directory outside the cache, then ..',
      protects: false,
      build: (c) => {
        mkdirSync(c.at(path.join('outside', 'a', 'b')), { recursive: true });
        symlinkSync(c.at(path.join('outside', 'a', 'b')), c.at('shortcut'));
        return `${c.at('shortcut')}${path.sep}..`;
      },
    },
  ];

  // Where the path comes from: another entry of the registry, one of the two root variables, or a record of a running session.
  const carriers = ['installPath of a registry entry', 'OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'occupancy record'] as const;

  let identity = '';
  function ownIdentity(): string {
    if (identity) return identity;
    const probe = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
    try {
      expect(publishCacheOccupancy(probe, probe, process.pid)).toBe(true);
      const directory = path.join(probe, '.omc', 'cache-occupancy');
      identity = JSON.parse(readFileSync(path.join(directory, readdirSync(directory)[0]), 'utf8')).processStartIdentity as string;
      return identity;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }

  // The publisher folds a plugin root as text before it stores it, so a record that still has `..` is written by hand.
  function writeRecord(dir: string, root: string) {
    const record = { version: 1, pid: process.pid, processStartIdentity: ownIdentity(), pluginRoot: root, updatedAt: new Date().toISOString() };
    const directory = path.join(dir, '.omc', 'cache-occupancy');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`), JSON.stringify(record));
  }

  function setup(layout: (typeof layouts)[number]) {
    const made = makeCache(['5.7.0', '5.8.1', '5.9.0']);
    mkdirSync(path.join(made.cache, '5.9.0', 'nested'), { recursive: true });
    const ctx: Ctx = { ...made, at: (name) => path.join(made.dir, name) };
    const target = layout.build(ctx);
    ageVersions(made.cache);
    return { ...made, target };
  }

  for (const command of ['the outdated plugin command', 'the stale cache command']) {
    const which = command === 'the outdated plugin command' ? 0 : 1;
    describe(command, () => {
      for (const layout of layouts) {
        for (const carrier of carriers) {
          test(`${layout.label}, from ${carrier}`, () => {
            const { dir, cache, target } = setup(layout);
            try {
              const pinned = { scope: 'user', version: '5.8.1', installPath: path.join(cache, '5.8.1') };
              const env: Record<string, string> = {};
              writeRegistry(dir, { [PLUGIN_ID]: carrier === 'installPath of a registry entry' ? [pinned, { scope: 'project', installPath: target }] : [pinned] });
              if (carrier === 'OMC_PLUGIN_ROOT' || carrier === 'CLAUDE_PLUGIN_ROOT') env[carrier] = target;
              if (carrier === 'occupancy record') writeRecord(dir, target);
              const result = runCommand(commands[which], dir, { env, timeout: 20_000 });
              expect(result.error).toBeUndefined();
              expect(result.status).toBe(0);
              // 5.8.1 is pinned and stays; 5.7.0 is free and moves; 5.9.0 stays only when the path protects it.
              const keeps = layout.protects || layout.folded === true;
              expect({ left: digitVersions(cache), moved: movedAside(dir) }).toEqual(keeps ? { left: '5.8.1,5.9.0', moved: 1 } : { left: '5.8.1', moved: 2 });
              if (layout.protects && carrier === 'installPath of a registry entry') expect(existsSync(target)).toBe(true);
              if (!keeps) expect(readdirSync(backupDir(dir)).map((n) => n.slice(0, 5)).sort()).toEqual(['5.7.0', '5.9.0']);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          });
        }
      }
    });
  }

  describe('Step 1', () => {
    const cacheOf = (dir: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const link = (dir: string, version: string) => {
      mkdirSync(path.join(cacheOf(dir), version, 'nested'), { recursive: true });
      writeFileSync(path.join(cacheOf(dir), version, 'package.json'), JSON.stringify({ version }));
      symlinkSync(path.join(cacheOf(dir), version, 'nested'), path.join(dir, 'shortcut'));
      return `${path.join(dir, 'shortcut')}${path.sep}..`;
    };
    // The config directory carries a package.json of another version: reading it would be reading the text-folded path.
    const decoy = (dir: string) => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    const registry = (dir: string) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.1', installPath: path.join(cacheOf(dir), '5.8.1') }, { scope: 'user', version: '5.9.0', installPath: path.join(cacheOf(dir), '5.9.0') }] });

    test('a plugin-dir root with .. after a link reports the checkout the file system names', () => {
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        const out = step1({
          cache: { omc: ['5.8.1', '5.9.0'] },
          plugins: variable === 'OMC_PLUGIN_ROOT' ? registry : {},
          setup: (dir) => decoy(dir),
          env: (dir) => ({ [variable]: link(dir, '5.9.0') }),
        });
        expect({ variable, channel: out.Channel, installed: out.Installed }).toEqual(
          variable === 'OMC_PLUGIN_ROOT' ? { variable, channel: 'marketplace omc', installed: '5.9.0' } : { variable, channel: 'plugin-dir', installed: '5.9.0' },
        );
      }
    });

    test('the entry whose install is the root named with .. after a link is the active entry', () => {
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        const out = step1({
          cache: { omc: ['5.8.1', '5.9.0'] },
          plugins: registry,
          clone: { omc: '5.9.0' },
          env: (dir) => ({ [variable]: link(dir, '5.8.1') }),
        });
        // The root is the 5.8.1 checkout, so Installed is that entry and not the highest.
        expect({ variable, installed: out.Installed }).toEqual({ variable, installed: '5.8.1' });
      }
    });

    test('a root that is the folder holding the link is not the install the link leads to', () => {
      // `<dir>/shortcut/..` is 5.9.0 for the file system and `<dir>` for the text, so an entry that names `<dir>` is another install.
      const out = step1({
        cache: { omc: ['5.9.0'] },
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.1', installPath: dir }] }),
        setup: (dir) => decoy(dir),
        env: (dir) => ({ OMC_PLUGIN_ROOT: link(dir, '5.9.0') }),
      });
      expect(out).toMatchObject({ Channel: 'plugin-dir', Installed: '5.9.0' });
    });

    test('an entry with .. in its installPath reads the package.json of the directory the file system names', () => {
      const out = step1({
        cache: { omc: ['5.8.1', '5.9.0'] },
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.1', installPath: path.join(cacheOf(dir), '5.8.1') }, { scope: 'project', installPath: `${path.join(dir, 'shortcut')}${path.sep}..` }] }),
        setup: (dir) => {
          decoy(dir);
          link(dir, '5.9.0');
        },
        env: (dir) => ({ OMC_PLUGIN_ROOT: path.join(cacheOf(dir), '5.9.0') }),
      });
      expect(out.Installed).toBe('5.9.0');
    });

    test('a root inside the cache named with .. after a link cannot be told from the pinned install when the registry is unreadable', () => {
      const out = step1({
        cache: { omc: ['5.9.0'] },
        raw: 'not json',
        setup: (dir) => decoy(dir),
        env: (dir) => ({ OMC_PLUGIN_ROOT: link(dir, '5.9.0') }),
      });
      expect(out.Channel).toMatch(/^unknown/);
    });
  });
});
