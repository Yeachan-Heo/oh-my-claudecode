import { existsSync, readdirSync, lstatSync, readFileSync, readlinkSync, unlinkSync } from 'fs';
import { type as osType } from 'os';
import { mkdir, writeFile, rename, rm } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { getClaudeConfigDir } from './config-dir.js';

const REGISTRY_VERSION = 1;
const RECORD_PATTERN = /^[a-f0-9]{64}\.json$/;

// Issue #3995: on win32 every identity probe is a PowerShell host
// (~1.6-2.0s), so same-process startup paths must not need two. Both
// operations accept a precomputed identity / identity map so callers can reuse
// the ONE batched host instead of spawning an extra per-process probe.

/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      return closeParen === -1 ? null : stat.substring(closeParen + 2).split(' ')[19] || null;
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try {
      return String(Number(new Date(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()).getTime()));
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
      const ticks = output.trim().match(/^\d+$/)?.[0];
      return ticks ? `ticks:${ticks}` : null;
    } catch { return null; }
  }
  return null;
}

export function processStartIdentities(pids: number[], exec: typeof execFileSync = execFileSync): Map<number, string> {
  if (process.platform !== 'win32') return new Map();
  const validPids = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (validPids.length === 0) return new Map();
  try {
    const command = `$items=Get-Process -Id ${validPids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,@{Name='StartTicks';Expression={[string]$_.StartTime.ToUniversalTime().Ticks}}; $items | ConvertTo-Json -Compress`;
    const output = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    const parsed: unknown = JSON.parse(output.trim() || 'null');
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return new Map(items
      .map((item) => [Number((item as { Id?: unknown })?.Id), (item as { StartTicks?: unknown })?.StartTicks] as const)
      .flatMap(([pid, ticks]) => validPids.includes(pid) && typeof ticks === 'string' && /^\d+$/.test(ticks)
        ? [[pid, `ticks:${ticks}`] as const]
        : []));
  } catch {
    return new Map();
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Where this process runs: the machine id (Linux: /etc/machine-id, else /var/lib/dbus/machine-id; Windows: MachineGuid, macOS:
// IOPlatformUUID, each read once per process by one subprocess with a short limit; empty where there is none)
// and, on Linux, the PID namespace; the host name is no part of it; the same text as scripts/lib/cache-occupancy.mjs, where the reason is given. A record that names another
// place, or none (a record of the previous publisher), belongs to an owner this machine cannot probe, so a local process probe never proves it gone.
// Where no machine id can be read at all the machine is unknown (empty) and every record is foreign. The hardware addresses of the network interfaces
// are no stand-in: they change when an adapter comes or goes.
function machineId(): string {
  let machine = '';
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { machine = readFileSync(file, 'utf8').trim(); } catch { /* no such file */ }
    if (machine) break;
  }
  return machine || systemMachineId();
}

let systemMachine: string | undefined;
function systemMachineId(): string {
  if (systemMachine !== undefined) return systemMachine;
  systemMachine = '';
  try {
    const kind = osType();
    const windows = kind === 'Windows_NT';
    if (windows || kind === 'Darwin') {
      // Absolute paths: a bare name would also be searched for in the working directory on Windows.
      const command = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe') : '/usr/sbin/ioreg';
      const args = windows ? ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'] : ['-rd1', '-c', 'IOPlatformExpertDevice'];
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1000, windowsHide: true });
      const found = result.status === 0 && (windows ? /MachineGuid\s+REG_SZ\s+(\S+)/ : /"IOPlatformUUID" = "([^"]+)"/).exec(result.stdout ?? '');
      if (found) systemMachine = `${kind}:${found[1]}`;
    }
  } catch { /* no id: the machine is unknown */ }
  return systemMachine;
}

function placeId(): string {
  const machine = machineId();
  let namespace = '';
  try { namespace = readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux, or not readable */ }
  return `${machine}|${namespace}`;
}

function isForeignOwner(record: CacheOccupancyRecord): boolean {
  return typeof record.host !== 'string' || record.host === '' || machineId() === '' || record.host !== placeId();
}

export interface CacheOccupancyRecord {
  version: 1;
  pid: number;
  processStartIdentity: string;
  pluginRoot: string;
  /** Where the owner runs; absent in records made before the field existed (a local record). */
  host?: string;
  updatedAt: string;
}

export function getCacheOccupancyDir(configDir = getClaudeConfigDir()): string {
  return join(configDir, '.omc', 'cache-occupancy');
}

// The place of the owner is part of the name, as in scripts/lib/cache-occupancy.mjs: a record made without it has the older name and is still read.
function recordName(pluginRoot: string, pid: number, identity: string, host: string): string {
  return `${createHash('sha256').update(`${pluginRoot}\0${pid}\0${identity}\0${host}`).digest('hex')}.json`;
}

function recordPath(pluginRoot: string, pid: number, identity: string, host: string, configDir?: string): string {
  return join(getCacheOccupancyDir(configDir), recordName(pluginRoot, pid, identity, host));
}

