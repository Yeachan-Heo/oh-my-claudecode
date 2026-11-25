import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, existsSync, lstatSync, symlinkSync, utimesSync } from 'fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { purgeStalePluginCacheVersions } from '../paths.js';
import { processStartIdentities, publishCacheOccupancy, readOccupiedPluginRoots } from '../cache-occupancy.js';

const readFailures = vi.hoisted(() => new Map<string, string>());
const lstatFailures = vi.hoisted(() => new Map<string, string>());
// What the machine id file holds while a test plays another machine; empty reads the real file.
const machineId = vi.hoisted(() => ({ value: '' }));
// The network interfaces a test plays; undefined reads the real ones.
const interfaces = vi.hoisted(() => ({ value: undefined as Record<string, unknown[]> | undefined }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, networkInterfaces: () => (interfaces.value ?? actual.networkInterfaces()) as ReturnType<typeof actual.networkInterfaces> };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    lstatSync: vi.fn((...args: Parameters<typeof actual.lstatSync>) => {
      const code = lstatFailures.get(String(args[0]));
      if (code) throw Object.assign(new Error(code), { code });
      return actual.lstatSync(...args);
    }),
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const code = readFailures.get(String(args[0]));
      if (code) throw Object.assign(new Error(code), { code });
      if (machineId.value && String(args[0]) === '/etc/machine-id') return `${machineId.value}\n`;
      return actual.readFileSync(...args);
    }),
  };
});

