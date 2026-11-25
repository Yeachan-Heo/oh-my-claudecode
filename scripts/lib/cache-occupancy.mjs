import { existsSync, readdirSync, lstatSync, readFileSync, readlinkSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { hostname, type as osType } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

const NAME = /^[a-f0-9]{64}\.json$/;

/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export function pathIdentity(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function identity(pid, probeTimeoutMs = 3000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      return close < 0 ? null : (stat.substring(close + 2).split(' ')[19] || null);
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try {
      if (probeTimeoutMs <= 0) return null;
      const timeout = Math.max(1, Math.min(2000, Math.floor(probeTimeoutMs)));
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout });
      const value = new Date(result.stdout?.trim()).getTime();
      return result.status === 0 && Number.isFinite(value) ? String(value) : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    try {
      if (probeTimeoutMs <= 0) return null;
      const timeout = Math.max(1, Math.min(3000, Math.floor(probeTimeoutMs)));
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout, windowsHide: true });
      const ticks = result.stdout?.trim().match(/^\d+$/)?.[0];
      return ticks ? `ticks:${ticks}` : null;
    } catch { return null; }
  }
  return null;
}

function identities(pids, probeTimeoutMs = 3000) {
  const validPids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (validPids.length === 0 || probeTimeoutMs <= 0) return new Map();
  if (process.platform === 'win32') {
    try {
      const filter = validPids.join(',');
      const command = `$items=Get-Process -Id ${filter} -ErrorAction SilentlyContinue | Select-Object Id,@{Name='StartTicks';Expression={[string]$_.StartTime.ToUniversalTime().Ticks}}; $items | ConvertTo-Json -Compress`;
      const timeout = Math.max(1, Math.min(3000, Math.floor(probeTimeoutMs)));
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout, windowsHide: true });
      if (result.status !== 0) return new Map();
      const parsed = JSON.parse(result.stdout?.trim() || 'null');
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return new Map(items
        .map(item => [Number(item?.Id), item?.StartTicks])
        .filter(([pid, ticks]) => validPids.includes(pid) && typeof ticks === 'string' && /^\d+$/.test(ticks))
        .map(([pid, ticks]) => [pid, `ticks:${ticks}`]));
    } catch { return new Map(); }
  }

  if (process.platform === 'darwin') {
    // One `ps` for every pid instead of one spawn per registry record. ps prints
    // the live pids and exits 1 when none of them exist (some BSD builds also
    // when only some are gone), so a missing pid is simply absent from the map.
    try {
      const timeout = Math.max(1, Math.min(2000, Math.floor(probeTimeoutMs)));
      const result = spawnSync('ps', ['-p', validPids.join(','), '-o', 'pid=,lstart='], { encoding: 'utf8', timeout });
      if (result.error || (result.status !== 0 && result.status !== 1)) return new Map();
      const found = new Map();
      for (const line of (result.stdout ?? '').split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
        const pid = Number(match?.[1]);
        const value = match ? new Date(match[2]).getTime() : NaN;
        if (validPids.includes(pid) && Number.isFinite(value)) found.set(pid, String(value));
      }
      return found;
    } catch { return new Map(); }
  }

  const deadline = Date.now() + probeTimeoutMs;
  const result = new Map();
  for (const pid of validPids) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const start = identity(pid, remaining);
    if (start) result.set(pid, start);
  }
  return result;
}
// Where this process runs: the host name, the machine id (Linux: /etc/machine-id, else /var/lib/dbus/machine-id; Windows: MachineGuid, macOS:
// IOPlatformUUID, each read once per process by one subprocess with a short limit; empty where there is none)
// and, on Linux, the PID namespace. Two machines can report the same host name and the same namespace text, so the machine id tells them
// apart. A profile shared over NFS or mounted into a container holds records of owners that this machine cannot probe, so a record that
// names another place is never judged by a local process probe. A record made before the machine id was added has the other format and
// is taken for another place (kept, never judged by a local probe).
// Where no machine id can be read at all, the machine is unknown (empty) and every record is then foreign, never judged by a local probe (see
// isForeignOwner). The hardware addresses of the network interfaces are no stand-in: they change when an adapter comes or goes.
function machineId() {
  let machine = '';
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { machine = readFileSync(file, 'utf8').trim(); } catch {}
    if (machine) break;
  }
  return machine || systemMachineId();
}
let systemMachine;
function systemMachineId() {
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
  } catch {}
  return systemMachine;
}
function placeId() {
  const machine = machineId();
  let namespace = '';
  try { namespace = readlinkSync('/proc/self/ns/pid'); } catch {}
  return `${hostname()}|${machine}|${namespace}`;
}
// Only a record that names this very place is local. A record without the field (made by the previous publisher, possibly on another machine
// of a shared profile during a rolling update) has an unknown origin and is foreign: never judged by a local probe, never removed as gone.
// When this machine cannot name itself, no record can be compared with it, so every record is foreign.
export function isForeignOwner(record) {
  return typeof record?.host !== 'string' || record.host === '' || machineId() === '' || record.host !== placeId();
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function registryDir(configDir) { return join(configDir, '.omc', 'cache-occupancy'); }
// The place of the owner is part of the name: two owners on a shared profile can have the same root, PID and start identity (a PID of each machine's own table).
// A record made without the place has the older name; readers take every name of this form, so it is still read.
function fileName(root, pid, start, place) { return `${createHash('sha256').update(`${root}\0${pid}\0${start}\0${place}`).digest('hex')}.json`; }

// Issue #3995: on win32 every identity probe is a PowerShell host (~1.6-2.0s),
// so SessionStart must not need two. publishCacheOccupancy() accepts an
// explicit precomputed identity for `pid` (resolved by the caller in the ONE
// batched readOccupiedPluginRoots() host) and skips its own probe entirely;
// readOccupiedPluginRoots() accepts a previously returned identities map to
// verify records without spawning a second host (pids absent from the map are
// kept conservatively — the record survives unless proven stale otherwise).
export function publishCacheOccupancy(pluginRoot, configDir, pid = process.ppid, precomputedIdentity, probeTimeoutMs = 3000) {
  const root = pathIdentity(pluginRoot || '');
  const start = typeof precomputedIdentity === 'string' && precomputedIdentity.length > 0
    ? precomputedIdentity
    : precomputedIdentity === null ? null : identity(pid, probeTimeoutMs);
  if (!root || !start) return false;
  const dir = registryDir(configDir);
  const host = placeId();
  const target = join(dir, fileName(root, pid, start, host));
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ version: 1, pid, processStartIdentity: start, pluginRoot: root, host, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch { try { unlinkSync(temp); } catch {} return false; }
}

// readdir reports ENOENT both for a registry that was never created and for a
// path that runs through a symlink whose target is gone (for example a volume
// that is temporarily offline). The first means "no records"; the second hides
// records that may belong to live sessions. Walk the path with lstat, which does
// not follow links, and report whether any component is such a dangling link.
function runsThroughDanglingLink(path) {
  for (let current = path; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink() && !existsSync(current)) return true;
    } catch (error) {
      // A component that is simply absent is fine; anything else is uncertain.
      if (error?.code !== 'ENOENT') return true;
    }
    if (dirname(current) === current) return false;
  }
}

