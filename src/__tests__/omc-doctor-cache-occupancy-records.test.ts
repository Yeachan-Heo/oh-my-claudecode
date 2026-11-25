import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, commands, digitVersions, scriptText, movedAside, PLUGIN_ID, makeCache, runCommand, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { deadPid, epermPreload, minutes, writeRecord } from './helpers/omc-doctor-occupancy-fixture.js';

// What an occupancy record says about a cache version: only a record whose owner is not proven gone protects, a record of
// another system cannot be judged, and an entry that is not a regular file is skipped without being opened.
// A world a copy of the place logic runs in: the files it can read, the operating system, and what the one program that names the machine answers.
type World = { host: string; files: Record<string, string>; namespace: string; kind: string; program?: { status?: number; stdout?: string; error?: string } };
const windowsAnswer = (guid: string) => ({ status: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n\r\n` });
const macAnswer = (uuid: string) => ({ status: 0, stdout: `+-o Root  <class IORegistryEntry>\n    {\n      "IOPlatformUUID" = "${uuid}"\n    }\n` });
const sandboxes = (world: World, calls: unknown[][] = []) => {
  const readFileSync = (file: string) => { const text = world.files[file]; if (text === undefined) throw new Error('no such file'); return text; };
  const readlinkSync = () => { if (!world.namespace) throw new Error('not linux'); return world.namespace; };
  const hostname = () => world.host;
  const osType = () => world.kind;
  const spawnSync = (...args: unknown[]) => { calls.push(args); return world.program ? { error: world.program.error ? new Error(world.program.error) : undefined, status: world.program.status ?? null, stdout: world.program.stdout ?? '' } : { status: 1, stdout: '' }; };
  const process = { env: { SystemRoot: 'C:\\Windows' } };
  return {
    lib: { readFileSync, readlinkSync, hostname, osType, spawnSync, join: path.win32.join, process },
    doctor: { fs: { readFileSync, readlinkSync }, os: { hostname, type: osType }, childProcess: { spawnSync }, path: { join: path.win32.join }, process },
  };
};

describe('omc-doctor cache commands: occupancy records', { timeout: 120_000 }, () => {

  // Occupancy of 5.9.0 while 5.8.1 is the registered version: 'kept' means 5.9.0 stays and only 5.8.0 is
  // moved, 'moved' means the record protects nothing and 5.8.0 and 5.9.0 are both moved.
  const readsIdentity = process.platform === 'linux';
  const occupancyCases: Array<{ label: string; write: (dir: string, root: string) => string; expected: 'kept' | 'moved'; eperm?: true }> = [
    { label: 'live process, recorded start identity matches', write: (d, r) => writeRecord(d, r), expected: 'kept' },
    { label: 'live process, record 30 days old (no expiry by age)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(-30 * 24 * 60) }), expected: 'kept' },
    { label: 'live process, record dated 4 minutes ahead (within the clock tolerance)', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(4) }), expected: 'kept' },
    { label: 'record dated 6 minutes ahead', write: (d, r) => writeRecord(d, r, { updatedAt: minutes(6) }), expected: 'moved' },
    { label: 'record of another host dated 10 minutes ahead (the clock of that host is not judged here)', write: (d, r) => writeRecord(d, r, { host: 'another-machine|id|pid:[4026539999]', updatedAt: minutes(10) }), expected: 'kept' },
    { label: 'process that no longer exists', write: (d, r) => writeRecord(d, r, { pid: deadPid() }), expected: 'moved' },
    { label: 'process that does not exist here, record of another host or PID namespace (it cannot be judged by a local probe)', write: (d, r) => writeRecord(d, r, { pid: deadPid(), host: 'another-machine|pid:[4026539999]' }), expected: 'kept' },
    { label: 'process that does not exist here, record without the field host (the previous publisher: unknown origin, never judged by a local probe)', write: (d, r) => writeRecord(d, r, { pid: deadPid(), host: undefined }), expected: 'kept' },
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
    const libSource = lib.slice(lib.indexOf('function machineId()'), lib.indexOf('function alive(')).replace('export function', 'function');
    const doctorSource = scriptText.slice(scriptText.indexOf('const machineId = '), scriptText.indexOf('// A record is ignored only when')).replace(/^const (\w+) = /gm, 'var $1 = ');
    const records = [{}, { host: '' }, { host: 5 }, { host: null }, { host: 'machine-a' }, { host: 'machine-a|pid:[1]' }, { host: 'machine-a|id-1|pid:[1]' }, { host: 'machine-a|id-2|pid:[1]' }, { host: 'machine-a|id-1|' }, { host: 'machine-a||' }, { host: 'machine-b|id-1|pid:[2]' }, { host: 'machine-b||pid:[2]' }, { host: 'machine-a|Windows_NT:GUID-1|' }, { host: 'machine-a|Darwin:UUID-1|' }, undefined];
    // The machine id comes from the first readable of two files; on Windows and macOS from the one program that names the machine; where nothing names it the machine is unknown.
    const worlds: World[] = [
      { host: 'machine-a', files: {}, namespace: '', kind: 'Linux' },
      { host: 'machine-a', files: { '/etc/machine-id': 'id-1\n' }, namespace: 'pid:[1]', kind: 'Linux' },
      { host: 'machine-a', files: { '/var/lib/dbus/machine-id': 'id-2' }, namespace: 'pid:[1]', kind: 'Linux' },
      { host: 'machine-a', files: { '/etc/machine-id': 'id-1', '/var/lib/dbus/machine-id': 'id-2' }, namespace: '', kind: 'Linux' },
      { host: 'machine-b', files: {}, namespace: 'pid:[2]', kind: 'Linux' },
      { host: 'machine-a', files: {}, namespace: '', kind: 'Windows_NT', program: windowsAnswer('GUID-1') },
      { host: 'machine-a', files: {}, namespace: '', kind: 'Windows_NT', program: { status: 1, stdout: '' } },
      { host: 'machine-a', files: {}, namespace: '', kind: 'Windows_NT', program: { error: 'timed out' } },
      { host: 'machine-a', files: {}, namespace: '', kind: 'Darwin', program: macAnswer('UUID-1') },
      { host: 'machine-a', files: {}, namespace: '', kind: 'Darwin', program: { status: 0, stdout: 'no uuid here' } },
    ];
    for (const place of worlds) {
      const { lib: fromLib, doctor: fromDoctor } = sandboxes(place);
      const run = (source: string, sandbox: object) => (vm.runInNewContext(`${source}\nrecords => records.map(isForeignOwner)`, sandbox) as (records: unknown[]) => boolean[])(records);
      expect({ place, doctor: run(doctorSource, fromDoctor) }).toEqual({ place, doctor: run(libSource, fromLib) });
    }
  });

  // Two machines on a shared profile can report the same host name and the same PID namespace text (the namespace of init is the same everywhere
  // on Linux); a record of one, read on the other, must still be foreign, or the local "no such process" would prove its owner gone. Where an
  // operating system names its machine (Windows MachineGuid, macOS IOPlatformUUID) that name tells two machines of one host name apart too; where
  // nothing names the machine it is unknown and every record is foreign.
  test('a record of a machine with the same host name but another machine id is foreign, and a machine nothing names has only foreign records, in the runtime helper and in the doctor', () => {
    const lib = readFileSync(path.join(ROOT, 'scripts', 'lib', 'cache-occupancy.mjs'), 'utf8');
    const libSource = lib.slice(lib.indexOf('function machineId()'), lib.indexOf('function alive(')).replace('export function', 'function');
    const doctorSource = scriptText.slice(scriptText.indexOf('const machineId = '), scriptText.indexOf('// A record is ignored only when')).replace(/^const (\w+) = /gm, 'var $1 = ');
    const base = { host: 'build-host', files: {}, namespace: 'pid:[4026531836]' };
    const linux = (id: string): World => ({ ...base, kind: 'Linux', files: { '/etc/machine-id': `${id}\n` } });
    const windows = (id: string | null): World => ({ ...base, kind: 'Windows_NT', program: id ? windowsAnswer(id) : { status: 1, stdout: '' } });
    const mac = (id: string | null): World => ({ ...base, kind: 'Darwin', program: id ? macAnswer(id) : { status: 0, stdout: '' } });
    const pairs = {
      'another machine id file': [linux('id-of-machine-a'), linux('id-of-machine-b')],
      'another MachineGuid, one host name': [windows('guid-a'), windows('guid-b')],
      'another IOPlatformUUID, one host name': [mac('uuid-a'), mac('uuid-b')],
    } as const;
    for (const [label, [a, b]] of Object.entries(pairs)) {
      for (const side of ['lib', 'doctor'] as const) {
        const source = side === 'lib' ? libSource : doctorSource;
        const ask = (world: World, text: string, record?: unknown) => vm.runInNewContext(`${source}\n${text}`, { ...sandboxes(world)[side], record });
        const fromA = { host: ask(a, 'placeId()') as string };
        expect({ label, side, onA: ask(a, 'isForeignOwner(record)', fromA), onB: ask(b, 'isForeignOwner(record)', fromA) }).toEqual({ label, side, onA: false, onB: true });
      }
    }
    // A machine that nothing names (no file, the program fails) compares with nothing: every record is foreign to it, also one it made itself
    // earlier, and so is a record without the field (the previous publisher).
    for (const unnamed of [windows(null), mac(null), { ...base, kind: 'Linux' } as World]) {
      for (const side of ['lib', 'doctor'] as const) {
        const source = side === 'lib' ? libSource : doctorSource;
        const ask = (world: World, text: string, record?: unknown) => vm.runInNewContext(`${source}\n${text}`, { ...sandboxes(world)[side], record });
        const earlier = { host: ask(windows('guid-a'), 'placeId()') as string };
        expect({ kind: unnamed.kind, side, own: ask(unnamed, 'isForeignOwner(record)', { host: ask(unnamed, 'placeId()') as string }), earlier: ask(unnamed, 'isForeignOwner(record)', earlier), noField: ask(unnamed, 'isForeignOwner(record)', {}) })
          .toEqual({ kind: unnamed.kind, side, own: true, earlier: true, noField: true });
      }
    }
    // The program is run once for a process, however often the place is asked, and with a short limit and no window.
    for (const side of ['lib', 'doctor'] as const) {
      const calls: unknown[][] = [];
      const world = windows('guid-a');
      const sandbox = sandboxes(world, calls)[side];
      vm.runInNewContext(`${side === 'lib' ? libSource : doctorSource}\nplaceId(); placeId(); isForeignOwner({ host: 'x' });`, sandbox);
      expect({ side, runs: calls.length, command: String(calls[0]?.[0]).replace(/\\/g, '/').toLowerCase(), limit: (calls[0]?.[2] as { timeout: number })?.timeout, hidden: (calls[0]?.[2] as { windowsHide: boolean })?.windowsHide })
        .toEqual({ side, runs: 1, command: 'c:/windows/system32/reg.exe', limit: 1000, hidden: true });
    }
  });

  // A profile mounted under another path on the other host: the root of its record is spelled as that host sees it, so it names no version here.
  // The version it holds cannot be told, so nothing is moved while such a record exists; the same path inside a cache protects as before.
  // On a Windows host a rooted POSIX path of a record is already foreign to the host (foreignToHost, asked in a test below), so the command stops there with the
  // general message and never reaches the check of the roots; nothing is moved either way, and only the message differs.
  test('a record of another host whose plugin root lies in no cache of this system stops both commands before anything is moved', () => {
    for (const command of commands) {
      for (const root of ['/Users/b/.claude/plugins/cache/omc/oh-my-claudecode/5.8.0', 'relative-to-nothing/5.8.0']) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          const file = writeRecord(dir, root, { pid: deadPid(), host: 'another-machine|id|pid:[4026539999]' });
          const result = runCommand(command, dir);
          expect({ command, root, status: result.status, versions: digitVersions(cache), moved: movedAside(dir), said: /lies in no cache of this system/.test(result.stdout), record: existsSync(file) })
            .toEqual({ command, root, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0, said: root.startsWith('/') && process.platform !== 'win32', record: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
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
