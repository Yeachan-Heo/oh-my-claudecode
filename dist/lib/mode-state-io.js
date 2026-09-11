/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { getOmcRoot, probeGitTopLevel, resolveStatePath, resolveSessionStatePath, ensureSessionStateDir, ensureOmcDir, listSessionIds, } from './worktree-paths.js';
import { getProcessStartIdentitySync } from '../platform/process-utils.js';
import { atomicWriteJsonSync } from './atomic-write.js';
const localLocks = new Map();
// The current process's own start identity is immutable for the process
// lifetime once successfully captured. acquireLockAt spawns a real
// subprocess (ps on Darwin, powershell on Windows) to compute it; caching
// a successful result avoids paying that subprocess cost on every single
// lock acquisition. A transient probe failure (subprocess timeout/spawn
// hiccup under load) is deliberately NOT cached, so the next call retries
// the real probe instead of permanently fail-closing every subsequent
// lock acquisition for the rest of the process lifetime.
let ownProcessStartIdentityCache = null;
function ownProcessStartIdentity() {
    if (ownProcessStartIdentityCache === null) {
        ownProcessStartIdentityCache = getProcessStartIdentitySync(process.pid);
    }
    return ownProcessStartIdentityCache;
}
function sqliteConstructor() {
    return Database;
}
function mutationDbPath(lockPath) {
    let current = dirname(lockPath);
    while (basename(current) !== 'state') {
        const parent = dirname(current);
        if (parent === current)
            return join(dirname(lockPath), '.state-mutation-locks.db');
        current = parent;
    }
    return join(current, '.state-mutation-locks.db');
}
function ownerFromRow(row) {
    if (!row || row.version !== 1 || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.process_start !== 'string' || typeof row.created_at !== 'string' || typeof row.nonce !== 'string')
        return null;
    return { version: 1, pid: row.pid, processStart: row.process_start, createdAt: row.created_at, nonce: row.nonce };
}
function writeAllSync(fd, content, label) {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0)
            throw new Error(`${label} made no progress`);
        offset += written;
    }
    if (fstatSync(fd).size !== bytes.length)
        throw new Error(`${label} size verification failed`);
}
function readLockOwner(path) {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        const pid = value.pid;
        if (value.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.processStart !== 'string' || !/^\S+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce))
            return null;
        return value;
    }
    catch (error) {
        return error.code === 'ENOENT' ? 'absent' : null;
    }
}
function sameOwner(left, right) {
    return left !== null && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}
