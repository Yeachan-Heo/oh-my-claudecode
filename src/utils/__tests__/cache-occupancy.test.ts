import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync, symlinkSync, utimesSync } from 'fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { purgeStalePluginCacheVersions } from '../paths.js';
import { processStartIdentities, publishCacheOccupancy, readOccupiedPluginRoots } from '../cache-occupancy.js';

const readFailures = vi.hoisted(() => new Map<string, string>());
const lstatFailures = vi.hoisted(() => new Map<string, string>());
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
        import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const helper = await import(process.argv[1]);
        const configDir = process.argv[2];
        const lstart = new Date(process.argv[3]).getTime();
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        mkdirSync(registryDir, { recursive: true });
        // pid 1 is the "gone" pid: the fake ps never prints it.
        const stored = new Map([[process.pid, String(lstart)], [process.ppid, 'stale-identity'], [1, 'unverifiable-identity']]);
        for (const [pid, processStartIdentity] of stored) {
          const pluginRoot = join(configDir, 'plugins', String(pid));
          const name = createHash('sha256').update([pluginRoot, pid, processStartIdentity].join('\\0')).digest('hex');
          writeFileSync(join(registryDir, name + '.json'), JSON.stringify({ version: 1, pid, processStartIdentity, pluginRoot, updatedAt: new Date().toISOString() }));
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
