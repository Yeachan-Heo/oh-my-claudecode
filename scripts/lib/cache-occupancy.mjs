import { existsSync, readdirSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

const NAME = /^[a-f0-9]{64}\.json$/;

/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export function pathIdentity(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function identity(pid) {
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
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
      if (result.status !== 0) return null;
      const value = new Date(result.stdout.trim()).getTime();
      return Number.isFinite(value) ? String(value) : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const ticks = result.stdout?.trim().match(/^\d+$/)?.[0];
      return ticks ? `ticks:${ticks}` : null;
    } catch { return null; }
  }
  return null;
}

function identities(pids) {
  if (process.platform !== 'win32') return new Map();
  const validPids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (validPids.length === 0) return new Map();
  try {
    const filter = validPids.join(',');
    const command = `$items=Get-Process -Id ${filter} -ErrorAction SilentlyContinue | Select-Object Id,@{Name='StartTicks';Expression={[string]$_.StartTime.ToUniversalTime().Ticks}}; $items | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (result.status !== 0) return new Map();
    const parsed = JSON.parse(result.stdout?.trim() || 'null');
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return new Map(items
      .map(item => [Number(item?.Id), item?.StartTicks])
      .filter(([pid, ticks]) => validPids.includes(pid) && typeof ticks === 'string' && /^\d+$/.test(ticks))
      .map(([pid, ticks]) => [pid, `ticks:${ticks}`]));
  } catch { return new Map(); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function registryDir(configDir) { return join(configDir, '.omc', 'cache-occupancy'); }
function fileName(root, pid, start) { return `${createHash('sha256').update(`${root}\0${pid}\0${start}`).digest('hex')}.json`; }

export function publishCacheOccupancy(pluginRoot, configDir, pid = process.ppid) {
  const root = pathIdentity(pluginRoot || '');
  const start = identity(pid);
  if (!root || !start) return false;
  const dir = registryDir(configDir);
  const target = join(dir, fileName(root, pid, start));
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ version: 1, pid, processStartIdentity: start, pluginRoot: root, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch { try { unlinkSync(temp); } catch {} return false; }
}

export function readOccupiedPluginRoots(configDir) {
  const dir = registryDir(configDir);
  let names;
  try { names = readdirSync(dir).filter(name => NAME.test(name)); }
  catch (error) { return { roots: new Set(), unavailable: error?.code !== 'ENOENT' }; }
  const roots = new Set();
  const records = [];
  for (const name of names) {
    const path = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { try { unlinkSync(path); } catch {} continue; }
    const age = Date.now() - Date.parse(record?.updatedAt);
    if (record?.version !== 1 || !Number.isSafeInteger(record?.pid) || !record?.processStartIdentity || !record?.pluginRoot || !Number.isFinite(Date.parse(record?.updatedAt)) || age < -300000 || !alive(record.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    records.push({ path, record });
  }
  const currentIdentities = identities(records.map(({ record }) => record.pid));
  for (const { path, record } of records) {
    const current = process.platform === 'win32' ? currentIdentities.get(record.pid) : identity(record.pid);
    if (current && current !== record.processStartIdentity) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    roots.add(pathIdentity(record.pluginRoot));
  }
  return { roots, unavailable: false };
}
