import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commands, digitVersions, makeCache, movedAside, PLUGIN_ID, read, runCommand, volumeFoldsCase, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

const step1Command = read('skills/omc-doctor/SKILL.md').split('\n').find((l) => l.startsWith('node -e ') && l.includes("'Updater: ")) ?? '';
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;

// Two existing directories that differ only in letter case are two directories on a volume that tells letter case
// apart (ext4, a case-sensitive APFS volume), whatever platform name the process reports: the commands tell paths
// apart by device and inode and never fold letter case by the name of the platform. A volume that ignores letter
// case cannot hold both directories, so these cases need a case-sensitive test volume; the aliases of a volume that
// ignores case are covered by the identity cases of the other omc-doctor suites.
describe.skipIf(volumeFoldsCase())('omc-doctor on a volume that tells letter case apart, under every platform name', { timeout: 120_000 }, () => {
  // A preload makes the process report another platform; the volume under it stays the real one.
  const reportAs = (dir: string, platform: string) => {
    const file = path.join(dir, `platform-${platform}.cjs`);
    writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
    return file;
  };
  const makeRoot = (dir: string, relative: string, version: string) => {
    const at = path.join(dir, relative);
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, 'package.json'), JSON.stringify({ version }));
    return at;
  };

  // Runs the Step 1 command on a synthetic configuration directory and returns its `Label: value` lines.
  function step1(platform: string, setup: (dir: string) => { plugins?: Record<string, unknown>; env: Record<string, string> }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-case-'));
    try {
      mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      const { plugins, env } = setup(dir);
      if (plugins) writeRegistry(dir, plugins);
      const result = runCommand(step1Command, dir, { env, preloads: [reportAs(dir, platform)], timeout: 20_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      return Object.fromEntries(result.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('Step 1: the registry install and the explicit root differ only in letter case, so the root is a checkout of its own', () => {
    for (const exists of [true, false]) {
      for (const platform of PLATFORMS) {
        let checkout = '';
        const out = step1(platform, (dir) => {
          // `cfg/Foo` is the registry install (present or stale); `cfg/foo` is a different directory that exists.
          const installPath = exists ? makeRoot(dir, 'cfg/Foo', '5.8.0') : path.join(dir, 'cfg', 'Foo');
          checkout = makeRoot(dir, 'cfg/foo', '9.9.0');
          return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath }] }, env: { OMC_PLUGIN_ROOT: checkout } };
        });
        expect({ exists, platform, channel: out.Channel, installed: out.Installed, root: out['Plugin root'] })
          .toEqual({ exists, platform, channel: 'plugin-dir', installed: '9.9.0', root: checkout });
      }
    }
  });

  test('Step 1: a root in a tree that differs from plugins/cache only in letter case is not a registry install', () => {
    for (const platform of PLATFORMS) {
      let checkout = '';
      const out = step1(platform, (dir) => {
        const installPath = makeRoot(dir, 'plugins/cache/omc/oh-my-claudecode/5.8.0', '5.8.0');
        checkout = makeRoot(dir, 'Plugins/cache/omc/oh-my-claudecode/9.9.0', '9.9.0');
        return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath }] }, env: { OMC_PLUGIN_ROOT: checkout } };
      });
      expect({ platform, channel: out.Channel, installed: out.Installed, root: out['Plugin root'] })
        .toEqual({ platform, channel: 'plugin-dir', installed: '9.9.0', root: checkout });
    }
  });

  test('Step 1: the two variables naming directories that differ only in letter case are a conflict', () => {
    for (const platform of PLATFORMS) {
      const out = step1(platform, (dir) => ({ env: { OMC_PLUGIN_ROOT: makeRoot(dir, 'cfg/Foo', '9.9.0'), CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'cfg/foo', '5.1.0') } }));
      expect({ platform, keys: Object.keys(out) }).toEqual({ platform, keys: ['Channel'] });
      expect(out.Channel).toContain('different directories');
    }
  });

  test('Step 1: Installed comes from the entry whose install path is the root, not from an entry that differs in letter case', () => {
    for (const platform of PLATFORMS) {
      const out = step1(platform, (dir) => {
        const upper = makeRoot(dir, 'cfg/Foo', '5.9.0');
        const lower = makeRoot(dir, 'cfg/foo', '5.7.0');
        return {
          plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0', installPath: upper }, { scope: 'project', version: '5.7.0', installPath: lower }] },
          env: { OMC_PLUGIN_ROOT: lower },
        };
      });
      expect({ platform, channel: out.Channel, installed: out.Installed }).toEqual({ platform, channel: 'marketplace omc', installed: '5.7.0' });
    }
  });

  test('cache commands: the two variables naming directories that differ only in letter case are a conflict, so nothing moves', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        // 5.8.0 is pinned (that is what lets the move loop run), 5.7.0 is free.
        const { dir, cache } = makeCache(['5.7.0', '5.8.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const env = { OMC_PLUGIN_ROOT: makeRoot(dir, 'Foo', '1.0.0'), CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'foo', '1.0.0') };
          const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 0, versions: '5.7.0,5.8.0', moved: 0 });
          expect(result.stdout).toContain('Nothing moved');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('cache commands: a pin names the version directory of exactly that spelling when two differ only in letter case', () => {
    const cases: Array<{ pins: string[]; kept: string }> = [
      { pins: ['5.9.0-beta', '5.9.0-BETA'], kept: '5.9.0-BETA,5.9.0-beta' },
      { pins: ['5.9.0-BETA'], kept: '5.9.0-BETA' },
      { pins: ['5.9.0-beta'], kept: '5.9.0-beta' },
    ];
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const { pins, kept } of cases) {
          const { dir, cache } = makeCache(['5.1.0', '5.9.0-beta', '5.9.0-BETA']);
          try {
            writeRegistry(dir, { [PLUGIN_ID]: pins.map((version) => ({ scope: 'user', version })) });
            const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
            expect({ platform, pins, status: result.status, versions: digitVersions(cache) }).toEqual({ platform, pins, status: 0, versions: kept });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });
});