function ownerLive(owner) {
    if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(owner.pid))
        return null;
    const current = processStartIdentity(owner.pid);
    if (current === null)
        return null;
    return current === 'absent' ? false : current === owner.processStart;
}
function publishLockOwner(path, owner) {
    const tempPath = `${path}.${owner.pid}.${owner.nonce}.tmp`;
    let fd;
    try {
        fd = openSync(tempPath, 'wx', 0o600);
        writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        linkSync(tempPath, path);
        unlinkSync(tempPath);
        return true;
    }
    catch {
        try {
            if (fd !== undefined)
                closeSync(fd);
        }
        catch { /* best effort */ }
        try {
            unlinkSync(tempPath);
        }
        catch { /* best effort */ }
        return false;
    }
}
function openMutationDb(lockPath) {
    const Database = sqliteConstructor();
    if (!Database)
        return null;
    let db = null;
    try {
        const dbPath = mutationDbPath(lockPath);
        for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
            try {
                const stat = statSync(sidecar);
                if (!stat.isFile() || stat.nlink !== 1) {
                    if (process.env.OMC_LOCK_DEBUG)
                        console.error(`[lock-debug] openMutationDb sidecar-reject ${sidecar} isFile=${stat.isFile()} nlink=${stat.nlink}`);
                    return null;
                }
            }
            catch (error) {
                if (error.code !== 'ENOENT') {
                    if (process.env.OMC_LOCK_DEBUG)
                        console.error(`[lock-debug] openMutationDb sidecar-stat-error ${sidecar} ${error.code}`);
                    return null;
                }
            }
        }
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 2000');
        db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
        return db;
    }
    catch (error) {
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] openMutationDb open/exec failed for ${lockPath}: ${error?.message}`);
        try {
            db?.close();
        }
        catch { /* best effort */ }
        return null;
    }
}
function acquireLockAt(path, attempts = 50) {
    mkdirSync(dirname(path), { recursive: true });
    const key = (() => { try {
        return resolve(realpathSync(dirname(path)), basename(path));
    }
    catch {
        return resolve(path);
    } })();
    const held = localLocks.get(key);
    if (held && !('unlocked' in held)) {
        held.depth += 1;
        return held;
    }
    const db = openMutationDb(path);
    if (!db) {
        // Transient: sidecar validation can observe a mid-write WAL/SHM state
        // from a concurrent owner. Retry with the same backoff as contention,
        // rather than failing closed on a race that isn't a real integrity issue.
        if (attempts <= 1)
            return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return acquireLockAt(path, attempts - 1);
    }
    const processStart = ownProcessStartIdentity();
    if (!processStart) {
        try {
            db.close();
        }
        catch { /* best effort */ }
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] acquireLockAt processStart-null ${path}`);
        // Transient: the identity probe (spawnSync ps/powershell) can time out
        // under CI/system load without the process itself being unavailable.
        // Retry within budget instead of failing closed on the first probe miss.
        if (attempts <= 1)
            return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return acquireLockAt(path, attempts - 1);
    }
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    try {
        db.exec('BEGIN IMMEDIATE');
        const rawRow = db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(key);
        if (rawRow) {
            const row = ownerFromRow(rawRow);
            if (!row) {
                db.exec('ROLLBACK');
                db.close();
                if (process.env.OMC_LOCK_DEBUG)
                    console.error(`[lock-debug] acquireLockAt row-invalid ${path}`);
                return null;
            }
            const live = ownerLive(row);
            if (live === null || live) {
                db.exec('ROLLBACK');
                db.close();
                if (process.env.OMC_LOCK_DEBUG)
                    console.error(`[lock-debug] acquireLockAt row-live=${live} ${path}`);
                if (live === null || attempts <= 1)
                    return null;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                return acquireLockAt(path, attempts - 1);
            }
            db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(key);
        }
        const artifact = readLockOwner(path);
        if (artifact !== 'absent') {
            if (!artifact) {
                db.exec('ROLLBACK');
                db.close();
                console.error(`[omc-lock] state_mutation_lock_unverifiable: ${path}`);
                return null;
            }
            const live = ownerLive(artifact);
            if (live === null || live) {
                db.exec('ROLLBACK');
                db.close();
                if (process.env.OMC_LOCK_DEBUG)
                    console.error(`[lock-debug] acquireLockAt artifact-live=${live} ${path}`);
                if (live === null || attempts <= 1)
                    return null;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                return acquireLockAt(path, attempts - 1);
            }
            try {
                unlinkSync(path);
            }
            catch (error) {
                db.exec('ROLLBACK');
                db.close();
                if (process.env.OMC_LOCK_DEBUG)
                    console.error(`[lock-debug] acquireLockAt artifact-unlink-failed ${path} ${error.code}`);
                return null;
            }
        }
        db.prepare('INSERT INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, 1, ?, ?, ?, ?)').run(key, owner.pid, owner.processStart, owner.createdAt, owner.nonce);
        if (!publishLockOwner(path, owner)) {
            db.exec('ROLLBACK');
            db.close();
            if (process.env.OMC_LOCK_DEBUG)
                console.error(`[lock-debug] acquireLockAt publish-failed ${path}`);
            // The lock artifact may have been (re)written by a concurrent owner
            // between our absent/dead check and this publish (e.g. linkSync sees
            // EEXIST). This is contention, not corruption; retry within budget
            // instead of failing closed on the first race.
            if (attempts <= 1)
                return null;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            return acquireLockAt(path, attempts - 1);
        }
        db.exec('COMMIT');
        const lock = { db, key, path, owner, depth: 1 };
        localLocks.set(key, lock);
        return lock;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* best effort */ }
        try {
            db.close();
        }
        catch { /* best effort */ }
        // SQLITE_BUSY/SQLITE_LOCKED are transient contention from a concurrent
        // owner mid-transaction, not an integrity failure; retry within budget
        // the same way row/artifact contention does. Any other error still
        // fails closed immediately.
        const code = error?.code;
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] acquireLockAt caught-error ${path} code=${code} msg=${error?.message}`);
        if ((code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') && attempts > 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            return acquireLockAt(path, attempts - 1);
        }
        return null;
    }
}
function acquireMutationLock(filePath) {
    return acquireLockAt(`${filePath}.mutation.lock`);
}
function releaseMutationLock(lock) {
    if (!lock || 'unlocked' in lock)
        return;
    if (lock.depth > 1) {
        lock.depth -= 1;
        return;
    }
    localLocks.delete(lock.key);
    try {
        lock.db.exec('BEGIN IMMEDIATE');
        const row = ownerFromRow(lock.db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(lock.key));
        const artifact = readLockOwner(lock.path);
        if (!sameOwner(row, lock.owner) || !sameOwner(artifact === 'absent' ? null : artifact, lock.owner)) {
            lock.db.exec('ROLLBACK');
            return;
        }
        unlinkSync(lock.path);
        lock.db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(lock.key);
        lock.db.exec('COMMIT');
    }
    catch {
        try {
            lock.db.exec('ROLLBACK');
        }
        catch { /* best effort */ }
    }
    finally {
        try {
            lock.db.close();
        }
        catch { /* best effort */ }
    }
}
/** Executes a read or mutation against a state file under its mutation lock. */
export function withStateFileMutationLock(filePath, callback, requireExclusive = false) {
    void requireExclusive;
    const lock = acquireLockAt(`${filePath}.mutation.lock`);
    if (!lock)
        return { acquired: false, value: undefined };
    try {
        return { acquired: true, value: callback() };
    }
    finally {
        releaseMutationLock(lock);
    }
}
function processStartIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return null;
    if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid))
        return null;
    const identity = getProcessStartIdentitySync(pid);
    if (identity !== null)
        return identity;
    try {
        process.kill(pid, 0);
        return null;
    }
    catch (error) {
        const code = error.code;
        return code === 'ESRCH' ? 'absent' : null;
    }
}
export function writeStateFileLocked(filePath, state) {
    if (!recoverEmergencyStateFile(filePath))
        return false;
    const lock = acquireMutationLock(filePath);
    if (!lock)
        return false;
    try {
        atomicWriteJsonSync(filePath, state);
        return true;
    }
    catch {
        return false;
    }
    finally {
        releaseMutationLock(lock);
    }
}
export function clearStateFileLocked(filePath, expectedGeneration) {
    if (!recoverEmergencyStateFile(filePath))
        return false;
    const lock = acquireMutationLock(filePath);
    if (!lock)
        return false;
    try {
        if (existsSync(filePath)) {
            if (expectedGeneration && !sameStateFileGeneration(filePath, expectedGeneration))
                return false;
            if (expectedGeneration) {
                replaceGenerationForTest(filePath);
                if (!sameStateFileGeneration(filePath, expectedGeneration))
                    return false;
            }
            unlinkSync(filePath);
        }
        return true;
    }
    catch {
        return false;
    }
    finally {
        releaseMutationLock(lock);
    }
}
export function clearStateFileLockedIf(filePath, predicate, recoveryOptions, expectedGeneration) {
    if (!recoverEmergencyStateFile(filePath, recoveryOptions))
        return 'failed';
    if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64) {
        try {
            const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8'));
            atomicWriteJsonSync(filePath, replacement);
        }
        finally {
            delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
            delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
        }
    }
    const lock = acquireMutationLock(filePath);
    if (!lock)
        return 'failed';
    try {
        if (!existsSync(filePath))
            return 'skipped';
        if (expectedGeneration && !sameStateFileGeneration(filePath, expectedGeneration))
            return 'skipped';
        let current;
        try {
            current = JSON.parse(readFileSync(filePath, 'utf8'));
        }
        catch {
            return 'failed';
        }
        if (!predicate(current))
            return 'skipped';
        if (expectedGeneration) {
            replaceGenerationForTest(filePath);
            if (!sameStateFileGeneration(filePath, expectedGeneration))
                return 'skipped';
        }
        unlinkSync(filePath);
        return 'cleared';
    }
    catch {
        return 'failed';
    }
    finally {
        releaseMutationLock(lock);
    }
}
export function writeStateFileLockedIf(filePath, predicate, transform) {
    if (!recoverEmergencyStateFile(filePath))
        return 'failed';
    if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64) {
        try {
            const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64, 'base64').toString('utf8'));
            atomicWriteJsonSync(filePath, replacement);
        }
        finally {
            delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH;
            delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64;
        }
    }
    if (!existsSync(filePath))
        return 'skipped';
    const lock = acquireMutationLock(filePath);
    if (!lock)
        return 'failed';
    try {
        if (!existsSync(filePath))
            return 'skipped';
        let current;
        try {
            current = JSON.parse(readFileSync(filePath, 'utf8'));
        }
        catch {
            return 'failed';
        }
        if (!predicate(current))
            return 'skipped';
        atomicWriteJsonSync(filePath, transform(current));
        return 'written';
    }
    catch {
        return 'failed';
    }
    finally {
        releaseMutationLock(lock);
    }
}
export function writeStateFileLockedCreateIf(filePath, predicate, transform) {
    if (!recoverEmergencyStateFile(filePath)) {
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] CreateIf recoverEmergency failed ${filePath}`);
        return 'failed';
    }
    const lock = acquireMutationLock(filePath);
    if (!lock) {
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] CreateIf acquireMutationLock failed ${filePath}`);
        return 'failed';
    }
    try {
        if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64) {
            try {
                const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64, 'base64').toString('utf8'));
                atomicWriteJsonSync(filePath, replacement);
            }
            finally {
                delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH;
                delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64;
            }
        }
        let current = null;
        if (existsSync(filePath)) {
            try {
                current = JSON.parse(readFileSync(filePath, 'utf8'));
            }
            catch (error) {
                if (process.env.OMC_LOCK_DEBUG)
                    console.error(`[lock-debug] CreateIf JSON-parse-failed ${filePath} ${error?.message}`);
                return 'failed';
            }
        }
        if (!predicate(current))
            return 'skipped';
        atomicWriteJsonSync(filePath, transform(current));
        return 'written';
    }
    catch (error) {
        if (process.env.OMC_LOCK_DEBUG)
            console.error(`[lock-debug] CreateIf caught-error ${filePath} ${error?.message}`);
        return 'failed';
    }
    finally {
        releaseMutationLock(lock);
    }
}
function stateDigest(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
function emergencyJournalPath(filePath) {
    return `${filePath}.emergency-journal.json`;
}
function sessionOwnerFromStatePath(filePath) {
    const match = filePath.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)(?:\/|$)/);
    return match?.[1];
}
function emergencyOwner() {
    const processStart = ownProcessStartIdentity();
    return processStart !== null ? { pid: process.pid, processStart, nonce: randomUUID() } : null;
}
function sameEmergencyOwner(left, right) {
    return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}
/** Unknown process identity is treated as live: stealing a claim is never safe. */
function isEmergencyOwnerLive(owner) {
    const current = processStartIdentity(owner.pid);
    return current === null || (current !== 'absent' && current === owner.processStart);
}
function journalIsOwned(path, transactionId, owner) {
    const current = readEmergencyJournal(path);
    return current !== null && current.transactionId === transactionId && sameEmergencyOwner(current.owner, owner);
}
function writeEmergencyJournal(path, journal, requireOwnership = true) {
    try {
        if (requireOwnership && !journalIsOwned(path, journal.transactionId, journal.owner))
            return false;
        atomicWriteJsonSync(path, journal);
        return !requireOwnership || journalIsOwned(path, journal.transactionId, journal.owner);
    }
    catch {
        return false;
    }
}
function emergencyPublicationTempPath(path) {
    const processStart = ownProcessStartIdentity();
    if (!processStart)
        return null;
    return `${path}.${process.pid}.${processStart}.${randomUUID()}.tmp`;
}
/** Publishes a complete, durable transaction file without exposing a partial final path. */
function publishEmergencyFileExclusive(path, content) {
    const tempPath = emergencyPublicationTempPath(path);
    let fd;
    try {
        if (!tempPath)
            return false;
        mkdirSync(dirname(path), { recursive: true });
        fd = openSync(tempPath, 'wx', 0o600);
        const bytes = Buffer.from(content);
        let offset = 0;
        while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (written <= 0)
                throw new Error('emergency publication made no progress');
            offset += written;
        }
        fsyncSync(fd);
        if (statSync(tempPath).size !== bytes.length)
            throw new Error('emergency publication truncated');
        closeSync(fd);
        fd = undefined;
        linkSync(tempPath, path);
        unlinkSync(tempPath);
        return true;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* best-effort descriptor cleanup */ }
        }
        if (tempPath) {
            const generation = fileIdentity(tempPath);
            try {
                if (generation && sameFile(tempPath, generation))
                    unlinkSync(tempPath);
            }
            catch { /* best-effort unpublished temp cleanup */ }
        }
    }
}
function acquireRecoveryClaim(path, attempts = 50) {
    const processStart = ownProcessStartIdentity();
    if (!processStart) {
        // Transient: the identity probe can fail under the same load that
        // causes SQLite lock contention. Retry within budget rather than
        // failing closed on the first transient probe failure.
        if (attempts <= 1)
            return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return acquireRecoveryClaim(path, attempts - 1);
    }
    const lock = acquireLockAt(`${path}.recovery.guard`, attempts);
    if (!lock || 'unlocked' in lock)
        return null;
    const existing = readRecoveryClaim(path);
    if (existing) {
        const live = ownerLive(existing);
        if (live === null || live) {
            releaseMutationLock(lock);
            return null;
        }
        try {
            unlinkSync(path);
        }
        catch {
            releaseMutationLock(lock);
            return null;
        }
    }
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    if (!publishEmergencyFileExclusive(path, JSON.stringify(owner))) {
        releaseMutationLock(lock);
        return null;
    }
    return owner;
}
function readRecoveryClaim(path) {
    try {
        const owner = JSON.parse(readFileSync(path, 'utf8'));
        return owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && typeof owner.createdAt === 'string' && typeof owner.nonce === 'string' ? owner : null;
    }
    catch {
        return null;
    }
}
function sameRecoveryClaim(left, right) {
    return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}
function releaseRecoveryClaim(path, owner) {
    const guardPath = `${path}.recovery.guard`;
    const key = (() => { try {
        return resolve(realpathSync(dirname(guardPath)), basename(guardPath));
    }
    catch {
        return resolve(guardPath);
    } })();
    const lock = localLocks.get(key);
    if (!lock)
        return;
    try {
        const current = readRecoveryClaim(path);
        if (current && sameRecoveryClaim(current, owner))
            unlinkSync(path);
    }
    catch { /* best-effort exact-owner release */ }
    releaseMutationLock(lock);
}
/** Claims a transaction journal without replacing a concurrent transaction. */
function createEmergencyJournal(path, journal) {
    return publishEmergencyFileExclusive(path, JSON.stringify(journal));
}
function readEmergencyJournal(path) {
    try {
        const journal = JSON.parse(readFileSync(path, 'utf8'));
        if (journal.version !== 1 || typeof journal.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
            !journal.owner || !Number.isInteger(journal.owner.pid) || journal.owner.pid <= 0 || typeof journal.owner.processStart !== 'string' ||
            typeof journal.owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.owner.nonce) ||
            (journal.sessionOwner !== undefined && typeof journal.sessionOwner !== 'string') ||
            (journal.originalDigest !== undefined && (typeof journal.originalDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.originalDigest))) ||
            (journal.intendedDigest !== undefined && (typeof journal.intendedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.intendedDigest))) ||
            (journal.intent !== undefined && journal.intent !== 'clear' && journal.intent !== 'publish') ||
            typeof journal.quarantinePath !== 'string' ||
            (journal.phase !== 'preparing' && journal.phase !== 'prepared' && journal.phase !== 'quarantined' && journal.phase !== 'published'))
            return null;
        const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
        return journal.phase === 'preparing' || complete ? journal : null;
    }
    catch {
        return null;
    }
}
function fileIdentity(path) {
    try {
        const stat = statSync(path);
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function captureStateFile(path) {
    try {
        const before = fileIdentity(path);
        if (!before)
            return null;
        const raw = readFileSync(path, 'utf8');
        const after = fileIdentity(path);
        if (!after || !sameFileIdentity(before, after))
            return null;
        const confirm = readFileSync(path, 'utf8');
        if (confirm !== raw || !sameFile(path, before))
            return null;
        return {
            path,
            generation: { ...before, digest: stateDigest(raw) },
            raw,
        };
    }
    catch {
        return null;
    }
}
/** Capture one exact publication for callers whose state file is not a mode file. */
export function captureStateFileGeneration(path) {
    return captureStateFile(path);
}
function sameStateFileGeneration(path, expected) {
    try {
        const identity = fileIdentity(path);
        if (!identity || identity.dev !== expected.dev || identity.ino !== expected.ino)
            return false;
        return stateDigest(readFileSync(path, 'utf8')) === expected.digest;
    }
    catch {
        return false;
    }
}
/** Deterministic test-only publication at the final generation-clear boundary. */
function replaceGenerationForTest(path) {
    if (process.env.NODE_ENV !== 'test' ||
        process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_PATH !== path ||
        !process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64)
        return;
    try {
        const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8'));
        atomicWriteJsonSync(path, replacement);
    }
    finally {
        delete process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64;
    }
}
function sameFile(path, expected) {
    const actual = fileIdentity(path);
    return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}
function reconcileEmergencyPublicationTemps(filePath, authorizeState) {
    const directory = dirname(filePath);
    const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${base}\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.(\\d+)\\.([0-9a-f-]{36})\\.tmp$`, 'i');
    let names;
    try {
        names = readdirSync(directory);
    }
    catch (error) {
        return error.code === 'ENOENT';
    }
    for (const name of names) {
        const match = pattern.exec(name);
        if (!match)
            continue;
        const path = join(directory, name);
        const currentStart = processStartIdentity(Number(match[2]));
        if (currentStart === null || currentStart === match[3])
            return false;
        const generation = fileIdentity(path);
        try {
            if (!generation)
                return false;
            const raw = readFileSync(path, 'utf8');
            if (authorizeState) {
                if (match[1] === 'journal.json') {
                    const journal = readEmergencyJournal(path);
                    if (!journal || !recoveryGenerationsAuthorized(filePath, journal, authorizeState))
                        return false;
                }
                else if (match[1].startsWith('quarantine.')) {
                    const state = JSON.parse(raw);
                    if (!state || typeof state !== 'object' || Array.isArray(state) || !authorizeState(state))
                        return false;
                }
                else {
                    const claim = readRecoveryClaim(path);
                    if (!claim || claim.pid !== Number(match[2]) || claim.processStart !== match[3] || claim.nonce !== match[4])
                        return false;
                }
            }
            if (!sameFile(path, generation) || stateDigest(readFileSync(path, 'utf8')) !== stateDigest(raw))
                return false;
            unlinkSync(path);
        }
        catch {
            return false;
        }
    }
    return true;
}
/** Captures only the authenticated source generation and never unlinks a replacement. */
function captureAndUnlinkPrimary(filePath, quarantinePath, expectedDigest) {
    try {
        linkSync(filePath, quarantinePath);
        const captured = fileIdentity(quarantinePath);
        if (!captured || stateDigest(readFileSync(quarantinePath, 'utf8')) !== expectedDigest || !sameFile(filePath, captured))
            return false;
        emergencyReplaceAtCaptureBoundary(filePath);
        if (!sameFile(filePath, captured) || stateDigest(readFileSync(filePath, 'utf8')) !== expectedDigest)
            return false;
        unlinkSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function removeOwnedEmergencyArtifacts(journalPath, journal, removeQuarantine) {
    try {
        if (!journalIsOwned(journalPath, journal.transactionId, journal.owner))
            return false;
        if (removeQuarantine) {
            try {
                unlinkSync(journal.quarantinePath);
            }
            catch { /* absent */ }
        }
        try {
            unlinkSync(`${journal.quarantinePath}.payload`);
        }
        catch { /* absent */ }
        if (!journalIsOwned(journalPath, journal.transactionId, journal.owner))
            return false;
        unlinkSync(journalPath);
        return true;
    }
    catch {
        return false;
    }
}
function recoveryGenerationsAuthorized(filePath, journal, authorizeState) {
    if (!authorizeState)
        return true;
    const paths = [
        filePath,
        ...(journal ? [journal.quarantinePath, `${journal.quarantinePath}.payload`] : []),
    ];
    let authenticatedJournalGeneration = journal === null;
    for (const path of paths) {
        if (!existsSync(path))
            continue;
        let raw;
        let state;
        try {
            raw = readFileSync(path, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return false;
            state = parsed;
        }
        catch {
            return false;
        }
        if (!authorizeState(state))
            return false;
        if (journal && (stateDigest(raw) === journal.originalDigest ||
            (journal.intent === 'publish' && stateDigest(raw) === journal.intendedDigest)))
            authenticatedJournalGeneration = true;
    }
    return authenticatedJournalGeneration;
}
/** Shared-home recovery claims contain no project identity, so pre-existing
 * claim publications are never attributable to the caller and must survive. */
function hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim) {
    const directory = dirname(filePath);
    const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tempPattern = new RegExp(`^${base}\\.emergency-recovery\\.claim\\.\\d+\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`, 'i');
    try {
        if (readdirSync(directory).some((name) => tempPattern.test(name)))
            return true;
        const claimPath = `${filePath}.emergency-recovery.claim`;
        if (!existsSync(claimPath))
            return recoveryClaim !== undefined;
        if (!recoveryClaim)
            return true;
        const current = readRecoveryClaim(claimPath);
        return !current || !sameRecoveryClaim(current, recoveryClaim);
    }
    catch {
        return true;
    }
}
function sharedRecoveryArtifactsAuthorized(filePath, authorizeState, recoveryClaim) {
    if (!authorizeState)
        return true;
    if (hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim))
        return false;
    const journalPath = emergencyJournalPath(filePath);
    if (!existsSync(journalPath)) {
        if (!existsSync(filePath))
            return true;
        try {
            const state = JSON.parse(readFileSync(filePath, 'utf8'));
            return state !== null && typeof state === 'object' && !Array.isArray(state) && authorizeState(state);
        }
        catch {
            return false;
        }
    }
    const journal = readEmergencyJournal(journalPath);
    return journal !== null && recoveryGenerationsAuthorized(filePath, journal, authorizeState);
}
function emergencyReplaceAtRecoveryBoundary(filePath) {
    if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64)
        return;
    try {
        const replacements = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64, 'base64').toString('utf8'));
        const directory = dirname(filePath);
        for (const name of readdirSync(directory)) {
            if (name === basename(filePath) || name.startsWith(`${basename(filePath)}.emergency-`))
                unlinkSync(join(directory, name));
        }
        for (const replacement of replacements) {
            if (dirname(replacement.path) !== directory)
                throw new Error('invalid recovery replacement path');
            writeFileSync(replacement.path, replacement.content);
        }
    }
    finally {
        delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64;
    }
}
/** A dead transaction is recovered under a state-scoped, generation-verified exclusive claim. */
export function recoverEmergencyStateFile(filePath, options) {
    const pathSessionId = sessionOwnerFromStatePath(filePath);
    const authorizeState = options?.authorizeState ?? (pathSessionId
        ? (state) => {
            const owner = getStateSessionOwner(state);
            return owner === undefined || owner === pathSessionId;
        }
        : undefined);
    const journalPath = emergencyJournalPath(filePath);
    if (!existsSync(filePath) && !existsSync(journalPath))
        return true;
    // Prefilter before taking a claim so stale shared-home artifacts cannot be
    // reclaimed solely because their process owner is dead. Revalidate while
    // holding our own claim below.
    if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState))
        return false;
    if (!existsSync(journalPath)) {
        if (!authorizeState)
            return reconcileEmergencyPublicationTemps(filePath);
        const claimPath = `${filePath}.emergency-recovery.claim`;
        const claim = acquireRecoveryClaim(claimPath);
        if (!claim)
            return false;
        try {
            if (existsSync(journalPath) || !sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim))
                return false;
            return reconcileEmergencyPublicationTemps(filePath, authorizeState);
        }
        finally {
            releaseRecoveryClaim(claimPath, claim);
        }
    }
    const journal = readEmergencyJournal(journalPath);
    if (!journal) {
        if (authorizeState)
            return false;
        const claimPath = `${filePath}.emergency-recovery.claim`;
        const claim = acquireRecoveryClaim(claimPath);
        if (!claim)
            return false;
        try {
            const generation = fileIdentity(journalPath);
            emergencyReplaceAtRecoveryBoundary(filePath);
            const current = readEmergencyJournal(journalPath);
            if (!recoveryGenerationsAuthorized(filePath, current, authorizeState))
                return true;
            if (!reconcileEmergencyPublicationTemps(filePath, authorizeState))
                return false;
            if (!generation || readEmergencyJournal(journalPath) !== null || !existsSync(filePath) || !sameFile(journalPath, generation))
                return false;
            unlinkSync(journalPath);
            return true;
        }
        catch {
            return false;
        }
        finally {
            releaseRecoveryClaim(claimPath, claim);
        }
    }
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim)
        return false;
    try {
        if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim))
            return false;
        emergencyReplaceAtRecoveryBoundary(filePath);
        const current = readEmergencyJournal(journalPath);
        if (!recoveryGenerationsAuthorized(filePath, current, authorizeState))
            return true;
        if (!reconcileEmergencyPublicationTemps(filePath, authorizeState))
            return false;
        if (!current || current.quarantinePath !== `${filePath}.emergency-quarantine.${current.transactionId}` || isEmergencyOwnerLive(current.owner))
            return false;
        return recoverDeadEmergencyStateFile(filePath, authorizeState);
    }
    finally {
        releaseRecoveryClaim(claimPath, claim);
    }
}
/** Recover a previously interrupted emergency mutation while holding the recovery claim. */
function recoverDeadEmergencyStateFile(filePath, authorizeState) {
    const journalPath = emergencyJournalPath(filePath);
    if (!existsSync(journalPath))
        return true;
    const journal = readEmergencyJournal(journalPath);
    if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}`)
        return false;
    if (isEmergencyOwnerLive(journal.owner))
        return false;
    if (!recoveryGenerationsAuthorized(filePath, journal, authorizeState))
        return true;
    const owned = () => journalIsOwned(journalPath, journal.transactionId, journal.owner);
    if (!owned())
        return false;
    const payloadPath = `${journal.quarantinePath}.payload`;
    const digest = (path) => {
        try {
            return stateDigest(readFileSync(path, 'utf8'));
        }
        catch {
            return null;
        }
    };
    if (journal.phase === 'preparing') {
        const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
        if (!complete) {
            if (existsSync(journal.quarantinePath) || existsSync(payloadPath))
                return false;
            return removeOwnedEmergencyArtifacts(journalPath, journal, false);
        }
        const originalStillPrimary = !existsSync(journal.quarantinePath) && digest(filePath) === journal.originalDigest;
        if (journal.intent === 'publish' && digest(payloadPath) !== journal.intendedDigest) {
            return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
        }
        if (journal.intent === 'clear' && existsSync(payloadPath)) {
            return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
        }
        journal.phase = 'prepared';
        return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
    }
    const originalDigest = journal.originalDigest;
    const intent = journal.intent;
    const intendedDigest = journal.intendedDigest;
    const hasPrimary = existsSync(filePath);
    const hasQuarantine = existsSync(journal.quarantinePath);
    const finalize = () => removeOwnedEmergencyArtifacts(journalPath, journal, hasQuarantine);
    if (hasPrimary && hasQuarantine) {
        if (intent === 'publish' && digest(filePath) === intendedDigest && digest(journal.quarantinePath) === originalDigest)
            return finalize();
        // The primary is an unrelated replacement. It wins; discard only this transaction.
        return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    }
    if (hasPrimary) {
        if (!hasQuarantine && journal.phase === 'prepared' && digest(filePath) === originalDigest) {
            if (intent === 'publish' && digest(payloadPath) !== intendedDigest)
                return false;
            if (!owned())
                return false;
            if (!captureAndUnlinkPrimary(filePath, journal.quarantinePath, originalDigest)) {
                if (owned() && existsSync(filePath) && existsSync(journal.quarantinePath) && digest(filePath) !== originalDigest) {
                    removeOwnedEmergencyArtifacts(journalPath, journal, true);
                }
                return false;
            }
            journal.phase = 'quarantined';
            return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
        }
        return false;
    }
    if (!hasQuarantine) {
        return intent === 'clear' && journal.phase === 'published' && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    if (digest(journal.quarantinePath) !== originalDigest || !owned())
        return false;
    try {
        if (intent === 'clear')
            return removeOwnedEmergencyArtifacts(journalPath, journal, true);
        const payload = readFileSync(payloadPath, 'utf8');
        if (stateDigest(payload) !== intendedDigest || !owned())
            return false;
        linkSync(payloadPath, filePath); // exclusive: never overwrite a replacement
        journal.phase = 'published';
        if (!writeEmergencyJournal(journalPath, journal))
            return false;
        return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    }
    catch {
        return false;
    }
}
function emergencyCrashAt(phase) {
    return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_CRASH_PHASE === phase;
}
/** A writer that cannot capture its authenticated source relinquishes its claim. */
function abandonEmergencyJournal(journalPath, journal) {
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner))
        return;
    journal.owner = { ...journal.owner, pid: 999999999, processStart: 'abandoned' };
    try {
        atomicWriteJsonSync(journalPath, journal);
    }
    catch { /* original claim remains safe */ }
}
/** Test crashes must relinquish ownership; a real crashed process is not live. */
function abandonEmergencyJournalForTest(journalPath, journal) {
    if (!emergencyCrashAt('after-payload') && !emergencyCrashAt('before-rename') && !emergencyCrashAt('after-rename') && !emergencyCrashAt('after-publication') && !emergencyCrashAt('before-cleanup'))
        return;
    abandonEmergencyJournal(journalPath, journal);
}
function emergencyReplaceAfterPredicate(filePath) {
    if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64)
        return;
    try {
        const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64, 'base64').toString('utf8'));
        atomicWriteJsonSync(filePath, replacement);
    }
    finally {
        delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
    }
}
function emergencyReplaceAtCaptureBoundary(filePath) {
    if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64)
        return;
    try {
        const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64, 'base64').toString('utf8'));
        atomicWriteJsonSync(filePath, replacement);
    }
    finally {
        delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64;
    }
}
export function emergencyMutateStateFileIf(filePath, predicate, transform, recoveryOptions) {
    if (!recoverEmergencyStateFile(filePath, recoveryOptions))
        return false;
    const owner = emergencyOwner();
    if (!owner)
        return false;
    const transactionId = randomUUID();
    const quarantinePath = `${filePath}.emergency-quarantine.${transactionId}`;
    const journalPath = emergencyJournalPath(filePath);
    const payloadPath = `${quarantinePath}.payload`;
    let journal = null;
    try {
        journal = { version: 1, transactionId, owner, quarantinePath, phase: 'preparing' };
        if (!createEmergencyJournal(journalPath, journal))
            return false;
        const owns = () => journal !== null && journalIsOwned(journalPath, transactionId, owner);
        if (!existsSync(filePath)) {
            removeOwnedEmergencyArtifacts(journalPath, journal, false);
            return false;
        }
        const originalRaw = readFileSync(filePath, 'utf8');
        const current = JSON.parse(originalRaw);
        if (!predicate(current)) {
            removeOwnedEmergencyArtifacts(journalPath, journal, false);
            return false;
        }
        const transformedRaw = transform ? JSON.stringify(transform(current)) : undefined;
        Object.assign(journal, {
            ...(getStateSessionOwner(current) ? { sessionOwner: getStateSessionOwner(current) } : {}),
            originalDigest: stateDigest(originalRaw),
            ...(transformedRaw === undefined ? { intent: 'clear' } : { intent: 'publish', intendedDigest: stateDigest(transformedRaw) }),
        });
        if (!owns() || !writeEmergencyJournal(journalPath, journal))
            return false;
        if (transformedRaw !== undefined) {
            if (!owns())
                return false;
            if (!publishEmergencyFileExclusive(payloadPath, transformedRaw))
                return false;
            if (!owns())
                return false;
        }
        if (emergencyCrashAt('after-payload')) {
            abandonEmergencyJournalForTest(journalPath, journal);
            return false;
        }
        journal.phase = 'prepared';
        if (!writeEmergencyJournal(journalPath, journal))
            return false;
        const authenticatedRaw = readFileSync(filePath, 'utf8');
        const authenticated = JSON.parse(authenticatedRaw);
        if (!owns() || stateDigest(authenticatedRaw) !== journal.originalDigest || !predicate(authenticated)) {
            removeOwnedEmergencyArtifacts(journalPath, journal, false);
            return false;
        }
        emergencyReplaceAfterPredicate(filePath);
        if (emergencyCrashAt('before-rename')) {
            abandonEmergencyJournalForTest(journalPath, journal);
            return false;
        }
        if (!owns() || !captureAndUnlinkPrimary(filePath, quarantinePath, journal.originalDigest)) {
            removeOwnedEmergencyArtifacts(journalPath, journal, true);
            return false;
        }
        journal.phase = 'quarantined';
        if (!writeEmergencyJournal(journalPath, journal))
            return false;
        if (emergencyCrashAt('after-rename')) {
            abandonEmergencyJournalForTest(journalPath, journal);
            return false;
        }
        if (transformedRaw !== undefined) {
            if (!owns())
                return false;
            linkSync(payloadPath, filePath);
            journal.phase = 'published';
            if (!writeEmergencyJournal(journalPath, journal))
                return false;
            if (emergencyCrashAt('after-publication')) {
                abandonEmergencyJournalForTest(journalPath, journal);
                return false;
            }
        }
        else {
            journal.phase = 'published';
            if (!writeEmergencyJournal(journalPath, journal))
                return false;
        }
        if (emergencyCrashAt('before-cleanup')) {
            abandonEmergencyJournalForTest(journalPath, journal);
            return false;
        }
        return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    }
    catch {
        if (journal)
            abandonEmergencyJournal(journalPath, journal);
        return false;
    }
}
export function getStateSessionOwner(state) {
    if (!state || typeof state !== 'object') {
        return undefined;
    }
    const meta = state._meta;
    if (meta && typeof meta === 'object') {
        const metaSessionId = meta.sessionId;
        if (typeof metaSessionId === 'string' && metaSessionId) {
            return metaSessionId;
        }
    }
    const topLevelSessionId = state.session_id;
    return typeof topLevelSessionId === 'string' && topLevelSessionId
        ? topLevelSessionId
        : undefined;
}
export function canClearStateForSession(state, sessionId) {
    const ownerSessionId = getStateSessionOwner(state);
    return !ownerSessionId || ownerSessionId === sessionId;
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function resolveStateRoot(directory) {
    const baseDir = directory || process.cwd();
    const probe = probeGitTopLevel(baseDir);
    if (probe.status === 'ok')
        return probe.root;
    // Keep the confirmed non-Git directory as the identity input. Converting it
    // to HOME here is unsafe when HOME itself is a Git checkout: a later
    // getOmcRoot() call would reclassify HOME as that repository.
    if (probe.status === 'not_a_repository')
        return baseDir;
    throw new Error('Git probe failed while resolving runtime state root');
}
/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode, directory, sessionId) {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) {
        return resolveSessionStatePath(mode, sessionId, baseDir);
    }
    return resolveStatePath(mode, baseDir);
}
function getLegacyStateCandidates(mode, directory) {
    const baseDir = resolveStateRoot(directory);
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    return [
        resolveStatePath(mode, baseDir),
        join(getOmcRoot(baseDir), `${normalizedName}.json`),
    ];
}
function getRuntimeArtifactCandidates(mode, directory, sessionId) {
    const baseDir = resolveStateRoot(directory);
    const stateRoot = join(getOmcRoot(baseDir), 'state');
    const artifactNames = [
        `${mode}-stop-breaker.json`,
        `${mode}-last-steer-at`,
        `${mode}-continue-steer.lock`,
    ];
    const candidateDirs = new Set([stateRoot]);
    if (sessionId) {
        candidateDirs.add(join(stateRoot, 'sessions', sessionId));
    }
    else {
        for (const sid of listSessionIds(baseDir)) {
            candidateDirs.add(join(stateRoot, 'sessions', sid));
        }
    }
    return [...candidateDirs].flatMap((dir) => artifactNames.map((name) => join(dir, name)));
}
/**
 * Capture every cleanup surface before a terminal request is consumed.
 * Missing/unreadable surfaces are deliberately not synthesized: a later
 * clear can only touch generations that were authenticated at this boundary.
 */
export function captureModeStateCleanup(mode, directory, sessionId) {
    const baseDir = resolveStateRoot(directory);
    const direct = captureStateFile(resolveFile(mode, directory, sessionId));
    const artifacts = getRuntimeArtifactCandidates(mode, baseDir, sessionId)
        .map(captureStateFile)
        .filter((candidate) => candidate !== null);
    const legacy = sessionId
        ? getLegacyStateCandidates(mode, baseDir)
            .map(captureStateFile)
            .filter((candidate) => candidate !== null)
        : [];
    return { direct, artifacts, legacy };
}
function discoverStateFile(path, extra = {}) {
    try {
        const state = JSON.parse(readFileSync(path, 'utf-8'));
        return {
            path,
            snapshot: JSON.stringify(state),
            state,
            ownerSessionId: getStateSessionOwner(state),
            workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
            ...extra,
        };
    }
    catch {
        return null;
    }
}
function hasAuthenticatedCompletionEvidence(path, sessionId) {
    try {
        const evidence = JSON.parse(readFileSync(path, 'utf-8'));
        return evidence.session_id === sessionId
            && typeof evidence.ended_at === 'string'
            && evidence.ended_at.trim().length > 0
            && Number.isFinite(Date.parse(evidence.ended_at));
    }
    catch {
        return false;
    }
}
export function findSessionOwnedStateCandidates(mode, sessionId, directory) {
    const matches = new Map();
    const baseDir = resolveStateRoot(directory);
    const expectedPath = resolveSessionStatePath(mode, sessionId, baseDir);
    const expected = discoverStateFile(expectedPath);
    if (expected && canClearStateForSession(expected.state, sessionId)) {
        matches.set(expectedPath, expected);
    }
    for (const sid of listSessionIds(baseDir)) {
        const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
        const candidate = discoverStateFile(candidatePath);
        if (candidate?.ownerSessionId === sessionId)
            matches.set(candidatePath, candidate);
    }
    return [...matches.values()];
}
export function findSessionOwnedStateFiles(mode, sessionId, directory) {
    return findSessionOwnedStateCandidates(mode, sessionId, directory).map((candidate) => candidate.path);
}
/**
 * Find active session-scoped state files that are safe to treat as orphaned.
 *
 * A fresh `/cancel` invocation may run in a new Claude session id while the
 * state files that keep the Stop hook alive still live under the completed
 * session's directory.  We intentionally require durable completion evidence
 * (`.omc/sessions/{sessionId}.json`) before returning a sibling session's file
 * so active parallel sessions are not cleared just because their ids differ
 * from the caller's fresh cancel session.
 */
export function findCompletedSessionStateCandidates(mode, directory, requesterSessionId) {
    const matches = [];
    const baseDir = resolveStateRoot(directory);
    for (const sid of listSessionIds(baseDir)) {
        if (requesterSessionId && sid === requesterSessionId)
            continue;
        const completionEvidencePath = join(getOmcRoot(baseDir), 'sessions', `${sid}.json`);
        if (!hasAuthenticatedCompletionEvidence(completionEvidencePath, sid))
            continue;
        const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
        const candidate = discoverStateFile(candidatePath, { completedSessionId: sid, completionEvidencePath });
        if (candidate?.state.active === true && candidate.ownerSessionId === sid)
            matches.push(candidate);
    }
    return matches;
}
export function findCompletedSessionStateFiles(mode, directory, requesterSessionId) {
    return findCompletedSessionStateCandidates(mode, directory, requesterSessionId).map((candidate) => candidate.path);
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Write mode state to disk.
 *
 * - Ensures parent directories exist.
 * - Writes with mode 0o600 (owner-only) for security.
 * - Adds `_meta` envelope with write timestamp.
 *
 * @returns true on success, false on failure
 */
export function writeModeState(mode, state, directory, sessionId) {
    try {
        const baseDir = resolveStateRoot(directory);
        if (sessionId) {
            ensureSessionStateDir(sessionId, baseDir);
        }
        else {
            ensureOmcDir('state', baseDir);
        }
        const filePath = resolveFile(mode, directory, sessionId);
        // owner_pid is written at the top level (not only inside _meta) so external
        // hook scripts can perform process-liveness checks without parsing _meta.
        // Existing state shapes carry session_id at top level; owner_pid follows
        // the same convention. Readers that don't know the field ignore it.
        const ownerPid = typeof process.pid === 'number' ? process.pid : undefined;
        const envelope = {
            ...state,
            ...(ownerPid !== undefined && (state.owner_pid === undefined) ? { owner_pid: ownerPid } : {}),
            _meta: {
                written_at: new Date().toISOString(),
                mode,
                ...(sessionId ? { sessionId } : {}),
                ...(ownerPid !== undefined ? { ownerPid } : {}),
            },
        };
        if (sessionId) {
            return writeStateFileLockedCreateIf(filePath, current => current === null || canClearStateForSession(current, sessionId), () => envelope) === 'written';
        }
        return writeStateFileLocked(filePath, envelope);
    }
    catch {
        return false;
    }
}
/** Restore a mode state only when no newer state has been published. */
export function writeModeStateIfAbsent(mode, state, directory, sessionId) {
    try {
        const baseDir = resolveStateRoot(directory);
        if (sessionId)
            ensureSessionStateDir(sessionId, baseDir);
        else
            ensureOmcDir('state', baseDir);
        const result = writeStateFileLockedCreateIf(resolveFile(mode, directory, sessionId), current => current === null, () => state);
        return result === 'written';
    }
    catch {
        return false;
    }
}
/**
 * Read mode state from disk.
 *
 * When sessionId is provided, ONLY reads the session-scoped file (no legacy fallback)
 * to prevent cross-session state leakage.
 *
 * Strips the `_meta` envelope so callers get the original state shape.
 * Handles files written before _meta was introduced (no-op strip).
 *
 * @returns The parsed state (without _meta) or null if not found / unreadable.
 */
export function readModeState(mode, directory, sessionId) {
    const filePath = resolveFile(mode, directory, sessionId);
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (sessionId && parsed && typeof parsed === 'object' && !canClearStateForSession(parsed, sessionId)) {
            return null;
        }
        // Strip _meta envelope if present
        if (parsed && typeof parsed === 'object' && '_meta' in parsed) {
            const { _meta: _, ...rest } = parsed;
            return rest;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
/** Read the persisted state envelope, retaining `_meta` for authorization checks. */
export function readModeStateWithMeta(mode, directory, sessionId) {
    const filePath = resolveFile(mode, directory, sessionId);
    if (!existsSync(filePath))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (sessionId && parsed && typeof parsed === 'object' && !canClearStateForSession(parsed, sessionId)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Clear (delete) a mode state file from disk.
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped file.
 * 2. Ghost-legacy cleanup: also removes the legacy file if it belongs to
 *    this session or has no session_id (orphaned).
 *
 * @returns true on success (or file already absent), false on failure.
 */
export function clearModeStateFile(mode, directory, sessionId, expectedState, cleanupSnapshot) {
    let success = true;
    const baseDir = resolveStateRoot(directory);
    const captured = expectedState
        ? cleanupSnapshot ?? captureModeStateCleanup(mode, baseDir, sessionId)
        : undefined;
    const unlinkIfPresent = (filePath) => {
        if (!clearStateFileLocked(filePath))
            success = false;
    };
    const unlinkCapturedIfPresent = (candidate) => {
        if (!clearStateFileLocked(candidate.path, candidate.generation))
            success = false;
    };
    const markUncapturedPresent = (paths, capturedPaths) => {
        for (const path of paths) {
            if (existsSync(path) && !capturedPaths.has(path))
                success = false;
        }
    };
    if (sessionId) {
        const directPath = resolveFile(mode, directory, sessionId);
        if (expectedState) {
            if (!captured?.direct)
                return false;
            const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
            const result = clearStateFileLockedIf(directPath, (current) => canClearStateForSession(current, sessionId)
                && JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot, undefined, captured.direct.generation);
            if (result === 'failed' || (result === 'skipped' && existsSync(directPath)))
                return false;
            const artifactPaths = getRuntimeArtifactCandidates(mode, baseDir, sessionId);
            const artifactPathsCaptured = new Set(captured.artifacts.map(candidate => candidate.path));
            markUncapturedPresent(artifactPaths, artifactPathsCaptured);
            for (const candidate of captured.artifacts)
                unlinkCapturedIfPresent(candidate);
            const legacyPaths = getLegacyStateCandidates(mode, baseDir);
            const legacyPathsCaptured = new Set(captured.legacy.map(candidate => candidate.path));
            for (const legacyPath of legacyPaths) {
                if (!existsSync(legacyPath) || legacyPathsCaptured.has(legacyPath))
                    continue;
                try {
                    const current = JSON.parse(readFileSync(legacyPath, 'utf8'));
                    if (canClearStateForSession(current, sessionId))
                        success = false;
                }
                catch {
                    // Preserve unreadable/foreign legacy state exactly as the historical
                    // ghost cleanup path does.
                }
            }
            for (const candidate of captured.legacy) {
                try {
                    const observed = JSON.parse(candidate.raw);
                    if (!canClearStateForSession(observed, sessionId))
                        continue;
                    const observedSnapshot = JSON.stringify(observed);
                    const legacyResult = clearStateFileLockedIf(candidate.path, (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot, undefined, candidate.generation);
                    if (legacyResult === 'failed') {
                        success = false;
                    }
                    else if (legacyResult === 'skipped' && existsSync(candidate.path)) {
                        try {
                            const current = JSON.parse(readFileSync(candidate.path, 'utf8'));
                            if (canClearStateForSession(current, sessionId))
                                success = false;
                        }
                        catch {
                            // Preserve unreadable/foreign replacements.
                        }
                    }
                }
                catch {
                    success = false;
                }
            }
        }
        else {
            const directResult = clearStateFileLockedIf(directPath, current => canClearStateForSession(current, sessionId));
            if (directResult === 'failed' || (directResult === 'skipped' && existsSync(directPath)))
                success = false;
            for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir, sessionId)) {
                unlinkIfPresent(artifactPath);
            }
        }
    }
    else if (expectedState) {
        const directPath = resolveFile(mode, directory);
        if (!captured?.direct)
            return false;
        const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
        const result = clearStateFileLockedIf(directPath, (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot, undefined, captured.direct.generation);
        if (result === 'failed' || (result === 'skipped' && existsSync(directPath)))
            return false;
        const artifactPaths = getRuntimeArtifactCandidates(mode, baseDir);
        const artifactPathsCaptured = new Set(captured.artifacts.map(candidate => candidate.path));
        markUncapturedPresent(artifactPaths, artifactPathsCaptured);
        for (const candidate of captured.artifacts)
            unlinkCapturedIfPresent(candidate);
    }
    else {
        for (const legacyPath of getLegacyStateCandidates(mode, baseDir))
            unlinkIfPresent(legacyPath);
        for (const sid of listSessionIds(baseDir))
            unlinkIfPresent(resolveSessionStatePath(mode, sid, baseDir));
        for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir))
            unlinkIfPresent(artifactPath);
    }
    // Ghost-legacy cleanup: if sessionId provided, also check legacy path.
    // Expected-state clears already process only their pre-captured legacy
    // generations above; recapturing here would make a replacement deletable.
    if (sessionId && !expectedState) {
        for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
            if (!existsSync(legacyPath)) {
                continue;
            }
            try {
                const observed = JSON.parse(readFileSync(legacyPath, 'utf-8'));
                if (!canClearStateForSession(observed, sessionId))
                    continue;
                const observedSnapshot = JSON.stringify(observed);
                const result = clearStateFileLockedIf(legacyPath, (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot);
                if (result === 'failed')
                    success = false;
            }
            catch {
                // Can't read/parse — leave it alone.
            }
        }
    }
    return success;
}
//# sourceMappingURL=mode-state-io.js.map