import { existsSync, readdirSync, lstatSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, resolve } from 'path';
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
  if (process.platform === 'linux') { try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const close = stat.lastIndexOf(')'); return close < 0 ? null : (stat.substring(close + 2).split(' ')[19] || null); } catch { return null; } }
  if (process.platform === 'darwin') { try { if (probeTimeoutMs <= 0) return null; const timeout = Math.max(1, Math.min(2000, Math.floor(probeTimeoutMs))); const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout }); const value = new Date(result.stdout?.trim()).getTime(); return result.status === 0 && Number.isFinite(value) ? String(value) : null; } catch { return null; } }
  if (process.platform === 'win32') { try { if (probeTimeoutMs <= 0) return null; const timeout = Math.max(1, Math.min(3000, Math.floor(probeTimeoutMs))); const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout, windowsHide: true }); const ticks = result.stdout?.trim().match(/^\d+$/)?.[0]; return ticks ? `ticks:${ticks}` : null; } catch { return null; } }
  return null;
}
function identities(pids, probeTimeoutMs = 3000) {
  const validPids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (validPids.length === 0 || probeTimeoutMs <= 0) return new Map();
  if (process.platform === 'win32') {
    try {
      const command = `$items=Get-Process -Id ${validPids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,@{Name='StartTicks';Expression={[string]$_.StartTime.ToUniversalTime().Ticks}}; $items | ConvertTo-Json -Compress`;
      const timeout = Math.max(1, Math.min(3000, Math.floor(probeTimeoutMs)));
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout, windowsHide: true });
      if (result.status !== 0) return new Map();
      const parsed = JSON.parse(result.stdout?.trim() || 'null');
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return new Map(items.map(item => [Number(item?.Id), item?.StartTicks]).filter(([pid, ticks]) => validPids.includes(pid) && typeof ticks === 'string' && /^\d+$/.test(ticks)).map(([pid, ticks]) => [pid, `ticks:${ticks}`]));
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
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function registryDir(configDir) { return join(configDir, '.omc', 'cache-occupancy'); }
function fileName(root, pid, start) { return `${createHash('sha256').update(`${root}\0${pid}\0${start}`).digest('hex')}.json`; }

// Issue #3995: on win32 every identity probe is a PowerShell host (~1.6-2.0s),
// so SessionStart must not need two. publishCacheOccupancy() accepts an
// explicit precomputed identity for `pid` (resolved by the caller in the ONE
// batched readOccupiedPluginRoots() host) and skips its own probe entirely;
// readOccupiedPluginRoots() accepts a previously returned identities map to
// verify records without spawning a second host (pids absent from the map are
// kept conservatively — the record survives unless proven stale otherwise).
export function publishCacheOccupancy(pluginRoot, configDir, pid = process.ppid, precomputedIdentity, probeTimeoutMs = 3000) {
  const root = pathIdentity(pluginRoot || ''); const start = typeof precomputedIdentity === 'string' && precomputedIdentity.length > 0 ? precomputedIdentity : precomputedIdentity === null ? null : identity(pid, probeTimeoutMs); if (!root || !start) return false;
  const dir = registryDir(configDir); const target = join(dir, fileName(root, pid, start)); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(temp, JSON.stringify({ version: 1, pid, processStartIdentity: start, pluginRoot: root, updatedAt: new Date().toISOString() }), { mode: 0o600 }); renameSync(temp, target); return true; } catch { try { unlinkSync(temp); } catch {} return false; }
}
export function readOccupiedPluginRoots(configDir, options = {}) {
  const probeBudget = Number.isFinite(options.probeTimeoutMs) ? Math.max(0, options.probeTimeoutMs) : undefined;
  const probeDeadline = probeBudget === undefined ? Infinity : Date.now() + probeBudget;
  const remainingProbeMs = () => probeBudget === undefined ? 3000 : Math.max(0, probeDeadline - Date.now());
  const dir = registryDir(configDir); let names = []; let unavailable = false;
  try { names = readdirSync(dir).filter(name => typeof name === 'string' && NAME.test(name)); } catch (error) { if (error?.code !== 'ENOENT') unavailable = true; }
  const roots = new Set(); const records = [];
  for (const name of names) { const path = join(dir, name); let record; let content;
    let regularFile;
    try { regularFile = lstatSync(path).isFile(); }
    catch (error) {
      if (error?.code !== 'ENOENT') unavailable = true;
      continue;
    }
    if (!regularFile) continue;
    try { content = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') unavailable = true;
      continue;
    }
    try { record = JSON.parse(content); } catch { try { unlinkSync(path); } catch { /* best effort */ } continue; } const age = Date.now() - Date.parse(record?.updatedAt); if (record?.version !== 1 || !Number.isSafeInteger(record?.pid) || !record?.processStartIdentity || !record?.pluginRoot || !Number.isFinite(Date.parse(record?.updatedAt)) || age < -300000 || !alive(record.pid)) { try { unlinkSync(path); } catch {} continue; } records.push({ path, record }); }
  // A precomputed map (same-process reuse, issue #3995) verifies records
  // without a second PowerShell host; the fresh batched probe runs otherwise.
  const currentIdentities = Array.isArray(options.identities)
    ? new Map(options.identities)
    : (options.identities instanceof Map
      ? options.identities
      : identities(
        [...(Array.isArray(options.includePids) ? options.includePids : []), ...records.map(({ record }) => record.pid)],
        remainingProbeMs(),
      ));
  for (const { path, record } of records) { const current = currentIdentities.get(record.pid); if (current && current !== record.processStartIdentity) { try { unlinkSync(path); } catch {} continue; } roots.add(pathIdentity(record.pluginRoot)); }
  return { roots, unavailable, identities: currentIdentities };
}
