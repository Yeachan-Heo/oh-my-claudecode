import { readdirSync, readFileSync, unlinkSync } from 'fs';
import { mkdir, writeFile, rename, rm } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'path';
import { getClaudeConfigDir } from './config-dir.js';
const REGISTRY_VERSION = 1;
const RECORD_PATTERN = /^[a-f0-9]{64}\.json$/;
/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export function pathIdentity(path) {
    const normalized = resolve(path);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function processStartIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return null;
    if (process.platform === 'linux') {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const closeParen = stat.lastIndexOf(')');
            return closeParen === -1 ? null : stat.substring(closeParen + 2).split(' ')[19] || null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'darwin') {
        try {
            return String(Number(new Date(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()).getTime()));
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'win32') {
        try {
            const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
            const ticks = output.trim().match(/^\d+$/)?.[0];
            return ticks ? `ticks:${ticks}` : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
export function getCacheOccupancyDir(configDir = getClaudeConfigDir()) {
    return join(configDir, '.omc', 'cache-occupancy');
}
function recordName(pluginRoot, pid, identity) {
    return `${createHash('sha256').update(`${pluginRoot}\0${pid}\0${identity}`).digest('hex')}.json`;
}
function recordPath(pluginRoot, pid, identity, configDir) {
    return join(getCacheOccupancyDir(configDir), recordName(pluginRoot, pid, identity));
}
export async function publishCacheOccupancy(pluginRoot, configDir) {
    const normalizedRoot = pathIdentity(pluginRoot);
    const identity = processStartIdentity(process.pid);
    if (!identity)
        return false;
    const record = {
        version: REGISTRY_VERSION,
        pid: process.pid,
        processStartIdentity: identity,
        pluginRoot: normalizedRoot,
        updatedAt: new Date().toISOString(),
    };
    const target = recordPath(normalizedRoot, process.pid, identity, configDir);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await mkdir(getCacheOccupancyDir(configDir), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
        return true;
    }
    catch {
        await rm(temporary, { force: true }).catch(() => { });
        return false;
    }
}
function validRecord(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return record.version === REGISTRY_VERSION && Number.isSafeInteger(record.pid) && typeof record.pid === 'number' && record.pid > 0
        && typeof record.processStartIdentity === 'string' && record.processStartIdentity.length > 0
        && typeof record.pluginRoot === 'string' && record.pluginRoot.length > 0
        && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}
export function readOccupiedPluginRoots(configDir = getClaudeConfigDir()) {
    const directory = getCacheOccupancyDir(configDir);
    let names;
    try {
        names = readdirSync(directory).filter(name => RECORD_PATTERN.test(name));
    }
    catch (error) {
        return { roots: new Set(), unavailable: error.code !== 'ENOENT' };
    }
    const roots = new Set();
    const now = Date.now();
    for (const name of names) {
        const path = join(directory, name);
        let record;
        try {
            record = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            try {
                unlinkSync(path);
            }
            catch { /* best effort */ }
            continue;
        }
        if (!validRecord(record)) {
            try {
                unlinkSync(path);
            }
            catch { /* best effort */ }
            continue;
        }
        const age = now - Date.parse(record.updatedAt);
        if (age < -5 * 60 * 1000) {
            try {
                unlinkSync(path);
            }
            catch { /* best effort */ }
            continue;
        }
        if (!processAlive(record.pid)) {
            try {
                unlinkSync(path);
            }
            catch { /* best effort */ }
            continue;
        }
        const currentIdentity = processStartIdentity(record.pid);
        if (currentIdentity && currentIdentity !== record.processStartIdentity) {
            try {
                unlinkSync(path);
            }
            catch { /* best effort */ }
            continue;
        }
        // A live process whose identity cannot be read (including EPERM) is retained
        // conservatively; only a proven-dead PID or proven mismatch self-invalidates.
        roots.add(pathIdentity(record.pluginRoot));
    }
    return { roots, unavailable: false };
}
//# sourceMappingURL=cache-occupancy.js.map