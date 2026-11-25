import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, commands, digitVersions, scriptText, movedAside, PLUGIN_ID, makeCache, runCommand, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { deadPid, epermPreload, minutes, writeRecord } from './helpers/omc-doctor-occupancy-fixture.js';

// What an occupancy record says about a cache version: only a record whose owner is not proven gone protects, a record of
// another system cannot be judged, and an entry that is not a regular file is skipped without being opened.
describe('omc-doctor cache commands: occupancy records', { timeout: 120_000 }, () => {

  // Occupancy of 5.9.0 while 5.8.1 is the registered version: 'kept' means 5.9.0 stays and only 5.8.0 is
  // moved, 'moved' means the record protects nothing and 5.8.0 and 5.9.0 are both moved.
  const readsIdentity = process.platform === 'linux';
  const occupancyCases: Array<{ label: string; write: (dir: string, root: string) => string; expected: 'kept' | 'moved'; eperm?: true }> = [
    { label: 'live process, recorded start identity matches', write: (d, r) => writeRecord(d, r), expected: 'kept' },
    { label: 'live process, record 30 days old (no expiry by age)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(-30 * 24 * 60) }), expected: 'kept' },
    { label: 'live process, record dated 4 minutes ahead (within the clock tolerance)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(4) }), expected: 'kept' },
    { label: 'record dated 6 minutes ahead', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(6) }), expected: 'moved' },
    { label: 'process that no longer exists', write: (d, r) => writeRecord(d, r, { pid: deadPid() }), expected: 'moved' },
    { label: 'process that does not exist here, record of another host or PID namespace (it cannot be judged by a local probe)', write: (d, r) => writeRecord(d, r, { pid: deadPid(), host: 'another-machine|pid:[4026539999]' }), expected: 'kept' },
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

  // The doctor is plain Node and cannot import the plugin's helper, so it repeats the rule of scripts/lib/cache-occupancy.mjs that tells a
  // record of another host or PID namespace from a local one; both texts are run here, with the same host and namespace, on the same records.
  test('the doctor tells a record of another place from a local one exactly as the helper of the runtime does', () => {
    const lib = readFileSync(path.join(ROOT, 'scripts', 'lib', 'cache-occupancy.mjs'), 'utf8');
    const libSource = lib.slice(lib.indexOf('function placeId()'), lib.indexOf('function alive(')).replace('export function', 'function');
    const doctorSource = scriptText.slice(scriptText.indexOf('const placeId = '), scriptText.indexOf('// A record is ignored only when')).replace(/^const (\w+) = /gm, 'var $1 = ');
    const records = [{}, { host: '' }, { host: 5 }, { host: null }, { host: 'machine-a' }, { host: 'machine-a|pid:[1]' }, { host: 'machine-b' }, { host: 'machine-b|pid:[1]' }, { host: 'machine-b|pid:[2]' }, undefined];
    for (const place of [{ host: 'machine-a', namespace: '' }, { host: 'machine-a', namespace: 'pid:[1]' }, { host: 'machine-b', namespace: 'pid:[2]' }]) {
      const sandbox = { readlinkSync: () => { if (!place.namespace) throw new Error('not linux'); return place.namespace; }, hostname: () => place.host };
      const fromLib = vm.runInNewContext(`${libSource}\nrecords => records.map(isForeignOwner)`, sandbox) as (records: unknown[]) => boolean[];
      const fromDoctor = vm.runInNewContext(`${doctorSource}\nrecords => records.map(isForeignOwner)`, { fs: { readlinkSync: sandbox.readlinkSync }, os: { hostname: sandbox.hostname } }) as (records: unknown[]) => boolean[];
      expect({ place, doctor: fromDoctor(records) }).toEqual({ place, doctor: fromLib(records) });
    }
  });

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

  // A record of a Windows session in a configuration directory that a Linux or macOS doctor shares (WSL): its plugin root is a
  // Windows path and its process identity is a tick count, neither of which this system can judge. It is unreadable, not gone.
  // A relative plugin root is the same kind of record: resolved against the working directory it names nothing certain.
  test.skipIf(process.platform === 'win32')('an occupancy record written by a Windows session cannot be judged here: nothing is moved, the record stays', () => {
    const roots = (cache: string) => [
      ['a drive path', 'C:\\Users\\u\\.claude\\plugins\\cache\\omc\\oh-my-claudecode\\5.9.0', {}],
      ['a UNC path', '\\\\server\\share\\cache\\5.9.0', {}],
      ['a UNC path with slashes', '//server/share/cache/5.9.0', {}],
      ['a drive path of a gone process', 'C:\\cache\\5.9.0', { pid: deadPid() }],
      ['a relative plugin root (names another directory for each working directory)', 'plugins/cache/omc/oh-my-claudecode/5.9.0', {}],
      ['a tick-count start identity under a POSIX path', path.join(cache, '5.9.0'), { processStartIdentity: 'ticks:638000000000000000' }],
    ] as const;
    for (const command of commands) {
      // Whether a record can be judged depends on the system the command really runs on, not on the platform it reports.
      for (const reported of ['linux', 'win32']) for (const [label, root, overrides] of roots('')) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          const target = label.startsWith('a tick') ? path.join(cache, '5.9.0') : root;
          const file = writeRecord(dir, target, overrides);
          expect(existsSync(file)).toBe(true);
          const preload = path.join(dir, `platform-${reported}.cjs`);
          writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${reported}' });\n`);
          const result = runCommand(command, dir, { preloads: [preload] });
          expect({ label, reported, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ label, reported, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0 });
          expect(result.stdout).toContain('Nothing moved');
          expect({ label, record: existsSync(file) }).toEqual({ label, record: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The reverse direction cannot be run on a Linux host (the host decides, not the reported platform), so the rule itself is
  // taken from the script and asked with the host named: on a Windows host a rooted POSIX path of a record is foreign, a drive
  // or UNC path is not; on a POSIX host the Windows forms are foreign and a POSIX path is not.
  test('a record or root variable path of the other system is foreign to the host, whichever host it is', () => {
    const grab = (name: string) => {
      const hit = scriptText.match(new RegExp(`^const ${name} = [\\s\\S]*?;\\n(?=\\S|$)`, 'm'));
      if (!hit) throw new Error(`${name} not found in the script`);
      return hit[0];
    };
    const build = new Function('path', 'isDirectory', `${grab('windowsPath')}\n${grab('foreignToHost')}\nreturn foreignToHost;`);
    const foreignToHost = build({ sep: '/' }, () => false) as (target: string, windowsHost?: boolean) => boolean;
    const asked = (target: string, windowsHost: boolean) => foreignToHost(target, windowsHost);
    for (const posixRoot of ['/mnt/c/Users/u/.claude/plugins/cache/omc/oh-my-claudecode/5.7.0', '/home/u/cache/5.7.0']) {
      expect({ posixRoot, onWindows: asked(posixRoot, true), onPosix: asked(posixRoot, false) }).toEqual({ posixRoot, onWindows: true, onPosix: false });
    }
    // A current-drive-rooted path (one leading backslash) is local on a Windows host; on a POSIX host it is no Windows path at all
    // (a relative name, refused as such elsewhere).
    const driveRooted = '\\Users\\u\\.claude\\plugins\\cache\\omc\\oh-my-claudecode\\5.7.0';
    expect({ onWindows: asked(driveRooted, true), onPosix: asked(driveRooted, false) }).toEqual({ onWindows: false, onPosix: false });
    for (const windowsRoot of ['C:\\Users\\u\\cache\\5.7.0', 'c:/users/u/cache/5.7.0', '\\\\server\\share\\5.7.0', '//server/share/5.7.0']) {
      expect({ windowsRoot, onWindows: asked(windowsRoot, true), onPosix: asked(windowsRoot, false) }).toEqual({ windowsRoot, onWindows: false, onPosix: true });
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
});
