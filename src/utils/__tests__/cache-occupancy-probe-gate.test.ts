import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCacheOccupancy, readOccupiedPluginRoots } from '../cache-occupancy.js';

// The pids the start time of a process was asked for: the program that reads it on macOS (ps) is replaced by one that answers a fixed time and logs the pid.
const asked = vi.hoisted(() => ({ pids: [] as string[] }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: ((command: string, args: string[], ...rest: unknown[]) => {
      if (command === 'ps') {
        asked.pids.push(String(args[1]));
        return 'Tue Jan  6 09:00:00 2026\n';
      }
      return (actual.execFileSync as (...all: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.execFileSync,
  };
});

describe('the start identity probe of the TypeScript reader outside Windows', () => {
  let dir: string;
  const platform = process.platform;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omc-probe-gate-')); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }); rmSync(dir, { recursive: true, force: true }); });

  // A record of another host, or of none (the previous publisher wrote no field), belongs to an owner this machine cannot probe: asking
  // for the start time of its pid costs a process on macOS, and what it answers proves nothing about that owner.
  it('does not ask for the start time of a record of another host or of none, and asks for the one of this place', async () => {
    const root = join(dir, 'local-root');
    mkdirSync(root, { recursive: true });
    expect(await publishCacheOccupancy(root, dir, 'start')).toBe(true);
    const registry = join(dir, '.omc', 'cache-occupancy');
    const file = join(registry, readdirSync(registry)[0]);
    const { host } = JSON.parse(readFileSync(file, 'utf8')) as { host: string };
    rmSync(file);
    // Live processes (this one, its parent, init), so that no record goes for another reason than a probe.
    const write = (letter: string, pid: number, fields: Record<string, unknown>) => {
      writeFileSync(join(registry, `${letter.repeat(64)}.json`), JSON.stringify({ version: 1, pid, processStartIdentity: 'start', pluginRoot: join(dir, `root-${letter}`), updatedAt: new Date().toISOString(), ...fields }));
    };
    write('a', process.pid, { host });
    write('b', process.ppid, { host: 'another-machine|pid:[4026539999]' });
    write('c', 1, {});
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    asked.pids.length = 0;

    const { roots } = readOccupiedPluginRoots(dir);

    expect(asked.pids).toEqual([String(process.pid)]);
    expect([...roots].sort()).toEqual([join(dir, 'root-b'), join(dir, 'root-c')]);
  });
});
