import { describe, test, expect } from 'vitest';
import { existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { blockOf, commands, GUIDE_GUARD, ageVersions, runBlock, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, makeCache, upperBelow, volumeFoldsCase, writeCaseFoldPreload, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { deadPid, ownHost, publishOwn, writeRecord } from './helpers/omc-doctor-occupancy-fixture.js';

describe('omc-doctor cache commands on a synthetic config directory (occupancy, links, platforms)', { timeout: 120_000 }, () => {
  // A preload makes the command see another platform; the volume under it stays the real one, and only the volume decides
  // whether two spellings of a path name one directory.
  const platformPreload = (name: string) => `Object.defineProperty(process, 'platform', { value: '${name}' });\n`;
  // Whether another spelling names an existing path here, without a preload: only where the volume folds letter case.
  const folds = volumeFoldsCase();
  // A symlink on POSIX; a junction with an absolute target on Windows (no privilege needed), which is
  // also what the SessionStart cleanup creates there. `junction` forces that form on every platform.
  function link(target: string, at: string, form: 'relative' | 'junction' = 'relative') {
    if (form === 'junction' || process.platform === 'win32') symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
    else symlinkSync(target, at);
    // A link is dated itself: one made just now counts as a recent change and keeps its version alone, whatever protects it.
    const then = new Date(Date.now() - 3_600_000);
    lutimesSync(at, then, then);
  }


  test('a version occupied by a live session is kept even though another version is the active pin', () => {
    for (const command of commands) {
      for (const suffix of ['', 'scripts']) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1', installPath: path.join(cache, '5.8.1') }] });
          // The record is written by the same publisher the SessionStart hook uses.
          expect(publishOwn(path.join(cache, '5.9.0', suffix), dir)).toBe(true);
          const result = runCommand(command, dir);
          expect(result.status).toBe(0);
          expect(digitVersions(cache)).toBe('5.8.1,5.9.0');
          expect(movedAside(dir)).toBe(1);
          expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.0-/);
          expect(result.stdout).toMatch(/Kept protected cache versions.*5\.8\.1.*5\.9\.0/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The SessionStart cleanup and the stale cache purge replace old version
  // directories with symlinks to the active one, so a protected name can be a
  // symlink whose target is the directory a running session really uses.
  test('a symlinked version that is occupied keeps the directory it points to', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
      try {
        link('5.9.0', path.join(cache, '5.8.0'));
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        expect(publishOwn(path.join(cache, '5.8.0'), dir)).toBe(true);
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.0,5.8.1,5.9.0');
        expect(existsSync(path.join(cache, '5.8.0', 'package.json'))).toBe(true);
        expect(movedAside(dir)).toBe(1);
        expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.7\.0-/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a pinned symlinked version keeps the directory it points to, whether pinned by version or by installPath', () => {
    for (const command of commands) {
      for (const pin of ['version', 'installPath']) {
        const { dir, cache } = makeCache(['5.7.0', '5.9.0']);
        try {
          link(path.join(cache, '5.9.0'), path.join(cache, '5.8.0'));
          writeRegistry(dir, {
            [PLUGIN_ID]: [pin === 'version' ? { scope: 'user', version: '5.8.0' } : { scope: 'user', installPath: path.join(cache, '5.8.0') }],
          });
          const result = runCommand(command, dir);
          expect(result.status).toBe(0);
          expect({ pin, versions: digitVersions(cache) }).toEqual({ pin, versions: '5.8.0,5.9.0' });
          expect(movedAside(dir)).toBe(1);
          expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.7\.0-/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a symlinked version nothing uses is moved aside as a link and its target stays', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.9.0']);
      try {
        link('5.9.0', path.join(cache, '5.8.0'));
        ageVersions(cache); // a link is dated itself, so a link created just now would be left alone
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.9.0');
        expect(movedAside(dir)).toBe(1);
        const [moved] = readdirSync(backupDir(dir));
        expect(lstatSync(path.join(backupDir(dir), moved)).isSymbolicLink()).toBe(true);
        expect(existsSync(path.join(cache, '5.9.0', 'package.json'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The config directory may be reached through a symlink from either side: the command runs on the alias
  // and the record names the real directory, or the command runs on the real directory and the record
  // names the alias.
  test('paths that reach the cache through a symlinked config directory still protect their version, from either side', () => {
    for (const command of commands) {
      for (const commandRunsOnAlias of [false, true]) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        const alias = `${dir}-alias`;
        try {
          link(dir, alias);
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          const spelled = commandRunsOnAlias ? cache : path.join(alias, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
          expect(publishOwn(path.join(spelled, '5.9.0'), dir)).toBe(true);
          const result = runCommand(command, commandRunsOnAlias ? alias : dir);
          expect({ commandRunsOnAlias, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ commandRunsOnAlias, status: 0, versions: '5.8.1,5.9.0', moved: 1 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
          rmSync(alias, { recursive: true, force: true });
        }
      }
    }
  });

  test('a path that only starts with the name of a version does not protect that version', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.1', '5.8.10', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }, { scope: 'user', installPath: path.join(cache, '5.8.10') }] });
        const result = runCommand(command, dir);
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.10,5.9.0', moved: 1 });
        expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.1-/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A name that is 300 characters long fails with ENAMETOOLONG on POSIX; Windows reports such a path
  // differently, so this case runs on POSIX only.
  test.skipIf(process.platform === 'win32')('a path that cannot be resolved for a reason other than being absent moves nothing', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, {
          [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'user', installPath: path.join(dir, 'a'.repeat(300)) }],
        });
        const result = runCommand(command, dir);
        expect(result.status).toBe(1);
        expect(digitVersions(cache)).toBe('5.8.0,5.8.1,5.9.0');
        expect(movedAside(dir)).toBe(0);
        expect(result.stdout).toMatch(/Nothing moved/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a path that does not exist, or lies below a file, adds no protection and does not block the move', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1']);
      try {
        writeRegistry(dir, {
          [PLUGIN_ID]: [
            { scope: 'user', version: '5.8.1' },
            { scope: 'user', installPath: path.join(dir, 'gone', 'x') },
            { scope: 'user', installPath: path.join(dir, 'plugins', 'installed_plugins.json', 'x') },
          ],
        });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A POSIX symlink may point at itself; a Windows junction cannot be created that way.
  test.skipIf(process.platform === 'win32')('a cache entry that links to itself, which nothing refers to, is moved aside like any other unused entry', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1']);
      try {
        symlinkSync('5.7.0', path.join(cache, '5.7.0'));
        ageVersions(cache);
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // ---- Everything that says a cache version is in use, one rule at a time ----
  // Rules of the code the commands follow: the plugin registry (resolveInstalledOmcPluginRoots in
  // src/installer/index.ts, purgeStalePluginCacheVersions in src/utils/paths.ts) and the occupancy
  // records (readOccupiedPluginRoots in src/utils/cache-occupancy.ts). Where a command differs it
  // protects more or moves nothing, never less.

  // The registry file is read the same way: a FIFO in its place would block the read, so a registry that
  // is not a regular file counts as unreadable (a link to a regular file is fine, dotfile setups use them).
  test.skipIf(process.platform === 'win32')('a registry that is a FIFO moves nothing instead of hanging, and a link to a regular registry still pins', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1']);
      try {
        const registry = path.join(dir, 'plugins', 'installed_plugins.json');
        expect(spawnSync('mkfifo', [registry]).status).toBe(0);
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/could not be read completely/);
        expect(digitVersions(cache)).toBe('5.8.0,5.8.1');
        expect(movedAside(dir)).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const linked = makeCache(['5.8.0', '5.8.1']);
      try {
        const real = path.join(linked.dir, 'registry-real.json');
        writeFileSync(real, JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] } }));
        symlinkSync(real, path.join(linked.dir, 'plugins', 'installed_plugins.json'));
        const result = runCommand(command, linked.dir, { timeout: 20_000 });
        expect(result.status).toBe(0);
        expect(digitVersions(linked.cache)).toBe('5.8.1');
        expect(movedAside(linked.dir)).toBe(1);
      } finally {
        rmSync(linked.dir, { recursive: true, force: true });
      }
    }
  });

  // Chains: the top entry links to the next one and so on, down to the real directory 5.9.0.
  // 5.0.0 is the only free version; 5.1.0 is the registered one so that "nothing pinned" does not apply.
  function makeChainCache(links: number, form: 'relative' | 'junction') {
    const made = makeCache(['5.0.0', '5.1.0', '5.9.0']);
    mkdirSync(path.join(made.cache, '5.9.0', 'scripts'));
    ageVersions(made.cache);
    for (let i = 1; i <= links; i++) link(`5.${10 - i}.0`, path.join(made.cache, `5.${9 - i}.0`), form);
    const chainNames = Array.from({ length: links + 1 }, (_unused, i) => `5.${9 - links + i}.0`);
    return { ...made, top: chainNames[0], chainNames };
  }

  const pinKinds = ['version', 'installPath', 'installPath below it', 'occupancy record', 'installPath of another plugin', 'plugin root variable'] as const;
  // Writes the one reference to `target` (a path or a name in the cache) that the case is about.
  function referTo(kind: (typeof pinKinds)[number], dir: string, cache: string, name: string, subpath = ''): Record<string, string> {
    const registry: Record<string, unknown> = { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }] };
    const target = path.join(cache, name, subpath);
    let env: Record<string, string> = {};
    if (kind === 'version') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: name }];
    if (kind === 'installPath') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: path.join(cache, name) }];
    if (kind === 'installPath below it') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: path.join(cache, name, 'scripts') }];
    if (kind === 'installPath of another plugin') registry['other-plugin@market'] = [{ scope: 'user', installPath: path.join(cache, name) }];
    if (kind === 'plugin root variable') env = { CLAUDE_PLUGIN_ROOT: path.join(cache, name) };
    if (kind === 'occupancy record') writeRecord(dir, target);
    writeRegistry(dir, registry);
    return env;
  }

  for (const links of [2, 3]) {
    test(`a chain of ${links} links protects every link on the way, however the chain is referred to, and the free version is moved`, () => {
      for (const command of commands) {
        for (const form of ['relative', 'junction'] as const) {
          for (const kind of pinKinds) {
            const { dir, cache, top, chainNames } = makeChainCache(links, form);
            try {
              const env = referTo(kind, dir, cache, top);
              const result = runCommand(command, dir, { env });
              expect({ links, form, kind, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
                .toEqual({ links, form, kind, status: 0, versions: ['5.1.0', ...chainNames].sort().join(','), moved: 1 });
              expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.0\.0-/);
              expect(result.stdout).toMatch(/Moved 1 unprotected version/);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });
  }

  test('a link that nothing refers to is moved aside however its target is referred to', () => {
    for (const command of commands) {
      for (const kind of ['version', 'installPath', 'installPath below it', 'occupancy record', 'installPath of another plugin', 'plugin root variable'] as const) {
        const { dir, cache } = makeCache(['5.1.0', '5.9.0']);
        try {
          mkdirSync(path.join(cache, '5.9.0', 'scripts'));
          link('5.9.0', path.join(cache, '5.8.0'));
          ageVersions(cache);
          const env = referTo(kind, dir, cache, '5.9.0');
          const result = runCommand(command, dir, { env });
          expect({ kind, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ kind, status: 0, versions: '5.1.0,5.9.0', moved: 1 });
          expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.0-/);
          expect(lstatSync(path.join(backupDir(dir), readdirSync(backupDir(dir))[0])).isSymbolicLink()).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a link outside the cache on the way to a version protects every cache link behind it', () => {
    for (const command of commands) {
      for (const below of ['', 'scripts']) {
        const { dir, cache, chainNames } = makeChainCache(2, 'relative');
        try {
          link(path.join(cache, chainNames[0]), path.join(dir, 'current'), 'junction');
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: path.join(dir, 'current', below) }] });
          const result = runCommand(command, dir);
          expect({ below, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ below, status: 0, versions: ['5.1.0', ...chainNames].sort().join(','), moved: 1 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a link inside a version that points into another version protects that version too', () => {
    for (const command of commands) {
      for (const subpath of ['shared', path.join('shared', 'scripts')]) {
        const { dir, cache } = makeCache(['5.1.0', '5.6.0', '5.9.0']);
        try {
          mkdirSync(path.join(cache, '5.6.0', 'scripts'));
          ageVersions(cache);
          link(path.join('..', '5.6.0'), path.join(cache, '5.9.0', 'shared'));
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: path.join(cache, '5.9.0', subpath) }] });
          const result = runCommand(command, dir);
          expect({ subpath, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ subpath, status: 0, versions: '5.1.0,5.6.0,5.9.0', moved: 0 });
          expect(result.stdout).toMatch(/Nothing to move/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // Names `6.<i>.0`: link i points at i + 1 and the last one is the real directory.
  function makeLongChain(links: number) {
    const made = makeCache(['5.0.0', '5.1.0', `6.${links}.0`]);
    for (let i = links - 1; i >= 0; i--) link(`6.${i + 1}.0`, path.join(made.cache, `6.${i}.0`));
    return { ...made, names: Array.from({ length: links + 1 }, (_unused, i) => `6.${i}.0`) };
  }

  test('a chain of 40 links is followed to the end', () => {
    for (const command of commands) {
      const { dir, cache, names } = makeLongChain(40);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: '6.0.0' }] });
        const result = runCommand(command, dir);
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
          .toEqual({ status: 0, versions: ['5.1.0', ...names].sort().join(','), moved: 1 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a chain of more than 40 links counts as unresolvable and moves nothing', () => {
    for (const command of commands) {
      const { dir, cache, names } = makeLongChain(41);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: '6.0.0' }] });
        const result = runCommand(command, dir);
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
          .toEqual({ status: 1, versions: ['5.0.0', '5.1.0', ...names].sort().join(','), moved: 0 });
        expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The file system can fail to read a link after it reported one (a race, a permission, a filter driver).
  test('a link whose target cannot be read moves nothing', () => {
    const failReadlinkPreload = `const fs = require('fs');
fs.readlinkSync = function () { const e = new Error('injected readlink failure'); e.code = 'EIO'; throw e; };
`;
    for (const command of commands) {
      const { dir, cache, top } = makeChainCache(1, 'relative');
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: top }] });
        const preload = path.join(dir, 'fail-readlink.cjs');
        writeFileSync(preload, failReadlinkPreload);
        const result = runCommand(command, dir, { preloads: [preload] });
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
          .toEqual({ status: 1, versions: '5.0.0,5.1.0,5.8.0,5.9.0', moved: 0 });
        expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A POSIX symlink loop between two cache entries; the junctions of Windows are created from existing targets only.
  test.skipIf(process.platform === 'win32')('a referenced chain that loops back on itself moves nothing, an unreferenced one is moved aside', () => {
    for (const command of commands) {
      for (const referenced of [true, false]) {
        const { dir, cache } = makeCache(['5.1.0', '5.9.0']);
        try {
          symlinkSync('5.7.0', path.join(cache, '5.8.0'));
          symlinkSync('5.8.0', path.join(cache, '5.7.0'));
          ageVersions(cache);
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, ...(referenced ? [{ scope: 'user', version: '5.7.0' }] : [])] });
          const result = runCommand(command, dir);
          expect({ referenced, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual(referenced
              ? { referenced, status: 1, versions: '5.1.0,5.7.0,5.8.0,5.9.0', moved: 0 }
              : { referenced, status: 0, versions: '5.1.0', moved: 3 });
          if (referenced) expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('the installPath of another plugin is not a pin: with no registered version of ours nothing is moved', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
      try {
        writeRegistry(dir, { 'other-plugin@market': [{ scope: 'user', installPath: path.join(cache, '5.9.0') }] });
        const result = runCommand(command, dir);
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.0,5.9.0', moved: 0 });
        expect(result.stdout).toMatch(/Nothing moved: no pinned/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the plugin root variables protect the version they point into, and two different ones move nothing', () => {
    const cases: Array<{ label: string; env: (cache: string) => Record<string, string>; expected: 'moved 1' | 'nothing moved' }> = [
      { label: 'CLAUDE_PLUGIN_ROOT', env: (c) => ({ CLAUDE_PLUGIN_ROOT: path.join(c, '5.9.0') }), expected: 'moved 1' },
      { label: 'OMC_PLUGIN_ROOT', env: (c) => ({ OMC_PLUGIN_ROOT: path.join(c, '5.9.0', 'scripts') }), expected: 'moved 1' },
      // The path is kept as written, so a padded one is a relative path (it starts with a space) that cannot protect a version reliably.
      { label: 'the same directory in both, one padded with spaces', env: (c) => ({ OMC_PLUGIN_ROOT: ` ${path.join(c, '5.9.0')} `, CLAUDE_PLUGIN_ROOT: path.join(c, '5.9.0') }), expected: 'nothing moved' },
      { label: 'two different directories', env: (c) => ({ OMC_PLUGIN_ROOT: path.join(c, '5.9.0'), CLAUDE_PLUGIN_ROOT: path.join(c, '5.8.0') }), expected: 'nothing moved' },
    ];
    for (const command of commands) {
      for (const { label, env, expected } of cases) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, dir, { env: env(cache) });
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            expected === 'moved 1'
              ? { label, status: 0, versions: '5.8.0,5.9.0', moved: 1 }
              : { label, status: 1, versions: '5.7.0,5.8.0,5.9.0', moved: 0 },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // Two names of one directory are not a conflict: the variables are compared after resolving links, by device and inode.
  // The platform name a process reports decides nothing: the alias of letter case names the directory where the volume folds case.
  test('the plugin root variables naming one directory through links or letter case are not a conflict', () => {
    const upperOf = (dir: string, cache: string) => upperBelow(dir, path.join(cache, '5.9.0'));
    const aliases: Array<{ label: string; simulated: false | 'win32' | 'darwin'; env: (dir: string, cache: string) => Record<string, string>; same: boolean }> = [
      { label: 'a link to the directory', simulated: false, same: true, env: (d, c) => { link(path.join(c, '5.9.0'), path.join(d, 'alias')); return { OMC_PLUGIN_ROOT: path.join(c, '5.9.0'), CLAUDE_PLUGIN_ROOT: path.join(d, 'alias') }; } },
      { label: 'a link to a link, the other variable one level deeper', simulated: false, same: true, env: (d, c) => { link(path.join(c, '5.9.0'), path.join(d, 'alias1')); link(path.join(d, 'alias1'), path.join(d, 'alias2')); return { OMC_PLUGIN_ROOT: path.join(d, 'alias2'), CLAUDE_PLUGIN_ROOT: path.join(c, '5.9.0') }; } },
      { label: 'letter case only, reported as win32', simulated: 'win32', same: true, env: (d, c) => ({ OMC_PLUGIN_ROOT: path.join(c, '5.9.0'), CLAUDE_PLUGIN_ROOT: upperOf(d, c) }) },
      { label: 'letter case only, reported as darwin', simulated: 'darwin', same: true, env: (d, c) => ({ OMC_PLUGIN_ROOT: path.join(c, '5.9.0'), CLAUDE_PLUGIN_ROOT: upperOf(d, c) }) },
      { label: 'letter case only, reported as the real platform (where the volume tells the names apart the alias names no directory and takes no part)', simulated: false, same: true, env: (d, c) => ({ OMC_PLUGIN_ROOT: path.join(c, '5.9.0'), CLAUDE_PLUGIN_ROOT: upperOf(d, c) }) },
    ];
    for (const command of commands) {
      for (const { label, simulated, env, same } of aliases) {
        // 5.8.0 is pinned, 5.9.0 is named by the variables, 5.7.0 is free.
        const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const preload = path.join(dir, 'platform.cjs');
          if (simulated) writeFileSync(preload, platformPreload(simulated));
          const result = runCommand(command, dir, { env: env(dir, cache), preloads: simulated ? [preload] : [] });
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            same
              ? { label, status: 0, versions: '5.8.0,5.9.0', moved: 1 }
              : { label, status: 0, versions: '5.7.0,5.8.0,5.9.0', moved: 0 },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The protection is read again just before each move. A preload runs the change that a concurrent
  // SessionStart (a published record) or an installer (a new pin) makes after the first read: it fires when
  // the command creates the backup directory, which happens after the first read and before the first move.
  test('a record or a pin that appears after the first read still protects a version, and a registry that turns unreadable stops the move', () => {
    const racePreload = `const fs = require('fs'), path = require('path'), crypto = require('crypto');
const realMkdir = fs.mkdirSync;
let fired = false;
fs.mkdirSync = function (target, ...rest) {
  if (!fired && String(target) === process.env.RACE_BACKUP) {
    fired = true;
    const kind = process.env.RACE_KIND;
    if (kind === 'record') {
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, '.omc', 'cache-occupancy');
      realMkdir.call(fs, dir, { recursive: true });
      const record = JSON.stringify({ version: 1, pid: process.pid, pluginRoot: process.env.RACE_ROOT, host: ${JSON.stringify(ownHost())}, updatedAt: new Date().toISOString() });
      fs.writeFileSync(path.join(dir, crypto.createHash('sha256').update(record).digest('hex') + '.json'), record);
    } else if (kind === 'pin') {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), process.env.RACE_REGISTRY);
    } else {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), '{ not json');
    }
  }
  return realMkdir.call(fs, target, ...rest);
};
`;
    for (const command of commands) {
      for (const kind of ['record', 'pin', 'unreadable registry'] as const) {
        // 5.8.0 is pinned from the start; 5.8.1 and 5.9.0 are free at the first read.
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const preload = path.join(dir, 'race.cjs');
          writeFileSync(preload, racePreload);
          const env = {
            RACE_KIND: kind === 'unreadable registry' ? 'unreadable' : kind,
            RACE_BACKUP: backupDir(dir),
            RACE_ROOT: path.join(cache, '5.9.0'),
            RACE_REGISTRY: JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }, { scope: 'user', version: '5.9.0' }] } }),
          };
          const result = runCommand(command, dir, { env, preloads: [preload] });
          expect(result.status).toBe(0);
          // A record or a pin on 5.9.0 keeps it and 5.8.1 (still free) is moved; an unreadable registry moves nothing.
          expect({ kind, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            kind === 'unreadable registry'
              ? { kind, versions: '5.8.0,5.8.1,5.9.0', moved: 0 }
              : { kind, versions: '5.8.0,5.9.0', moved: 1 },
          );
          expect(result.stdout).toMatch(kind === 'unreadable registry' ? /Skipped 2 version\(s\)/ : /Skipped 1 version\(s\)/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The reads of the protection walk the registry and the occupancy records and take their time: an update that touches the version during any of
  // them is seen by a date check that follows it, the last one being the check on the version already moved to the backup. The touch is played at the
  // n-th read of the occupancy directory, for every read of the run.
  test('a version that an update touches during any read of the protection, the last one included, is left in place', () => {
    const touch = `const fs = require('fs'), path = require('path'); const real = fs.readdirSync; let reads = 0;
fs.readdirSync = function (target, ...rest) {
  const names = real.call(this, target, ...rest);
  if (String(target).endsWith('cache-occupancy') && ++reads === Number(process.env.TOUCH_AT)) {
    const now = new Date();
    try { fs.utimesSync(path.join(process.env.TOUCH_DIR, 'package.json'), now, now); } catch { /* the version is already in the backup: an update would write a new directory */ }
  }
  return names;
};
`;
    for (const command of commands) {
      for (const at of [1, 2, 3, 4, 5, 6]) {
        const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          ageVersions(cache);
          mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
          const preload = path.join(dir, 'touch.cjs');
          writeFileSync(preload, touch);
          const result = runCommand(command, dir, { env: { TOUCH_AT: String(at), TOUCH_DIR: path.join(cache, '5.8.0') }, preloads: [preload] });
          expect(result.status).toBe(0);
          // Reads 5 and 6 come after the move (the version is in the backup and an update would write a new directory), and the version stays moved.
          expect({ command, at, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            at >= 5 ? { command, at, versions: '5.9.0', moved: 1 } : { command, at, versions: '5.8.0,5.9.0', moved: 0 },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The other direction: a session publishes its record while the dates are walked, after the protection was read, and a publication changes no date.
  // The version is moved first and both signals are read once more with it out of the cache; one that shows use is put back. The record is
  // published during the n-th walk of the version (before and after the move), for every walk of the run; where the original place is taken
  // again at that moment the version cannot be put back, stays in the backup and the command says so.
  const publishDuring = `const fs = require('fs'), path = require('path'), crypto = require('crypto'); const real = fs.lstatSync; let walks = 0;
fs.lstatSync = function (target, ...rest) {
  const text = String(target);
  if (text.endsWith(path.sep + 'package.json') && (text.startsWith(process.env.WALK_DIR + path.sep) || text.startsWith(process.env.BACKUPS + path.sep)) && ++walks === Number(process.env.PUBLISH_AT)) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, '.omc', 'cache-occupancy');
    fs.mkdirSync(dir, { recursive: true });
    const record = JSON.stringify({ version: 1, pid: process.pid, pluginRoot: process.env.RECORD_ROOT || process.env.WALK_DIR, host: process.env.OWN_HOST, updatedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, crypto.createHash('sha256').update(record).digest('hex') + '.json'), record);
    if (process.env.RETAKE && !fs.existsSync(process.env.WALK_DIR)) fs.mkdirSync(process.env.WALK_DIR);
  }
  return real.call(this, target, ...rest);
};
`;
  const publishAt = (command: string, at: number, retake = false, alias: 'none' | 'fold' | 'plain' = 'none') => {
    const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
    try {
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
      ageVersions(cache);
      const preload = path.join(dir, 'publish.cjs');
      writeFileSync(preload, publishDuring);
      // alias: the record names the version in another letter case; 'fold' plays a volume that ignores letter case, 'plain' leaves the volume as it is.
      const env = { PUBLISH_AT: String(at), WALK_DIR: path.join(cache, '5.8.0'), BACKUPS: backupDir(dir), OWN_HOST: ownHost(), ...(retake ? { RETAKE: '1' } : {}), ...(alias === 'none' ? {} : { RECORD_ROOT: upperBelow(dir, path.join(cache, '5.8.0')) }) };
      const result = runCommand(command, dir, { env, preloads: [...(alias === 'fold' ? [writeCaseFoldPreload(dir)] : []), preload] });
      return { status: result.status, versions: digitVersions(cache), moved: movedAside(dir), said: /could not be put back|stays in/.test(result.stdout) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test('a record published during any date walk, the last one included, keeps the version', () => {
    for (const command of commands) {
      // Walks 1 and 2 are before the move, walk 3 is the one after it; there is no walk 4, so the version is moved there.
      for (const at of [1, 2, 3]) expect({ command, at, ...publishAt(command, at) }).toEqual({ command, at, status: 0, versions: '5.8.0,5.9.0', moved: 0, said: false });
      expect({ command, at: 4, ...publishAt(command, 4) }).toEqual({ command, at: 4, status: 0, versions: '5.9.0', moved: 1, said: false });
    }
  });

  // After the move the original spelling of the version names nothing, so a record that spells it in another letter case cannot be resolved by
  // identity any more: on a volume that ignores letter case it is the same directory and keeps the version, where the volume tells the names
  // apart it names nothing here and the version is moved.
  test('a record published after the last scan that spells the version in another letter case keeps it on a volume that ignores letter case', () => {
    for (const command of commands) {
      expect({ command, ...publishAt(command, 3, false, 'fold') }).toEqual({ command, status: 0, versions: '5.8.0,5.9.0', moved: 0, said: false });
      if (!folds) expect({ command, ...publishAt(command, 3, false, 'plain') }).toEqual({ command, status: 0, versions: '5.9.0', moved: 1, said: false });
    }
  });

  // The same publication through the registry: an entry written right after the move, with no record, names the version by a path (an
  // installPath of another plugin, or a pin by path alone). It has no identity to resolve either, so its text is read folded like a record.
  const registryAfterMove = `const fs = require('fs'), path = require('path'); const real = fs.lstatSync; let written = false;
fs.lstatSync = function (target, ...rest) {
  const text = String(target);
  if (!written && text.endsWith(path.sep + 'package.json') && text.startsWith(process.env.BACKUPS + path.sep)) {
    written = true;
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), process.env.REGISTRY_AFTER);
  }
  return real.call(this, target, ...rest);
};
`;
  const registryAt = (command: string, kind: 'installPath of another plugin' | 'pin by path' | 'pin by version', spelling: 'as written' | 'upper case' | 'elsewhere', volume: 'fold' | 'plain') => {
    // A version that has letters, so that another letter case spells it differently.
    const old = kind === 'pin by version' ? '5.8.0-rc1' : '5.8.0';
    const { dir, cache } = makeCache([old, '5.9.0']);
    try {
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
      ageVersions(cache);
      const version = spelling === 'as written' ? old : spelling === 'upper case' ? old.toUpperCase() : '4.0.0';
      const named = spelling === 'as written' ? path.join(cache, old) : spelling === 'upper case' ? upperBelow(dir, path.join(cache, old)) : path.join(dir, 'elsewhere');
      const after =
        kind === 'pin by version'
          ? { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }, { scope: 'user', version }] }
          : kind === 'pin by path'
            ? { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }, { scope: 'user', installPath: named }] }
            : { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }], 'other-plugin@market': [{ scope: 'user', installPath: named }] };
      const preload = path.join(dir, 'registry-after-move.cjs');
      writeFileSync(preload, registryAfterMove);
      const env = { BACKUPS: backupDir(dir), REGISTRY_AFTER: JSON.stringify({ version: 2, plugins: after }) };
      const result = runCommand(command, dir, { env, preloads: [...(volume === 'fold' ? [writeCaseFoldPreload(dir)] : []), preload] });
      return { status: result.status, versions: digitVersions(cache), moved: movedAside(dir), skipped: /Skipped 1 version/.test(result.stdout) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // A pin by version alone names the directory by its name in the cache of every marketplace; the directory is gone after the move, so a name
  // in another letter case than the directory is found only by its folded text.
  const kinds = ['installPath of another plugin', 'pin by path', 'pin by version'] as const;
  const kept = (kind: string) => ({ status: 0, versions: kind === 'pin by version' ? '5.8.0-rc1,5.9.0' : '5.8.0,5.9.0', moved: 0, skipped: true });
  const movedOn = { status: 0, versions: '5.9.0', moved: 1, skipped: false };
  test('a registry entry written right after the move that spells the version in another letter case keeps it on a volume that ignores letter case: an installPath of another plugin, a pin by path alone, a pin by version alone', () => {
    for (const command of commands) {
      for (const kind of kinds) {
        expect({ command, kind, ...registryAt(command, kind, 'upper case', 'fold') }).toEqual({ command, kind, ...kept(kind) });
        if (!folds) expect({ command, kind, ...registryAt(command, kind, 'upper case', 'plain') }).toEqual({ command, kind, ...movedOn });
      }
    }
  });
  test('a registry entry written right after the move keeps the version when it spells the path as written and moves it when it names nothing of the cache', () => {
    for (const command of commands) {
      for (const kind of kinds) {
        for (const volume of ['fold', 'plain'] as const) {
          expect({ command, kind, volume, ...registryAt(command, kind, 'as written', volume) }).toEqual({ command, kind, volume, ...kept(kind) });
          expect({ command, kind, volume, ...registryAt(command, kind, 'elsewhere', volume) }).toEqual({ command, kind, volume, ...movedOn });
        }
      }
    }
  });

  test('a version that shows use after the move and whose place is taken again stays in the backup, and the command says so', () => {
    for (const command of commands) {
      expect({ command, ...publishAt(command, 3, true) }).toEqual({ command, status: 1, versions: '5.8.0,5.9.0', moved: 1, said: true });
    }
  });

  // ---- Platforms: the command is plain Node, so these run everywhere; win32 is reported by a preload on the others ----
  const win32Preload = platformPreload('win32');

  // Only the volume folds letter case: a process that reports win32 or darwin over a case-sensitive volume still tells the names apart.
  // The exception adds protection only: the publisher of win32 stores the plugin root of a record in lower case, and the commands
  // also match a record that way on win32 (the runtime reads records in that form).
  test('paths that differ from the cache only in letter case protect a version where the volume folds case, whatever platform the process reports', () => {
    for (const command of commands) {
      for (const kind of ['installPath', 'installPath of another plugin', 'occupancy record'] as const) {
        for (const simulated of ['win32', 'darwin', false] as const) {
          // Skipped on purpose on a host that really is Windows, not to hide a failure: the fixtures are real directories, and Node names a real directory on a Windows disk only by a drive letter or a share (C:\..., C:/..., \\server\...), so no POSIX-style path can name it. The commands read such a path as foreign when the process reports linux or darwin and refuse it on purpose, so these combinations mean nothing there. The same rules run on Linux and macOS, and the win32 combinations run on every host.
          if (process.platform === 'win32' && simulated === 'darwin') continue;
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
          try {
            const upper = upperBelow(dir, path.join(cache, '5.9.0'));
            const registry: Record<string, unknown> = { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }] };
            if (kind === 'installPath') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: upper }];
            if (kind === 'installPath of another plugin') registry['other-plugin@market'] = [{ scope: 'user', installPath: upper }];
            if (kind === 'occupancy record') writeRecord(dir, upper);
            writeRegistry(dir, registry);
            const preload = path.join(dir, 'platform.cjs');
            if (simulated) writeFileSync(preload, platformPreload(simulated));
            const result = runCommand(command, dir, simulated ? { preloads: [preload] } : {});
            expect({ kind, simulated, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
              folds || (kind === 'occupancy record' && simulated === 'win32')
                ? { kind, simulated, status: 0, versions: '5.1.0,5.9.0', moved: 1 }
                : { kind, simulated, status: 0, versions: '5.1.0', moved: 2 },
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('on a platform that reports win32 the start identity cannot be read, so a record of a live process is kept', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        writeRecord(dir, path.join(cache, '5.9.0'), { processStartIdentity: 'not-the-recorded-start' });
        const preload = path.join(dir, 'win32.cjs');
        writeFileSync(preload, win32Preload);
        const result = runCommand(command, dir, { preloads: [preload] });
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.1,5.9.0', moved: 1 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The shell block of a cache command is its comment, the locator line, the check that the guide can be printed and the
  // call, so the command is the script run as written: no code of the command sits in the shell text.
  test('the shell block of each cache command is the comment, the locator line, the guide check and the call of the script', () => {
    for (const command of commands) {
      const lines = blockOf(command).split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0].startsWith('# ')).toBe(true);
      expect(lines[1].startsWith('S=; ')).toBe(true);
      expect(lines[2]).toBe(GUIDE_GUARD);
      expect(lines[3]).toBe(`node "$S" ${command}`);
    }
  });

  test.skipIf(process.platform === 'win32')('the shell block run by bash and the script run by node give the same output and the same tree', () => {
    const fixtures = () => {
      const made = makeChainCache(2, 'relative');
      writeRegistry(made.dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: made.top }] });
      writeRecord(made.dir, path.join(made.cache, '5.9.0'), { pid: deadPid() });
      return made;
    };
    for (const command of commands) {
      const outcome = (viaBash: boolean) => {
        const { dir, cache } = fixtures();
        try {
          const result = viaBash ? runBlock(command, dir) : runCommand(command, dir);
          return { status: result.status, stdout: result.stdout.split(dir).join('<dir>'), versions: digitVersions(cache), moved: movedAside(dir) };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      const viaNode = outcome(false);
      expect(viaNode.moved).toBe(1);
      expect(outcome(true)).toEqual(viaNode);
    }
  });
});