// The plugin root of a record of another host is spelled as that host sees it, and a profile can be mounted under another path there. One that
// does not lie in the plugin cache of this configuration directory cannot be matched with a version here, so the registry is reported unavailable
// (nothing is cleaned or relinked) while such a record exists, as scripts/omc-doctor.mjs stops the repair commands.
function isUnmappableForeignRoot(record, configDir) {
  if (!isForeignOwner(record)) return false;
  // A root that is no absolute path here (another platform's syntax, such as C:\... on POSIX, or a relative one) would be resolved against the working directory, which can lie in the cache.
  if (typeof record.pluginRoot !== 'string' || !isAbsolute(record.pluginRoot)) return true;
  const cache = pathIdentity(join(configDir, 'plugins', 'cache'));
  const root = pathIdentity(record.pluginRoot);
  return root !== cache && !root.startsWith(cache + sep);
}

export function readOccupiedPluginRoots(configDir, options = {}) {
  const probeBudget = Number.isFinite(options.probeTimeoutMs) ? Math.max(0, options.probeTimeoutMs) : undefined;
  const probeDeadline = probeBudget === undefined ? Infinity : Date.now() + probeBudget;
  const remainingProbeMs = () => probeBudget === undefined ? 3000 : Math.max(0, probeDeadline - Date.now());
  const dir = registryDir(configDir);
  let names = [];
  let unavailable = false;
  try { names = readdirSync(dir).filter(name => typeof name === 'string' && NAME.test(name)); }
  catch (error) { if (error?.code !== 'ENOENT' || runsThroughDanglingLink(dir)) unavailable = true; }
  const roots = new Set();
  const records = [];
  for (const name of names) {
    const path = join(dir, name);
    let regularFile;
    try { regularFile = lstatSync(path).isFile(); }
    catch (error) {
      if (error?.code !== 'ENOENT') unavailable = true;
      continue;
    }
    if (!regularFile) continue;
    let record;
    let content;
    try { content = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') unavailable = true;
      continue;
    }
    try { record = JSON.parse(content); } catch { try { unlinkSync(path); } catch { /* best effort */ } continue; }
    const age = Date.now() - Date.parse(record?.updatedAt);
    if (record?.version !== 1 || !Number.isSafeInteger(record?.pid) || !record?.processStartIdentity || !record?.pluginRoot || !Number.isFinite(Date.parse(record?.updatedAt)) || (age < -300000 && !isForeignOwner(record)) || (!isForeignOwner(record) && !alive(record.pid))) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    records.push({ path, record });
  }
  // A precomputed map (same-process reuse, issue #3995) verifies records
  // without a second PowerShell host; the fresh batched probe runs otherwise.
  const currentIdentities = Array.isArray(options.identities)
    ? new Map(options.identities)
    : (options.identities instanceof Map
      ? options.identities
      : identities(
        [...(Array.isArray(options.includePids) ? options.includePids : []), ...records.filter(({ record }) => !isForeignOwner(record)).map(({ record }) => record.pid)],
        remainingProbeMs(),
      ));
  for (const { path, record } of records) {
    const current = currentIdentities.get(record.pid);
    if (current && current !== record.processStartIdentity && !isForeignOwner(record)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (isUnmappableForeignRoot(record, configDir)) unavailable = true;
    roots.add(pathIdentity(record.pluginRoot));
  }
  return { roots, unavailable, identities: currentIdentities };
}