export async function publishCacheOccupancy(pluginRoot: string, configDir?: string, precomputedIdentity?: string): Promise<boolean> {
  const normalizedRoot = pathIdentity(pluginRoot);
  // Precomputed identity handoff (issue #3995): a caller that already resolved
  // an identity with the same algorithm (the batched readOccupiedPluginRoots()
  // host on win32) passes it here so publish skips the extra per-process
  // PowerShell spawn instead of paying for two hosts on one startup path.
  const identity = precomputedIdentity ?? processStartIdentity(process.pid);
  if (!identity) return false;
  const host = placeId();
  const record: CacheOccupancyRecord = {
    version: REGISTRY_VERSION,
    pid: process.pid,
    processStartIdentity: identity,
    pluginRoot: normalizedRoot,
    host,
    updatedAt: new Date().toISOString(),
  };
  const target = recordPath(normalizedRoot, process.pid, identity, host, configDir);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(getCacheOccupancyDir(configDir), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

function validRecord(value: unknown): value is CacheOccupancyRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CacheOccupancyRecord>;
  return record.version === REGISTRY_VERSION && Number.isSafeInteger(record.pid) && typeof record.pid === 'number' && record.pid > 0
    && typeof record.processStartIdentity === 'string' && record.processStartIdentity.length > 0
    && typeof record.pluginRoot === 'string' && record.pluginRoot.length > 0
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}

export interface ReadOccupiedPluginRootsOptions {
  /** Precomputed pid→identity map (same-process reuse, issue #3995). Records
   *  whose pid is absent from the map are kept conservatively. */
  identities?: Map<number, string>;
  /** Extra pids to resolve in the fresh batched identity probe. */
  includePids?: number[];
}

/**
 * readdir reports ENOENT both for a registry that was never created and for a
 * path that runs through a symlink whose target is gone (for example a volume
 * that is temporarily offline). The first means "no records"; the second hides
 * records that may belong to live sessions. Walk the path with lstat, which does
 * not follow links, and report whether any component is such a dangling link.
 */
function runsThroughDanglingLink(path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink() && !existsSync(current)) return true;
    } catch (error) {
      // A component that is simply absent is fine; anything else is uncertain.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    if (dirname(current) === current) return false;
  }
}

// The plugin root of a record of another host is spelled as that host sees it (a profile can be mounted under another path there); one that
// does not lie in the plugin cache of this configuration directory cannot be matched with a version here, so the registry is reported
// unavailable while such a record exists, as in scripts/lib/cache-occupancy.mjs.
function isUnmappableForeignRoot(record: CacheOccupancyRecord, configDir: string): boolean {
  if (!isForeignOwner(record)) return false;
  // A root that is no absolute path here (another platform's syntax, such as C:\... on POSIX, or a relative one) would be resolved against the working directory, which can lie in the cache.
  if (typeof record.pluginRoot !== 'string' || !isAbsolute(record.pluginRoot)) return true;
  const cache = pathIdentity(join(configDir, 'plugins', 'cache'));
  const root = pathIdentity(record.pluginRoot);
  return root !== cache && !root.startsWith(cache + sep);
}

export function readOccupiedPluginRoots(configDir = getClaudeConfigDir(), options: ReadOccupiedPluginRootsOptions = {}): { roots: Set<string>; unavailable: boolean; identities: Map<number, string> } {
  const directory = getCacheOccupancyDir(configDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter(name => RECORD_PATTERN.test(name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { roots: new Set(), unavailable: code !== 'ENOENT' || runsThroughDanglingLink(directory), identities: new Map() };
  }

  const roots = new Set<string>();
  const records: Array<{ path: string; record: CacheOccupancyRecord }> = [];
  let unavailable = false;
  const now = Date.now();
  for (const name of names) {
    const path = join(directory, name);
    let regularFile: boolean;
    try { regularFile = lstatSync(path).isFile(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true;
      continue;
    }
    if (!regularFile) continue;
    let record: unknown;
    let content: string;
    try { content = readFileSync(path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') unavailable = true;
      continue;
    }
    try { record = JSON.parse(content); } catch { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    if (!validRecord(record)) { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    const age = now - Date.parse(record.updatedAt);
    // The clock of another host is not judged here: a record of another place cannot be told invalid by its date.
    if (age < -5 * 60 * 1000 && !isForeignOwner(record)) { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    if (!isForeignOwner(record) && !processAlive(record.pid)) { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    records.push({ path, record });
  }
  // A precomputed map (same-process reuse, issue #3995) verifies records
  // without a second PowerShell host; the fresh batched probe runs otherwise.
  const currentIdentities = options.identities instanceof Map
    ? options.identities
    : processStartIdentities([...records.filter(({ record }) => !isForeignOwner(record)).map(({ record }) => record.pid), ...(options.includePids ?? [])]);
  for (const { path, record } of records) {
    const currentIdentity = process.platform === 'win32'
      ? currentIdentities.get(record.pid)
      : processStartIdentity(record.pid);
    if (currentIdentity && currentIdentity !== record.processStartIdentity && !isForeignOwner(record)) { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    // A live process whose identity cannot be read (including EPERM) is retained
    // conservatively; only a proven-dead PID or proven mismatch self-invalidates.
    if (isUnmappableForeignRoot(record, configDir)) unavailable = true;
    roots.add(pathIdentity(record.pluginRoot));
  }
  return { roots, unavailable, identities: currentIdentities };
}
