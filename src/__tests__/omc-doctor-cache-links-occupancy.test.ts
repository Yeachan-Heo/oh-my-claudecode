import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commands, ageVersions, scriptOf, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, makeCache, upperBelow, volumeFoldsCase, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../scripts/lib/cache-occupancy.mjs';

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

  // The shared reader (readOccupiedPluginRoots) inspects an entry with lstat and skips everything that is
  // not a regular file; opening a FIFO for reading would block until a writer shows up.
  test.skipIf(process.platform === 'win32')('an occupancy entry that is not a regular file is skipped without being opened, so the command does not hang', () => {
    for (const command of commands) {
      for (const kind of ['fifo', 'link to a fifo', 'directory'] as const) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1', installPath: path.join(cache, '5.8.1') }] });
          const records = path.join(dir, '.omc', 'cache-occupancy');
          mkdirSync(records, { recursive: true });
          const entry = path.join(records, `${'f'.repeat(64)}.json`);
          if (kind === 'directory') {
            mkdirSync(entry);
          } else {
            const fifo = kind === 'fifo' ? entry : path.join(dir, 'pipe');
            expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
            if (kind === 'link to a fifo') symlinkSync(fifo, entry);
          }
          const result = runCommand(command, dir, { timeout: 20_000 });
          // A hung command is killed by the timeout: no status and an ETIMEDOUT error.
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          // The entry protects nothing; the registered version stays and the others are moved aside.
          expect(digitVersions(cache)).toBe('5.8.1');
          expect(movedAside(dir)).toBe(2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

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
      const record = JSON.stringify({ version: 1, pid: process.pid, pluginRoot: process.env.RACE_ROOT, updatedAt: new Date().toISOString() });
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

  // ---- Platforms: the command is plain Node, so these run everywhere; win32 is reported by a preload on the others ----
  const win32Preload = platformPreload('win32');

  // Only the volume folds letter case: a process that reports win32 or darwin over a case-sensitive volume still tells the names apart.
  // The exception adds protection only: the publisher of win32 stores the plugin root of a record in lower case, and the commands
  // also match a record that way on win32 (the runtime reads records in that form).
  test('paths that differ from the cache only in letter case protect a version where the volume folds case, whatever platform the process reports', () => {
    for (const command of commands) {
      for (const kind of ['installPath', 'installPath of another plugin', 'occupancy record'] as const) {
        for (const simulated of ['win32', 'darwin', false] as const) {
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

  // What the node subprocess runs must be what bash runs: nothing in the line may be changed by a double-quoted shell string (`\d` and `\x5c` pass through).
  test('the command lines contain nothing that a double-quoted shell string would change', () => {
    for (const command of commands) {
      expect(command.startsWith('node -e "') && command.endsWith('"')).toBe(true);
      expect(scriptOf(command)).not.toMatch(/["`$]|\\(?!d|x5c)/);
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