describe('cache occupancy registry', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omc-occupancy-')); });
  afterEach(() => { vi.unstubAllEnvs(); readFailures.clear(); lstatFailures.clear(); rmSync(dir, { recursive: true, force: true }); });

  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ].flatMap(([name, path]) => ['EACCES', 'EIO'].map(code => [name, path, code]))) (
    'retains unreadable live records in %s for %s (%s)', async (_name, path, code) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const recordPath = join(registry, readdirSync(registry)[0]);
    readFailures.set(recordPath, code!);

    expect.soft(read(dir).unavailable).toBe(true);
    expect.soft(existsSync(recordPath)).toBe(true);
    readFailures.clear();
    expect(read(dir).roots).toEqual(new Set([root]));
  });

  // The place of this machine as the publisher writes it; a record without it has an unknown origin and counts as foreign.
  const localHost = async (publish: (root: string, configDir: string) => unknown) => {
    const root = join(dir, 'host-probe');
    mkdirSync(root, { recursive: true });
    expect(await publish(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const file = join(registry, readdirSync(registry)[0]);
    const { host } = JSON.parse(readFileSync(file, 'utf8')) as { host: string };
    rmSync(file);
    return host;
  };

  // A record carries where its owner runs (host name and, on Linux, PID namespace). A profile shared over NFS or mounted into a container
  // holds records of owners this machine cannot probe: a local "no such process" or another start time proves nothing about them.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('keeps the record of an owner that runs elsewhere or at an unknown place (no field), and judges only the record of this place locally, for %s', async (_name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const host = await localHost(path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy);
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    const write = (letter: string, fields: Record<string, unknown>) => {
      const file = join(registry, `${letter.repeat(64)}.json`);
      writeFileSync(file, JSON.stringify({ version: 1, pid: exited, processStartIdentity: 'start', pluginRoot: join(dir, `root-${letter}`), updatedAt: new Date().toISOString(), ...fields }));
      return file;
    };
    const foreign = write('a', { host: 'another-machine|pid:[4026539999]' });
    const foreignOtherStart = write('b', { host: 'another-machine|pid:[4026539999]', pid: process.pid });
    // The previous publisher wrote no field: it may be a record of another machine of a shared profile, so it is never probed here.
    const noField = write('c', {});
    const local = write('d', { host });

    const roots = read(dir).roots;

    expect([...roots].sort()).toEqual([join(dir, 'root-a'), join(dir, 'root-b'), join(dir, 'root-c')]);
    expect({ foreign: existsSync(foreign), foreignOtherStart: existsSync(foreignOtherStart), noField: existsSync(noField), local: existsSync(local) }).toEqual({ foreign: true, foreignOtherStart: true, noField: true, local: false });
  });

  // A record of another host names its plugin root as that host sees it (a profile can be mounted under another path there). One that lies in no
  // plugin cache of this configuration directory cannot be matched with a version here: the registry is unavailable, so no cleanup runs on it.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('reports the registry unavailable for a record of another host whose root lies in no cache here, for %s', async (_name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const answers: Record<string, boolean> = {};
    for (const [label, fields, root] of [
      ['another host, root spelled as that host sees it', { host: 'another-machine|id|pid:[4026539999]' }, '/Users/b/.claude/plugins/cache/omc/oh-my-claudecode/4.4.1'],
      ['another host, root in the cache here', { host: 'another-machine|id|pid:[4026539999]' }, join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.4.1')],
      ['no host field, root outside the cache', {}, join(dir, 'checkout')],
    ] as [string, Record<string, unknown>, string][]) {
      for (const name of readdirSync(registry)) rmSync(join(registry, name));
      writeFileSync(join(registry, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, pid: process.pid, processStartIdentity: 'start', pluginRoot: root, updatedAt: new Date().toISOString(), ...fields }));
      answers[label] = read(dir).unavailable;
    }
    expect(answers).toEqual({
      'another host, root spelled as that host sees it': true,
      'another host, root in the cache here': false,
      'no host field, root outside the cache': true,
    });
  });

  // The clock of another host is not judged: a record of another place or of none dated more than 5 minutes ahead is kept, one of this place is not.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('keeps a record of another host dated ten minutes ahead, and drops the same record of this host, for %s', async (_name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const root = join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.4.1');
    const ahead = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const host = await localHost(path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy);
    const answers: Record<string, boolean> = {};
    for (const [label, fields] of [['another host', { host: 'another-machine|id|pid:[4026539999]' }], ['no host field', {}], ['this host', { host }]] as [string, Record<string, unknown>][]) {
      const file = join(registry, `${'b'.repeat(64)}.json`);
      writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, processStartIdentity: 'start', pluginRoot: root, updatedAt: ahead, ...fields }));
      read(dir);
      answers[label] = existsSync(file);
      rmSync(file, { force: true });
    }
    expect(answers).toEqual({ 'another host': true, 'no host field': true, 'this host': false });
  });

  // Two machines can report the same host name and the same PID namespace text; only the machine id tells them apart.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('keeps the record of an owner whose host name and namespace match but whose machine id differs, for %s', async (_name, path) => {
    const publish = path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy;
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publish(root, dir)).toBe(true);
    const file = join(dir, '.omc', 'cache-occupancy', readdirSync(join(dir, '.omc', 'cache-occupancy'))[0]);
    const record = JSON.parse(readFileSync(file, 'utf8')) as { host: string; pid: number };
    const [name, , namespace] = record.host.split('|');
    writeFileSync(file, JSON.stringify({ ...record, pid: spawnSync(process.execPath, ['-e', '']).pid, host: `${name}|another-machine-id|${namespace ?? ''}` }));

    expect(read(dir).roots).toEqual(new Set([root]));
    expect(existsSync(file)).toBe(true);
  });

  // Where no machine id file can be read (Windows, macOS) the hardware addresses of the interfaces name the machine; where there are none the
  // machine is unknown, and a record is then never judged by a local probe either.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('keeps the record of an owner that cannot be told from this machine without a machine id file, for %s', async (_name, path) => {
    const publish = path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy;
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    const card = (mac: string) => ({ eth0: [{ mac, internal: false }] });
    readFailures.set('/etc/machine-id', 'ENOENT');
    readFailures.set('/var/lib/dbus/machine-id', 'ENOENT');
    try {
      interfaces.value = card('aa:aa:aa:aa:aa:aa');
      expect(await (path ? publish(root, dir, process.pid, 'same-start') : publish(root, dir, 'same-start'))).toBe(true);
      const registry = join(dir, '.omc', 'cache-occupancy');
      const file = join(registry, readdirSync(registry)[0]);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pid: spawnSync(process.execPath, ['-e', '']).pid }));
      const answers: Record<string, boolean> = {};
      for (const [label, seen] of [['other address', card('bb:bb:bb:bb:bb:bb')], ['no address', { lo: [{ mac: '00:00:00:00:00:00', internal: true }] }], ['same address', card('aa:aa:aa:aa:aa:aa')]] as [string, Record<string, unknown[]>][]) {
        interfaces.value = seen;
        read(dir);
        answers[label] = existsSync(file);
        if (!existsSync(file)) break;
      }
      // Only the machine that is the owner's own proves the owner gone (the last case removes the record of the exited process).
      expect(answers).toEqual({ 'other address': true, 'no address': true, 'same address': false });
    } finally {
      interfaces.value = undefined;
      readFailures.clear();
    }
  });

  // The place of the owner is part of the name of its record: two sessions of a shared profile that have the same root, the same PID (of
  // their own PID table) and the same start identity must not write the same file, or the later one replaces the record of the first.
  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('keeps one record for each of two owners that differ only in the machine, for %s', async (_name, path) => {
    const publish = path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    try {
      for (const id of ['id-of-machine-a', 'id-of-machine-b']) {
        machineId.value = id;
        expect(await (path ? publish(root, dir, process.pid, 'same-start') : publish(root, dir, 'same-start'))).toBe(true);
      }
    } finally {
      machineId.value = '';
    }
    const registry = join(dir, '.omc', 'cache-occupancy');
    expect(readdirSync(registry).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('writes the place of its owner into a record, so the record stays a local one for %s', async (_name, path) => {
    const publish = path ? (await import(path)).publishCacheOccupancy : publishCacheOccupancy;
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publish(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const record = JSON.parse(readFileSync(join(registry, readdirSync(registry)[0]), 'utf8')) as { host?: unknown };
    expect(typeof record.host === 'string' && record.host.length > 0).toBe(true);
    expect(read(dir).roots).toEqual(new Set([root]));
  });

  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ])('ignores non-file entries in the occupancy registry for %s', async (_name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const entryPath = join(registry, `${'a'.repeat(64)}.json`);
    mkdirSync(entryPath);

    const result = read(dir);

    expect(result.unavailable).toBe(false);
    expect(result.roots.size).toBe(0);
    expect(existsSync(entryPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('ignores self-referential symlinks in all occupancy readers', async () => {
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const entryPath = join(registry, `${'b'.repeat(64)}.json`);
    symlinkSync(entryPath, entryPath);
    for (const path of [null, '../../../scripts/lib/cache-occupancy.mjs', '../../../templates/hooks/lib/cache-occupancy.mjs']) {
      const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
      const result = read(dir);
      expect(result.unavailable).toBe(false);
      expect(result.roots.size).toBe(0);
    }
    expect(lstatSync(entryPath).isSymbolicLink()).toBe(true);
  });

  const readers = [
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ] as const;

  // Symlinks need elevated rights on Windows, so these cases run on POSIX only.
  describe.skipIf(process.platform === 'win32').each(readers)('a registry path that runs through a link, in %s', (_name, path) => {
    const load = async () => (path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots);

    it('reports a link to nothing in place of the registry as unavailable', async () => {
      mkdirSync(join(dir, '.omc'), { recursive: true });
      symlinkSync(join(dir, 'offline-volume', 'cache-occupancy'), join(dir, '.omc', 'cache-occupancy'));
      const result = (await load())(dir);
      expect(result.unavailable).toBe(true);
      expect(result.roots.size).toBe(0);
    });

    it('reports a link to nothing in place of the .omc parent as unavailable', async () => {
      symlinkSync(join(dir, 'offline-volume'), join(dir, '.omc'));
      expect((await load())(dir).unavailable).toBe(true);
    });

    it('reports a link to nothing in place of the config directory as unavailable', async () => {
      const link = join(dir, 'config-link');
      symlinkSync(join(dir, 'offline-volume'), link);
      expect((await load())(link).unavailable).toBe(true);
    });

    it('reports a symlink loop in place of the registry as unavailable', async () => {
      const registry = join(dir, '.omc', 'cache-occupancy');
      mkdirSync(join(dir, '.omc'), { recursive: true });
      symlinkSync(registry, registry);
      expect((await load())(dir).unavailable).toBe(true);
    });

    it('still reads a registry reached through a working link', async () => {
      const root = join(dir, 'plugins', '1.0.0');
      mkdirSync(root, { recursive: true });
      expect(await publishCacheOccupancy(root, dir)).toBe(true);
      const moved = join(dir, 'moved-omc');
      renameSync(join(dir, '.omc'), moved);
      symlinkSync(moved, join(dir, '.omc'));
      const result = (await load())(dir);
      expect(result.unavailable).toBe(false);
      expect(result.roots).toEqual(new Set([root]));
    });
  });

  it.each(readers)('keeps a registry that was never created available and empty in %s', async (_name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    // No .omc at all, then .omc present without a registry.
    expect(read(dir)).toMatchObject({ unavailable: false, roots: new Set() });
    mkdirSync(join(dir, '.omc'));
    expect(read(dir)).toMatchObject({ unavailable: false, roots: new Set() });
    // A config directory that does not exist at all behaves the same way.
    expect(read(join(dir, 'no-such-config-dir'))).toMatchObject({ unavailable: false, roots: new Set() });
  });

  it.each([
    ['typescript', null],
    ['script', '../../../scripts/lib/cache-occupancy.mjs'],
    ['template', '../../../templates/hooks/lib/cache-occupancy.mjs'],
  ].flatMap(([name, path]) => ['EACCES', 'EIO', 'ENOENT'].map(code => [code, name, path]))) (
    'handles lstat %s in the %s reader', async (code, _name, path) => {
    const read = path ? (await import(path)).readOccupiedPluginRoots : readOccupiedPluginRoots;
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const recordPath = join(registry, readdirSync(registry)[0]);
    lstatFailures.set(recordPath, code!);

    const result = read(dir);

    expect(result.unavailable).toBe(code !== 'ENOENT');
    expect(existsSync(recordPath)).toBe(true);
    lstatFailures.clear();
    expect(read(dir).roots).toEqual(new Set([root]));
  });

  it.each(['EACCES', 'EIO'])('preserves a live pinned cache version when its record reports %s', async code => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    const root = join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '1.0.0');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{}');
    writeFileSync(join(root, 'scripts', 'run.cjs'), '// fixture');
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
    utimesSync(root, old, old);
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const recordPath = join(registry, readdirSync(registry)[0]);
    readFailures.set(recordPath, code);

    const result = purgeStalePluginCacheVersions();

    expect.soft(result.removed).toBe(0);
    expect.soft(result.skippedPaths).toContain(root);
    expect.soft(existsSync(join(root, 'scripts', 'run.cjs'))).toBe(true);
    expect(existsSync(recordPath)).toBe(true);
  });

  it.each(['EACCES', 'EIO'])('preserves a live pinned cache version when lstat reports %s', async code => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    const root = join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '1.0.0');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{}');
    writeFileSync(join(root, 'scripts', 'run.cjs'), '// fixture');
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
    utimesSync(root, old, old);
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const recordPath = join(registry, readdirSync(registry)[0]);
    lstatFailures.set(recordPath, code);

    const result = purgeStalePluginCacheVersions();

    expect.soft(result.removed).toBe(0);
    expect.soft(result.skippedPaths).toContain(root);
    expect.soft(existsSync(join(root, 'scripts', 'run.cjs'))).toBe(true);
    expect(existsSync(recordPath)).toBe(true);
  });

  it.each(['../../../scripts/lib/cache-occupancy.mjs', '../../../templates/hooks/lib/cache-occupancy.mjs'])(
    'preserves corruption cleanup and concurrent-disappearance behavior in %s', async path => {
      const { readOccupiedPluginRoots: read } = await import(path);
      const registry = join(dir, '.omc', 'cache-occupancy');
      mkdirSync(registry, { recursive: true });
      const recordPath = join(registry, `${'a'.repeat(64)}.json`);
      writeFileSync(recordPath, '{broken');
      expect(read(dir).unavailable).toBe(false);
      expect(existsSync(recordPath)).toBe(false);
      writeFileSync(recordPath, '{}');
      readFailures.set(recordPath, 'ENOENT');
      expect(read(dir).unavailable).toBe(false);
      expect(existsSync(recordPath)).toBe(true);
    },
  );

  it('treats a concurrently disappeared TypeScript record as available', () => {
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    const recordPath = join(registry, `${'a'.repeat(64)}.json`);
    writeFileSync(recordPath, '{}');
    readFailures.set(recordPath, 'ENOENT');
    expect(readOccupiedPluginRoots(dir).unavailable).toBe(false);
    expect(existsSync(recordPath)).toBe(true);
  });

  it('publishes an atomic, privacy-bounded record and reads the occupied root', async () => {
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const result = readOccupiedPluginRoots(dir);
    expect(result.unavailable).toBe(false);
    expect(result.roots).toEqual(new Set([root]));
    const files = readdirSync(join(dir, '.omc', 'cache-occupancy'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('drops corrupt records without exposing their contents', () => {
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, `${'a'.repeat(64)}.json`), '{broken');
    expect(readOccupiedPluginRoots(dir).roots.size).toBe(0);
    expect(readdirSync(registry)).toEqual([]);
  });

  it('resolves Windows process identities in one PowerShell call', () => {
    const originalPlatform = process.platform;
    const exec = vi.fn(() => JSON.stringify([
      { Id: 41, StartTicks: '638933184000000001' },
      { Id: 42, StartTicks: '638933184000000002' },
    ])) as unknown as Parameters<typeof processStartIdentities>[1];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(processStartIdentities([41, 42, 41], exec)).toEqual(new Map([
        [41, 'ticks:638933184000000001'],
        [42, 'ticks:638933184000000002'],
      ]));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining("[string]$_.StartTime.ToUniversalTime().Ticks")],
        { encoding: 'utf8', windowsHide: true },
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('accepts a single realistic Windows identity and rejects numeric precision loss', () => {
    const originalPlatform = process.platform;
    const exec = vi.fn(() => JSON.stringify({ Id: 41, StartTicks: '638933184000000001' })) as unknown as Parameters<typeof processStartIdentities>[1];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(processStartIdentities([41], exec)).toEqual(new Map([[41, 'ticks:638933184000000001']]));

      const rounded = vi.fn(() => JSON.stringify({ Id: 41, StartTicks: Number('638933184000000001') })) as unknown as Parameters<typeof processStartIdentities>[1];
      expect(processStartIdentities([41], rounded)).toEqual(new Map());
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('publish skips its per-process probe when handed a precomputed identity (#3995)', async () => {
    const root = join(dir, 'plugins', '2.0.0');
    mkdirSync(root, { recursive: true });
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      // A deliberately corrupt precomputed identity would only be accepted
      // verbatim if publish skipped its own probe; the record must carry it
      // untouched (verification happens on read via the identity map).
      expect(await publishCacheOccupancy(root, dir, 'ticks:638933184000000001')).toBe(true);
      // The map-backed read verifies the record without any further probe.
      const result = readOccupiedPluginRoots(dir, { identities: new Map([[process.pid, 'ticks:638933184000000001']]) });
      expect(result.unavailable).toBe(false);
      expect(result.roots).toEqual(new Set([root.toLowerCase()]));
      // A mismatched identity in the map invalidates the record; omitting the
      // map falls back to a fresh batched probe. Both verification paths agree
      // the record is only kept on proven-fresh or unknown identity.
      const mismatched = readOccupiedPluginRoots(dir, { identities: new Map([[process.pid, 'ticks:638933184000000002']]) });
      expect(mismatched.roots.size).toBe(0);
      expect(mismatched.identities.get(process.pid)).toBe('ticks:638933184000000002');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('bounds Windows occupancy probes for script and template helpers', () => {
    const probeDirectory = join(dir, 'fake-bin');
    mkdirSync(probeDirectory);
    const powershell = join(probeDirectory, 'powershell');
    writeFileSync(powershell, '#!/bin/sh\nwhile :; do :; done\n');
    chmodSync(powershell, 0o755);

    const helperPaths = [
      fileURLToPath(new URL('../../../scripts/lib/cache-occupancy.mjs', import.meta.url)),
      fileURLToPath(new URL('../../../templates/hooks/lib/cache-occupancy.mjs', import.meta.url)),
    ];
    const script = `
      import { createHash } from 'node:crypto';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const helper = await import(process.argv[1]);
      const configDir = process.argv[2];
      const pluginRoot = process.argv[3];
      const pid = process.pid;
      const processStartIdentity = 'ticks:638933184000000001';
      const registryDir = join(configDir, '.omc', 'cache-occupancy');
      mkdirSync(registryDir, { recursive: true });
      const name = createHash('sha256').update([pluginRoot, pid, processStartIdentity].join('\\0')).digest('hex');
      writeFileSync(join(registryDir, name + '.json'), JSON.stringify({ version: 1, pid, processStartIdentity, pluginRoot, updatedAt: new Date().toISOString() }));
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const startedAt = Date.now();
      const result = helper.readOccupiedPluginRoots(configDir, { includePids: [pid], probeTimeoutMs: 75 });
      process.stdout.write(JSON.stringify({ roots: [...result.roots], identityCount: result.identities.size, elapsedMs: Date.now() - startedAt }));
    `;

    for (const [index, helperPath] of helperPaths.entries()) {
      const configDir = join(dir, `config-${index}`);
      const pluginRoot = join(dir, 'plugins', `version-${index}`);
      const output = execFileSync(process.execPath, [
        '--input-type=module', '-e', script, pathToFileURL(helperPath).href, configDir, pluginRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, PATH: probeDirectory },
        timeout: 1000,
      });
      const result = JSON.parse(output) as { roots: string[]; identityCount: number; elapsedMs: number };
      expect(result.roots).toEqual([pluginRoot.toLowerCase()]);
      expect(result.identityCount).toBe(0);
      expect(result.elapsedMs).toBeLessThan(500);
    }
  });

  describe.skipIf(process.platform === 'win32')('darwin identity probe', () => {
    const LSTART = 'Tue Jan  6 09:00:00 2026';
    const helperPaths = [
      fileURLToPath(new URL('../../../scripts/lib/cache-occupancy.mjs', import.meta.url)),
      fileURLToPath(new URL('../../../templates/hooks/lib/cache-occupancy.mjs', import.meta.url)),
    ];

    // Runs the real helper with process.platform spoofed to darwin and a fake
    // `ps` first on PATH, so the spawnSync call path is exercised unmodified.
    const probe = (helperPath: string, psBody: string) => {
      const probeDirectory = join(dir, 'fake-bin');
      mkdirSync(probeDirectory, { recursive: true });
      const ps = join(probeDirectory, 'ps');
      const psLog = join(dir, 'ps.log');
      writeFileSync(ps, `#!/bin/sh\necho "$@" >> "$PS_LOG"\n${psBody}\n`);
      chmodSync(ps, 0o755);
      // The first exec of a new script can take seconds on a loaded macOS host,
      // longer than the helper's own ps timeout. Run it once up front.
      spawnSync(ps, ['warmup'], { env: { PATH: probeDirectory, PS_LOG: '/dev/null' }, timeout: 30000 });
      const script = `
        import { createHash } from 'node:crypto';
        import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const helper = await import(process.argv[1]);
        const configDir = process.argv[2];
        const lstart = new Date(process.argv[3]).getTime();
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        mkdirSync(registryDir, { recursive: true });
        // The records are of this machine: a record without the place of its owner is foreign and never probed.
        const scratch = join(configDir, 'scratch');
        helper.publishCacheOccupancy(join(scratch, 'root'), scratch, process.pid, 'scratch-identity');
        const scratchRegistry = join(scratch, '.omc', 'cache-occupancy');
        const host = JSON.parse(readFileSync(join(scratchRegistry, readdirSync(scratchRegistry)[0]), 'utf8')).host;
        // pid 1 is the "gone" pid: the fake ps never prints it.
        const stored = new Map([[process.pid, String(lstart)], [process.ppid, 'stale-identity'], [1, 'unverifiable-identity']]);
        for (const [pid, processStartIdentity] of stored) {
          const pluginRoot = join(configDir, 'plugins', String(pid));
          const name = createHash('sha256').update([pluginRoot, pid, processStartIdentity].join('\\0')).digest('hex');
          writeFileSync(join(registryDir, name + '.json'), JSON.stringify({ version: 1, pid, processStartIdentity, pluginRoot, host, updatedAt: new Date().toISOString() }));
        }
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        const result = helper.readOccupiedPluginRoots(configDir);
        process.stdout.write(JSON.stringify({
          pid: process.pid,
          ppid: process.ppid,
          lstart,
          identities: [...result.identities],
          roots: [...result.roots],
          records: readdirSync(registryDir).length,
        }));
      `;
      const output = execFileSync(process.execPath, [
        '--input-type=module', '-e', script, pathToFileURL(helperPath).href, join(dir, 'config'), LSTART,
      ], {
        encoding: 'utf8',
        env: { ...process.env, PATH: probeDirectory, PS_LOG: psLog },
        timeout: 30000,
      });
      const calls = existsSync(psLog) ? readFileSync(psLog, 'utf8').trim().split('\n').filter(Boolean) : [];
      return {
        calls,
        ...(JSON.parse(output) as { pid: number; ppid: number; lstart: number; identities: Array<[number, string]>; roots: string[]; records: number }),
      };
    };

    it.each(helperPaths)('resolves every record with one batched ps and tolerates missing pids (%s)', helperPath => {
      // BSD ps prints the live pids; it exits 1 when none of the pids exist and
      // some builds also when only some are gone.
      const result = probe(helperPath, `IFS=,; for id in $2; do [ "$id" = 1 ] || printf '%5s ${LSTART}    \\n' "$id"; done\nexit 1`);

      expect(result.calls).toHaveLength(1);
      const [flag, pidList, outputFlag, format] = result.calls[0].split(' ');
      expect([flag, outputFlag, format]).toEqual(['-p', '-o', 'pid=,lstart=']);
      expect(pidList.split(',').sort()).toEqual([String(result.pid), String(result.ppid), '1'].sort());
      expect(new Map(result.identities)).toEqual(new Map([
        [result.pid, String(result.lstart)],
        [result.ppid, String(result.lstart)],
      ]));
      // A matching identity is kept, a mismatching one is dropped, and a pid
      // ps did not report is kept conservatively.
      expect(result.records).toBe(2);
      expect(result.roots.sort()).toEqual([
        join(dir, 'config', 'plugins', '1'),
        join(dir, 'config', 'plugins', String(result.pid)),
      ].sort());
    });

    it.each(helperPaths)('keeps records when the batched ps fails (%s)', helperPath => {
      const result = probe(helperPath, 'exit 2');

      expect(result.calls).toHaveLength(1);
      expect(result.identities).toEqual([]);
      expect(result.records).toBe(3);
    });

    it('bounds a hanging darwin ps for script and template helpers', () => {
      const probeDirectory = join(dir, 'fake-bin');
      mkdirSync(probeDirectory);
      const ps = join(probeDirectory, 'ps');
      writeFileSync(ps, '#!/bin/sh\nwhile :; do :; done\n');
      chmodSync(ps, 0o755);

      const script = `
        import { createHash } from 'node:crypto';
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const helper = await import(process.argv[1]);
        const configDir = process.argv[2];
        const pluginRoot = process.argv[3];
        const pid = process.pid;
        const processStartIdentity = String(new Date(process.argv[4]).getTime());
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        mkdirSync(registryDir, { recursive: true });
        const name = createHash('sha256').update([pluginRoot, pid, processStartIdentity].join('\\0')).digest('hex');
        writeFileSync(join(registryDir, name + '.json'), JSON.stringify({ version: 1, pid, processStartIdentity, pluginRoot, updatedAt: new Date().toISOString() }));
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        const startedAt = Date.now();
        const result = helper.readOccupiedPluginRoots(configDir, { includePids: [pid], probeTimeoutMs: 75 });
        process.stdout.write(JSON.stringify({ roots: [...result.roots], identityCount: result.identities.size, elapsedMs: Date.now() - startedAt }));
      `;

      for (const [index, helperPath] of helperPaths.entries()) {
        const configDir = join(dir, `config-${index}`);
        const pluginRoot = join(dir, 'plugins', `version-${index}`);
        const output = execFileSync(process.execPath, [
          '--input-type=module', '-e', script, pathToFileURL(helperPath).href, configDir, pluginRoot, LSTART,
        ], {
          encoding: 'utf8',
          env: { ...process.env, PATH: probeDirectory },
          timeout: 5000,
        });
        const result = JSON.parse(output) as { roots: string[]; identityCount: number; elapsedMs: number };
        // A probe that times out proves nothing, so the record is kept.
        expect(result.roots).toEqual([pluginRoot]);
        expect(result.identityCount).toBe(0);
        expect(result.elapsedMs).toBeLessThan(500);
      }
    });
  });
});
