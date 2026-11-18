import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commands, scriptOf, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, makeCache, writeRegistry } from './helpers/omc-doctor-cache-fixture';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../scripts/lib/cache-occupancy.mjs';

describe('omc-doctor cache commands on a synthetic config directory (occupancy, links, platforms)', { timeout: 120_000 }, () => {
  // A symlink on POSIX; a junction with an absolute target on Windows (no privilege needed), which is
  // also what the SessionStart cleanup creates there. `junction` forces that form on every platform.
  function link(target: string, at: string, form: 'relative' | 'junction' = 'relative') {
    if (form === 'junction' || process.platform === 'win32') symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
    else symlinkSync(target, at);
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
        expect(result.status).toBe(0);
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

  // The start identity the SessionStart publisher records for this process (the platform's own form).
  // On Windows the probe starts PowerShell with a 3 s limit, so it is read once, with retries, and reused.
  let identityOfThisProcess: string | undefined;
  function ownIdentity(): string {
    if (identityOfThisProcess) return identityOfThisProcess;
    const probe = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
    try {
      let published = false;
      for (let attempt = 0; attempt < 3 && !published; attempt++) published = publishCacheOccupancy(probe, probe, process.pid);
      expect(published).toBe(true);
      const directory = path.join(probe, '.omc', 'cache-occupancy');
      identityOfThisProcess = JSON.parse(readFileSync(path.join(directory, readdirSync(directory)[0]), 'utf8')).processStartIdentity as string;
      return identityOfThisProcess;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }

  // Publishes a record for this process with the publisher the SessionStart hook uses.
  function publishOwn(root: string, dir: string): boolean {
    return publishCacheOccupancy(root, dir, process.pid, ownIdentity());
  }

  // An occupancy record that is valid for this live process unless `overrides` says otherwise.
  function writeRecord(dir: string, root: string, overrides: Record<string, unknown> = {}): string {
    const record = { version: 1, pid: process.pid, processStartIdentity: ownIdentity(), pluginRoot: root, updatedAt: new Date().toISOString(), ...overrides };
    const directory = path.join(dir, '.omc', 'cache-occupancy');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`);
    writeFileSync(file, JSON.stringify(record));
    return file;
  }

  // The pid of a child that has already exited.
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(typeof child.pid).toBe('number');
    return child.pid as number;
  }

  const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

  // `kill(pid, 0)` of the command's process reports EPERM for the pid in EPERM_PID: the process exists
  // but belongs to another user (a user that is not root cannot signal it).
  const epermPreload = `const real = process.kill;
process.kill = function (pid, signal) {
  if (signal === 0 && pid === Number(process.env.EPERM_PID)) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
  return real.call(process, pid, signal);
};
`;

  // Occupancy of 5.9.0 while 5.8.1 is the registered version: 'kept' means 5.9.0 stays and only 5.8.0 is
  // moved, 'moved' means the record protects nothing and 5.8.0 and 5.9.0 are both moved.
  const readsIdentity = process.platform === 'linux';
  const occupancyCases: Array<{ label: string; write: (dir: string, root: string) => string; expected: 'kept' | 'moved'; eperm?: true }> = [
    { label: 'live process, recorded start identity matches', write: (d, r) => writeRecord(d, r), expected: 'kept' },
    { label: 'live process, record 30 days old (no expiry by age)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(-30 * 24 * 60) }), expected: 'kept' },
    { label: 'live process, record dated 4 minutes ahead (within the clock tolerance)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(4) }), expected: 'kept' },
    { label: 'record dated 6 minutes ahead', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(6) }), expected: 'moved' },
    { label: 'process that no longer exists', write: (d, r) => writeRecord(d, r, { pid: deadPid() }), expected: 'moved' },
    { label: 'process that no longer exists, record without a plugin root (proven gone is enough, it cannot block)', write: (d, r) => writeRecord(d, r, { pid: deadPid(), pluginRoot: undefined }), expected: 'moved' },
    { label: 'pid answers EPERM (alive, owned by another user)', write: (d, r) => writeRecord(d, r, { pid: deadPid() }), expected: 'kept', eperm: true },
    { label: `pid reused by another process: start identity differs (${readsIdentity ? 'read on Linux' : 'cannot be read here, so the record is kept'})`, write: (d, r) => writeRecord(d, r, { processStartIdentity: 'not-the-recorded-start' }), expected: readsIdentity ? 'moved' : 'kept' },
    { label: 'live process, record without a start identity', write: (d, r) => writeRecord(d, r, { processStartIdentity: undefined }), expected: 'kept' },
    { label: 'live process, record with an unparsable date', write: (d, r) => writeRecord(d, r, { updatedAt: 'not a date' }), expected: 'kept' },
    { label: 'live process, record of another format version', write: (d, r) => writeRecord(d, r, { version: 2 }), expected: 'kept' },
    { label: 'record without a pid', write: (d, r) => writeRecord(d, r, { pid: undefined }), expected: 'kept' },
    { label: 'record with a pid that is not positive', write: (d, r) => writeRecord(d, r, { pid: 0 }), expected: 'kept' },
    { label: 'record with a pid that is not an integer', write: (d, r) => writeRecord(d, r, { pid: 'abc' }), expected: 'kept' },
    { label: 'record with a negative pid', write: (d, r) => writeRecord(d, r, { pid: -5 }), expected: 'kept' },
    { label: 'record with a pid written as a string', write: (d, r) => writeRecord(d, r, { pid: String(process.pid) }), expected: 'kept' },
    { label: 'record with a pid that is not a whole number', write: (d, r) => writeRecord(d, r, { pid: 1.5 }), expected: 'kept' },
  ];

  test('an occupancy record protects a version only while its owner is not proven gone, and the commands never delete a record', () => {
    for (const command of commands) {
      for (const { label, write, expected, eperm } of occupancyCases) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          const file = write(dir, path.join(cache, '5.9.0'));
          const preload = path.join(dir, 'eperm.cjs');
          writeFileSync(preload, epermPreload);
          const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid;
          const result = runCommand(command, dir, eperm ? { preloads: [preload], env: { EPERM_PID: String(pid) } } : {});
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            expected === 'kept'
              ? { label, status: 0, versions: '5.8.1,5.9.0', moved: 1 }
              : { label, status: 0, versions: '5.8.1', moved: 2 },
          );
          expect({ label, record: existsSync(file) }).toEqual({ label, record: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // Chains: the top entry links to the next one and so on, down to the real directory 5.9.0.
  // 5.0.0 is the only free version; 5.1.0 is the registered one so that "nothing pinned" does not apply.
  function makeChainCache(links: number, form: 'relative' | 'junction') {
    const made = makeCache(['5.0.0', '5.1.0', '5.9.0']);
    mkdirSync(path.join(made.cache, '5.9.0', 'scripts'));
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
          .toEqual({ status: 0, versions: ['5.0.0', '5.1.0', ...names].sort().join(','), moved: 0 });
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
          .toEqual({ status: 0, versions: '5.0.0,5.1.0,5.8.0,5.9.0', moved: 0 });
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
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }, ...(referenced ? [{ scope: 'user', version: '5.7.0' }] : [])] });
          const result = runCommand(command, dir);
          expect({ referenced, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual(referenced
              ? { referenced, status: 0, versions: '5.1.0,5.7.0,5.8.0,5.9.0', moved: 0 }
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
      { label: 'the same directory in both, with padding', env: (c) => ({ OMC_PLUGIN_ROOT: ` ${path.join(c, '5.9.0')} `, CLAUDE_PLUGIN_ROOT: path.join(c, '5.9.0') }), expected: 'moved 1' },
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
              : { label, status: 0, versions: '5.7.0,5.8.0,5.9.0', moved: 0 },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // ---- Platforms: the command is plain Node, so these run everywhere; win32 is reported by a preload on the others ----
  const win32Preload = `Object.defineProperty(process, 'platform', { value: 'win32' });\n`;
  const folds = process.platform === 'win32';

  test('paths that differ from the cache only in letter case protect a version where the platform folds case', () => {
    for (const command of commands) {
      for (const kind of ['installPath', 'installPath of another plugin', 'occupancy record'] as const) {
        for (const simulated of [true, false]) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
          try {
            const upper = path.join(cache, '5.9.0').toUpperCase();
            const registry: Record<string, unknown> = { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }] };
            if (kind === 'installPath') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: upper }];
            if (kind === 'installPath of another plugin') registry['other-plugin@market'] = [{ scope: 'user', installPath: upper }];
            if (kind === 'occupancy record') writeRecord(dir, upper);
            writeRegistry(dir, registry);
            const preload = path.join(dir, 'win32.cjs');
            writeFileSync(preload, win32Preload);
            const result = runCommand(command, dir, simulated ? { preloads: [preload] } : {});
            const caseFolded = simulated || folds;
            expect({ kind, simulated, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
              caseFolded
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

  // What the node subprocess runs must be what bash runs: nothing in the line may be changed by a double-quoted shell string.
  test('the command lines contain nothing that a double-quoted shell string would change', () => {
    for (const command of commands) {
      expect(command.startsWith('node -e "') && command.endsWith('"')).toBe(true);
      expect(scriptOf(command)).not.toMatch(/["`$]|\\(?!d)/);
    }
  });

  test.skipIf(process.platform === 'win32')('the line run by bash and the script run by node give the same output and the same tree', () => {
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
          const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' };
          const result = viaBash ? spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', env }) : runCommand(command, dir);
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
