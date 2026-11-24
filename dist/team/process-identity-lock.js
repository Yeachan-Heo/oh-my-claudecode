import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentProcessStartIdentity, isProcessIdentityDead, isValidProcessStartIdentity } from './team-owner-epoch.js';
function readLock(path) {
    try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        return record.schema_version === 1 && Number.isSafeInteger(record.pid) && record.pid > 0
            && isValidProcessStartIdentity(record.process_started_at) && typeof record.nonce === 'string' && record.nonce.length > 0
            ? record : null;
    }
    catch {
        return null;
    }
}
/** Atomic hard-link lock with positive-death-only stale owner/reclaimer takeover. */
export async function withProcessIdentityFileLock(lockPath, fn, timeoutMs = 10_000) {
    const reclaimPath = `${lockPath}.reclaim`;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const processStartedAt = currentProcessStartIdentity();
    if (!processStartedAt)
        throw new Error('process_start_identity_unavailable');
    const owner = { schema_version: 1, pid: process.pid,
        process_started_at: processStartedAt, nonce: randomUUID(), created_at: new Date().toISOString() };
    const tempPath = `${lockPath}.${owner.nonce}.tmp`;
    writeFileSync(tempPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flush: true });
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    try {
        while (!acquired) {
            const reclaimer = readLock(reclaimPath);
            if (reclaimer) {
                if (isProcessIdentityDead(reclaimer)) {
                    try {
                        unlinkSync(reclaimPath);
                    }
                    catch { /* another contender reclaimed it */ }
                    continue;
                }
                if (Date.now() >= deadline)
                    throw new Error('process_identity_lock_timeout');
                await new Promise(resolve => setTimeout(resolve, 25));
                continue;
            }
            try {
                linkSync(tempPath, lockPath);
                acquired = true;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                const existing = readLock(lockPath);
                if (existing && isProcessIdentityDead(existing)) {
                    try {
                        linkSync(tempPath, reclaimPath);
                        const current = readLock(lockPath);
                        if (current?.nonce === existing.nonce && isProcessIdentityDead(current))
                            unlinkSync(lockPath);
                        if (readLock(reclaimPath)?.nonce === owner.nonce)
                            unlinkSync(reclaimPath);
                        continue;
                    }
                    catch (reclaimError) {
                        if (reclaimError.code !== 'EEXIST'
                            && reclaimError.code !== 'ENOENT')
                            throw reclaimError;
                    }
                }
                if (Date.now() >= deadline)
                    throw new Error('process_identity_lock_timeout');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        return await fn();
    }
    finally {
        try {
            unlinkSync(tempPath);
        }
        catch { /* temp may already be absent */ }
        if (acquired && readLock(lockPath)?.nonce === owner.nonce) {
            try {
                unlinkSync(lockPath);
            }
            catch { /* lock already released */ }
        }
        if (readLock(reclaimPath)?.nonce === owner.nonce) {
            try {
                unlinkSync(reclaimPath);
            }
            catch { /* reclaim marker already released */ }
        }
    }
}
/** Non-waiting variant for short synchronous projection repairs. */
export function withProcessIdentityFileLockSync(lockPath, fn) {
    const reclaimPath = `${lockPath}.reclaim`;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const processStartedAt = currentProcessStartIdentity();
    if (!processStartedAt)
        throw new Error('process_start_identity_unavailable');
    const owner = { schema_version: 1, pid: process.pid,
        process_started_at: processStartedAt, nonce: randomUUID(), created_at: new Date().toISOString() };
    const tempPath = `${lockPath}.${owner.nonce}.tmp`;
    writeFileSync(tempPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flush: true });
    let acquired = false;
    try {
        for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
            try {
                linkSync(tempPath, lockPath);
                acquired = true;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                const existing = readLock(lockPath);
                if (!existing || !isProcessIdentityDead(existing))
                    throw new Error('process_identity_lock_busy');
                try {
                    linkSync(tempPath, reclaimPath);
                    const current = readLock(lockPath);
                    if (current?.nonce === existing.nonce && isProcessIdentityDead(current))
                        unlinkSync(lockPath);
                    if (readLock(reclaimPath)?.nonce === owner.nonce)
                        unlinkSync(reclaimPath);
                }
                catch (reclaimError) {
                    if (reclaimError.code !== 'EEXIST'
                        && reclaimError.code !== 'ENOENT')
                        throw reclaimError;
                }
            }
        }
        if (!acquired)
            throw new Error('process_identity_lock_busy');
        return fn();
    }
    finally {
        try {
            unlinkSync(tempPath);
        }
        catch { /* temp may already be absent */ }
        if (acquired && readLock(lockPath)?.nonce === owner.nonce) {
            try {
                unlinkSync(lockPath);
            }
            catch { /* lock already released */ }
        }
        if (readLock(reclaimPath)?.nonce === owner.nonce) {
            try {
                unlinkSync(reclaimPath);
            }
            catch { /* reclaim marker already released */ }
        }
    }
}
//# sourceMappingURL=process-identity-lock.js.map