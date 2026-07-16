import { createHash, randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'node:child_process';
import { absPath, TeamPaths } from './state-paths.js';
function canonicalize(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(',')}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}
function digest(value) {
    return createHash('sha256').update(canonicalize(value)).digest('hex');
}
function recordBytes(record) {
    const payloadHash = digest(record);
    return canonicalize({ ...record, payload_hash: payloadHash });
}
function parseRecord(path, expectedEpoch) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1
            || (expectedEpoch !== undefined && parsed.epoch !== expectedEpoch)
            || typeof parsed.nonce !== 'string' || typeof parsed.pid !== 'number'
            || !isValidProcessStartIdentity(parsed.process_started_at) || typeof parsed.payload_hash !== 'string')
            return null;
        const { payload_hash, ...unsigned } = parsed;
        return digest(unsigned) === payload_hash ? parsed : null;
    }
    catch {
        return null;
    }
}
function darwinProcessStartFromKinfo(raw, nowSeconds = Math.floor(Date.now() / 1000)) {
    // `kern.proc.pid` returns `struct kinfo_proc`; its first member is `extern_proc`,
    // whose documented leading union is `timeval p_starttime` on supported 64-bit Darwin.
    if (raw.length < 16)
        return null;
    const seconds = raw.readBigUInt64LE(0);
    const micros = raw.readBigUInt64LE(8);
    if (seconds < 946684800n || seconds > BigInt(nowSeconds + 86400) || micros >= 1000000n)
        return null;
    return `${seconds}:${micros}`;
}
export function processStartIdentityForPlatform(pid, platform = process.platform, exec = execFileSync) {
    if (!Number.isSafeInteger(pid) || pid < 1)
        return null;
    try {
        if (platform === 'linux') {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const close = stat.lastIndexOf(')');
            const fields = stat.slice(close + 2).trim().split(/\s+/);
            const ticks = fields[19];
            return ticks ? `linux:${ticks}` : null;
        }
        if (platform === 'win32') {
            const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
            const ticks = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
            return /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
        }
        if (platform === 'darwin') {
            try {
                const raw = exec('/usr/sbin/sysctl', ['-b', `kern.proc.pid.${pid}`], {
                    encoding: null, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
                });
                const birth = darwinProcessStartFromKinfo(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
                if (birth)
                    return `darwin:${birth}`;
            }
            catch {
                // Fall through to the portable process listing when the native kinfo layout is unavailable.
            }
            const started = exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
                encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
            }).trim();
            const startedAtMs = Date.parse(started);
            return started && Number.isFinite(startedAtMs) ? `darwin:${Math.floor(startedAtMs / 1000)}:0` : null;
        }
        const started = exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return started ? `${platform}:${started}` : null;
    }
    catch {
        return null;
    }
}
export function isValidProcessStartIdentity(value, platform = process.platform) {
    if (typeof value !== 'string' || value.length > 1024)
        return false;
    if (platform === 'linux')
        return /^linux:[1-9]\d*$/.test(value);
    if (platform === 'win32')
        return /^win32:[1-9]\d*$/.test(value);
    if (platform === 'darwin') {
        const match = /^darwin:([1-9]\d*):(\d+)$/.exec(value);
        return match !== null && Number(match[2]) < 1_000_000;
    }
    const separator = value.indexOf(':');
    return separator > 0 && value.slice(0, separator) === platform
        && value.slice(separator + 1).length > 0 && !/[\u0000-\u001f\u007f]/.test(value.slice(separator + 1));
}
export function currentProcessStartIdentity(pid = process.pid) {
    return processStartIdentityForPlatform(pid);
}
function processStartIdentitiesMayMatch(recorded, observed) {
    if (recorded === observed)
        return true;
    const recordedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(recorded);
    const observedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(observed);
    return recordedDarwin !== null && observedDarwin !== null
        && recordedDarwin[1] === observedDarwin[1]
        && (recordedDarwin[2] === '0' || observedDarwin[2] === '0');
}
export function isProcessIdentityDead(record) {
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !isValidProcessStartIdentity(record.process_started_at))
        return false;
    try {
        process.kill(record.pid, 0);
    }
    catch (error) {
        return error.code === 'ESRCH';
    }
    const observed = currentProcessStartIdentity(record.pid);
    // Unknown or malformed identity is never positive proof of death.
    return isValidProcessStartIdentity(observed) && !processStartIdentitiesMayMatch(record.process_started_at, observed);
}
export function readLatestOwnerEpoch(cwd, teamName) {
    const directory = absPath(cwd, TeamPaths.ownerEpochs(teamName));
    if (!existsSync(directory))
        return null;
    const epochs = readdirSync(directory)
        .map((name) => /^([1-9]\d*)\.json$/.exec(name))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]))
        .sort((a, b) => b - a);
    const latestEpoch = epochs[0];
    if (latestEpoch === undefined)
        return null;
    const record = parseRecord(join(directory, `${latestEpoch}.json`), latestEpoch);
    if (!record)
        throw new Error('invalid_owner_epoch_record');
    return record;
}
/** Publish a complete, canonical epoch through a hard link. Epoch files are never reclaimed. */
export function publishOwnerEpoch(cwd, teamName, epoch, input = {}) {
    if (!Number.isSafeInteger(epoch) || epoch < 1)
        throw new Error('invalid_owner_epoch');
    const target = absPath(cwd, TeamPaths.ownerEpoch(teamName, epoch));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const start = input.processStartedAt ?? currentProcessStartIdentity(input.pid ?? process.pid);
    if (!isValidProcessStartIdentity(start))
        throw new Error('process_start_identity_unavailable');
    const unsigned = {
        schema_version: 1,
        epoch,
        nonce: input.nonce ?? randomUUID(),
        pid: input.pid ?? process.pid,
        process_started_at: start,
        created_at: new Date().toISOString(),
        ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
    };
    const bytes = recordBytes(unsigned);
    const record = JSON.parse(bytes);
    const temp = join(dirname(target), `.${epoch}.${record.nonce}.${randomUUID()}.tmp`);
    writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });
    try {
        linkSync(temp, target);
    }
    catch (error) {
        const existing = parseRecord(target, epoch);
        try {
            unlinkSync(temp);
        }
        catch { /* unique losing temp cleanup is best-effort */ }
        // A competing successor won this epoch. Returning its verified record makes the loser
        // observe the fence it does not hold rather than attempting deletion or reclamation.
        if (existing)
            return existing;
        throw error;
    }
    const verified = parseRecord(target, epoch);
    if (!verified || canonicalize(verified) !== bytes)
        throw new Error('owner_epoch_publication_verification_failed');
    // Verification precedes unlinking only the successful temporary alias.
    unlinkSync(temp);
    return verified;
}
export function requireOwnerProcessIdentity(record, pid = process.pid, processStartedAt = currentProcessStartIdentity(pid)) {
    if (!processStartedAt || record.pid !== pid || record.process_started_at !== processStartedAt) {
        throw new Error('runtime_owner_fence_lost');
    }
    return record;
}
export function acquireSuccessorOwnerEpoch(cwd, teamName, input = {}) {
    const latest = readLatestOwnerEpoch(cwd, teamName);
    if (latest && !isProcessIdentityDead(latest))
        throw new Error('runtime_owner_not_confirmed_dead');
    return publishOwnerEpoch(cwd, teamName, (latest?.epoch ?? 0) + 1, input);
}
export function checkOwnerFence(cwd, teamName, fence) {
    let latest;
    try {
        latest = readLatestOwnerEpoch(cwd, teamName);
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!latest)
        return { ok: false, reason: 'missing' };
    if (latest.epoch !== fence.epoch)
        return { ok: false, reason: 'superseded' };
    if (latest.nonce !== fence.nonce)
        return { ok: false, reason: 'mismatch' };
    return { ok: true, record: latest };
}
export function requireOwnerFence(cwd, teamName, fence) {
    const result = checkOwnerFence(cwd, teamName, fence);
    if (!result.ok)
        throw new Error('runtime_owner_fence_lost');
    return result.record;
}
export function isFreshRecoveryElection(config, fence, expectedRevision) {
    return config.state_revision === expectedRevision
        && config.lifecycle_state === 'active'
        && config.runtime_owner_epoch?.epoch === fence.epoch
        && config.runtime_owner_epoch.nonce === fence.nonce
        && !config.active_recovery;
}
export function isSameAttemptSuccessorRebind(config, prior, successor, requestId, recoveryId) {
    const active = config.active_recovery;
    return successor.epoch === prior.epoch + 1
        && isProcessIdentityDead(prior)
        && !!active
        && active.request_id === requestId
        && active.recovery_id === recoveryId
        && active.owner_epoch === prior.epoch
        && active.owner_nonce === prior.nonce;
}
export function isActiveRecoveryEffect(config, fence, requestId, recoveryId) {
    const active = config.active_recovery;
    return config.runtime_owner_epoch?.epoch === fence.epoch
        && config.runtime_owner_epoch.nonce === fence.nonce
        && active?.request_id === requestId
        && active.recovery_id === recoveryId
        && active.owner_epoch === fence.epoch
        && active.owner_nonce === fence.nonce;
}
export function isFencedServiceMaintenance(config, fence) {
    const marker = config.service_recovery;
    return !config.active_recovery
        && config.runtime_owner_epoch?.epoch === fence.epoch
        && config.runtime_owner_epoch.nonce === fence.nonce
        && marker?.epoch === fence.epoch
        && marker.nonce === fence.nonce;
}
//# sourceMappingURL=team-owner-epoch.js.map