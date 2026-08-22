/**
 * PreCompact Checkpoint Restore (issue #3730)
 *
 * The PreCompact hook writes checkpoints under `.omc/state/checkpoints/`
 * (see ./index.ts) but historically nothing read them back: the pre-compact
 * `systemMessage` fired once before compaction and the checkpoint file was
 * write-only. After auto-compact the session continues with a native summary,
 * and OMC-owned state (active mode progress, TODO counts, plan anchors) was
 * gone from context.
 *
 * This module restores the newest matching checkpoint after compaction.
 *
 * Contract:
 * - Restore is bound to the compaction lifecycle: the caller (SessionStart
 *   hook) invokes this only when the session-start source indicates a
 *   post-compaction resume (`source === 'compact'`). It never runs on plain
 *   startup/resume/clear.
 * - Newest-wins: among matching checkpoints the most recent `created_at` wins.
 * - Bounded: checkpoints older than CHECKPOINT_MAX_AGE_MS or larger than
 *   CHECKPOINT_MAX_BYTES are ignored.
 * - Fail-open: any missing/malformed/oversized/stale checkpoint yields
 *   `{ ok: false, reason }` with a useful diagnostic; the caller continues.
 * - No replay: a checkpoint already restored for a session is not injected
 *   again (marker file, session-scoped).
 * - No cross-project leakage: lookup is always scoped to the checkpoint
 *   directory derived from the caller's own directory (getOmcRoot).
 * - No symlink traversal: the canonical OMC root, state directory, checkpoint
 *   directory, and candidate file must remain stable regular paths.
 * - Descriptor-bound reads: checkpoint bytes are read through an O_NOFOLLOW
 *   descriptor and verified with fstat before parsing.
 * - Restore is read-only with respect to the checkpoint file itself; only a
 *   small session-scoped marker records that a restore happened.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, } from 'fs';
import { randomUUID } from 'crypto';
import { basename, isAbsolute, join, relative, sep } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
// ============================================================================
// Constants
// ============================================================================
/** Checkpoints older than this are considered stale and never restored. */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, matches session-end cleanup
/** Checkpoint files larger than this are rejected without parsing. */
export const CHECKPOINT_MAX_BYTES = 256 * 1024;
/** Restore context is capped to keep SessionStart budget intact. */
export const RESTORE_CONTEXT_MAX_CHARS = 1200;
/** Replay markers are tiny, but bound reads before parsing untrusted bytes. */
const RESTORE_MARKER_MAX_BYTES = 16 * 1024;
const RESTORE_LOCK_STALE_MS = 30_000;
const RESTORE_LOCK_RETRY_ATTEMPTS = 100;
const RESTORE_LOCK_RETRY_MS = 10;
/** Only files matching this pattern are checkpoint candidates. */
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;
const RESTORE_MARKER_DIR = 'checkpoints-restored';
/**
 * Mirrors SESSION_ID_REGEX from src/lib/worktree-paths.ts::validateSessionId.
 * The session ID becomes a path segment under the restore-marker directory,
 * so anything outside this allowlist must be rejected before path join.
 */
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
function isValidSessionId(sessionId) {
    return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId);
}
/**
 * Record that a checkpoint was restored for a session.
 * Session-scoped: different sessions may restore the same checkpoint.
 * Never throws — replay protection must not break restore.
 */
export function markCheckpointRestored(directory, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs) {
    if (!isValidSessionId(sessionId)) {
        return 'invalid_session_id'; // never write a marker for an unvalidated session ID
    }
    let parentFd = null;
    let markerFd = null;
    let lockFd = null;
    let lockPath = null;
    let lockIdentity = null;
    let tempPath = null;
    try {
        const omcRoot = getOmcRoot(directory);
        const target = getRestoreMarkerTarget(omcRoot, sessionId, true);
        if (!target) {
            return 'unsupported';
        }
        // A directory descriptor binds creation to the already-validated marker
        // parent. Without O_DIRECTORY + O_NOFOLLOW + /proc/self/fd there is no
        // portable way to prevent an ancestor replacement from redirecting an
        // exclusive create, so fail closed rather than writing externally.
        parentFd = openBoundedDirectory(target.parent);
        if (parentFd === null) {
            return process.platform === 'win32' ? 'unsupported' : 'failed';
        }
        const create = constants.O_CREAT;
        const exclusive = constants.O_EXCL;
        const writeOnly = constants.O_WRONLY;
        if (typeof create !== 'number' ||
            typeof exclusive !== 'number' ||
            typeof writeOnly !== 'number') {
            return 'unsupported';
        }
        const noFollow = constants.O_NOFOLLOW;
        const flags = create |
            exclusive |
            writeOnly |
            (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0);
        const markerPath = descriptorChildPath(parentFd, basename(target.path));
        if (markerPath === null) {
            return 'unsupported';
        }
        tempPath = descriptorChildPath(parentFd, `.${basename(target.path)}.${randomUUID()}.tmp`);
        if (tempPath === null) {
            return 'unsupported';
        }
        markerFd = openSync(tempPath, flags, 0o600);
        const before = fstatSync(markerFd);
        const openedPath = realpathSync(tempPath);
        if (!before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1 ||
            before.size !== 0 ||
            !isPathWithin(target.context.omcRoot.path, openedPath) ||
            !isStableRestoreMarkerTarget(target, parentFd)) {
            return 'failed';
        }
        const bytes = Buffer.from(JSON.stringify({
            restored_at: new Date().toISOString(),
            checkpoint: checkpointPath,
            checkpoint_created_at: Number.isFinite(Date.parse(checkpointCreatedAt ?? ''))
                ? checkpointCreatedAt
                : null,
            checkpoint_mtime_ms: Number.isFinite(checkpointMtimeMs) ? checkpointMtimeMs : null,
        }), 'utf-8');
        let offset = 0;
        while (offset < bytes.length) {
            const count = writeSync(markerFd, bytes, offset, bytes.length - offset);
            if (!Number.isInteger(count) || count <= 0) {
                return 'failed';
            }
            offset += count;
        }
        fsyncSync(markerFd);
        const after = fstatSync(markerFd);
        const afterPath = realpathSync(tempPath);
        if (!after.isFile() ||
            after.isSymbolicLink() ||
            after.nlink !== 1 ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== bytes.length ||
            afterPath !== openedPath ||
            !isStableRestoreMarkerTarget(target, parentFd)) {
            return 'failed';
        }
        closeSync(markerFd);
        markerFd = null;
        lockPath = descriptorChildPath(parentFd, `.${basename(target.path)}.lock`);
        if (lockPath === null)
            return 'unsupported';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                lockFd = openSync(lockPath, flags, 0o600);
                const lockStat = fstatSync(lockFd);
                if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1)
                    return 'failed';
                lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
                break;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    return 'failed';
                let stale;
                try {
                    stale = lstatSync(lockPath);
                }
                catch {
                    continue;
                }
                if (attempt === 0 &&
                    stale.isFile() &&
                    !stale.isSymbolicLink() &&
                    stale.nlink === 1 &&
                    Date.now() - stale.mtimeMs > RESTORE_LOCK_STALE_MS &&
                    isStableRestoreMarkerTarget(target, parentFd)) {
                    if (reclaimStaleLock(lockPath, stale, parentFd))
                        continue;
                }
                return 'contended';
            }
        }
        if (lockFd === null || lockIdentity === null)
            return 'failed';
        const ownsLock = () => {
            try {
                const current = lstatSync(lockPath);
                return current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
                    current.dev === lockIdentity.dev && current.ino === lockIdentity.ino &&
                    isStableRestoreMarkerTarget(target, parentFd);
            }
            catch {
                return false;
            }
        };
        // Publish the complete marker atomically. link+unlink gives the initial
        // publication O_EXCL semantics without exposing a partially written final
        // path; an existing validated regular marker is replaced with rename.
        let existing = null;
        try {
            existing = lstatSync(markerPath);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return 'failed';
        }
        if (!existing) {
            if (!ownsLock())
                return 'failed';
            try {
                linkSync(tempPath, markerPath);
                unlinkSync(tempPath);
                tempPath = null;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    return 'failed';
                existing = lstatSync(markerPath);
            }
        }
        if (existing) {
            // Never read through or overwrite a symlink, hard link, or other
            // untrusted marker entry. Keep the historical `existing` status so the
            // caller will withhold restore text unless an exact marker is proven.
            if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
                return 'existing';
            }
            const existingPath = realpathSync(markerPath);
            if (existingPath !== target.path ||
                !isPathWithin(target.context.omcRoot.path, existingPath) ||
                !isStableRestoreMarkerTarget(target, parentFd)) {
                return 'existing';
            }
            const raw = readBoundedFile(markerPath, { path: existingPath, dev: existing.dev, ino: existing.ino }, RESTORE_MARKER_MAX_BYTES);
            if (raw !== null) {
                try {
                    const marker = JSON.parse(raw);
                    if (marker?.checkpoint === checkpointPath)
                        return 'existing';
                    const existingTime = Date.parse(marker?.checkpoint_created_at ?? '');
                    const candidateTime = Date.parse(checkpointCreatedAt ?? '');
                    if (Number.isFinite(existingTime) && Number.isFinite(candidateTime)) {
                        if (existingTime > candidateTime)
                            return 'existing';
                        if (existingTime === candidateTime) {
                            const recordedMtime = Number(marker?.checkpoint_mtime_ms);
                            const existingMtime = Number.isFinite(recordedMtime)
                                ? recordedMtime
                                : legacyCheckpointMtime(directory, marker?.checkpoint, sessionId);
                            if (Number.isFinite(existingMtime) && Number.isFinite(checkpointMtimeMs)) {
                                if (existingMtime > checkpointMtimeMs)
                                    return 'existing';
                                if (existingMtime === checkpointMtimeMs) {
                                    const existingName = typeof marker?.checkpoint === 'string' ? basename(marker.checkpoint) : '';
                                    if (!CHECKPOINT_FILE_PATTERN.test(existingName) || compareCheckpointNames(existingName, basename(checkpointPath)) >= 0)
                                        return 'existing';
                                }
                            }
                            else if (!Number.isFinite(checkpointMtimeMs)) {
                                const existingName = typeof marker?.checkpoint === 'string' ? basename(marker.checkpoint) : '';
                                if (!CHECKPOINT_FILE_PATTERN.test(existingName) || compareCheckpointNames(existingName, basename(checkpointPath)) >= 0)
                                    return 'existing';
                            }
                        }
                    }
                    else {
                        const existingName = typeof marker?.checkpoint === 'string' ? basename(marker.checkpoint) : '';
                        const candidateName = basename(checkpointPath);
                        if (!CHECKPOINT_FILE_PATTERN.test(existingName) || compareCheckpointNames(existingName, candidateName) >= 0)
                            return 'existing';
                    }
                }
                catch {
                    // Replace malformed marker content with the complete new marker.
                }
            }
            if (!ownsLock())
                return 'failed';
            renameSync(tempPath, markerPath);
            tempPath = null;
        }
        const published = lstatSync(markerPath);
        const publishedPath = realpathSync(markerPath);
        if (!published.isFile() ||
            published.isSymbolicLink() ||
            published.nlink !== 1 ||
            published.dev !== before.dev ||
            published.ino !== before.ino ||
            published.size !== bytes.length ||
            publishedPath !== target.path ||
            !isStableRestoreMarkerTarget(target, parentFd)) {
            return 'failed';
        }
        return 'written';
    }
    catch (error) {
        // Marker publication is advisory, but must never follow an untrusted
        // parent or expose a partially written final path. Restore itself remains
        // fail-open.
        return error.code === 'EEXIST' ? 'existing' : 'failed';
    }
    finally {
        if (markerFd !== null) {
            try {
                closeSync(markerFd);
            }
            catch {
                // Ignore close failures; marker publication has already failed.
            }
        }
        if (lockFd !== null) {
            try {
                closeSync(lockFd);
            }
            catch {
                // Ignore close failures; ownership is checked before cleanup.
            }
        }
        if (lockPath !== null && lockIdentity !== null) {
            try {
                const current = lstatSync(lockPath);
                if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino)
                    unlinkSync(lockPath);
            }
            catch {
                // Ignore cleanup failures; stale locks are reclaimed after the bound.
            }
        }
        if (tempPath !== null) {
            try {
                unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup failures; marker publication has already failed.
            }
        }
        if (parentFd !== null) {
            try {
                closeSync(parentFd);
            }
            catch {
                // Ignore close failures; marker publication has already failed.
            }
        }
    }
}
function isCheckpointRestored(directory, sessionId, checkpointPath) {
    try {
        if (!isValidSessionId(sessionId)) {
            return false;
        }
        const omcRoot = getOmcRoot(directory);
        const target = getRestoreMarkerTarget(omcRoot, sessionId, false);
        if (!target) {
            return false;
        }
        const stat = lstatSync(target.path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return false;
        }
        const markerPath = realpathSync(target.path);
        if (markerPath !== target.path ||
            !isPathWithin(target.context.omcRoot.path, markerPath)) {
            // The final identity check is performed by readBoundedFile; this early
            // containment check rejects a symlink/reparse marker before any parse.
            return false;
        }
        const raw = readBoundedFile(target.path, { path: markerPath, dev: stat.dev, ino: stat.ino }, RESTORE_MARKER_MAX_BYTES);
        if (raw === null || !isStableRestoreMarkerTarget(target)) {
            return false;
        }
        const marker = JSON.parse(raw);
        return marker?.checkpoint === checkpointPath;
    }
    catch {
        return false;
    }
}
// ============================================================================
// Candidate discovery
// ============================================================================
function isPathWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function isPathWithinOrEqual(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function inspectCanonicalDirectory(path) {
    try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return null;
        }
        return { path: realpathSync(path), dev: stat.dev, ino: stat.ino };
    }
    catch {
        return null;
    }
}
function getCanonicalCheckpointContext(omcRoot) {
    const root = inspectCanonicalDirectory(omcRoot);
    const statePath = join(omcRoot, 'state');
    const state = inspectCanonicalDirectory(statePath);
    const checkpointsPath = join(statePath, 'checkpoints');
    const checkpoints = inspectCanonicalDirectory(checkpointsPath);
    if (!root || !state || !checkpoints) {
        return null;
    }
    if (!isPathWithinOrEqual(root.path, state.path) ||
        !isPathWithinOrEqual(root.path, checkpoints.path) ||
        !isPathWithinOrEqual(state.path, checkpoints.path)) {
        return null;
    }
    return { omcRoot: root, state, checkpoints };
}
function isStableCanonicalDirectory(path, expected) {
    try {
        const stat = lstatSync(path);
        return (stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            stat.dev === expected.dev &&
            stat.ino === expected.ino &&
            realpathSync(path) === expected.path);
    }
    catch {
        return false;
    }
}
function isStableCheckpointContext(omcRoot, context) {
    return (isStableCanonicalDirectory(omcRoot, context.omcRoot) &&
        isStableCanonicalDirectory(join(omcRoot, 'state'), context.state) &&
        isStableCanonicalDirectory(join(omcRoot, 'state', 'checkpoints'), context.checkpoints));
}
function canonicalChildDirectory(parent, name, create) {
    const childPath = join(parent.path, name);
    try {
        let stat;
        try {
            stat = lstatSync(childPath);
        }
        catch (error) {
            if (!create || error.code !== 'ENOENT') {
                return null;
            }
            mkdirSync(childPath, { recursive: false, mode: 0o700 });
            stat = lstatSync(childPath);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return null;
        }
        const canonicalPath = realpathSync(childPath);
        if (!isPathWithinOrEqual(parent.path, canonicalPath)) {
            return null;
        }
        const after = lstatSync(childPath);
        if (!after.isDirectory() ||
            after.isSymbolicLink() ||
            after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            realpathSync(childPath) !== canonicalPath) {
            return null;
        }
        return { path: canonicalPath, dev: after.dev, ino: after.ino };
    }
    catch {
        return null;
    }
}
function getRestoreMarkerTarget(omcRoot, sessionId, create) {
    if (!isValidSessionId(sessionId)) {
        return null;
    }
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context)) {
        return null;
    }
    const markerRoot = canonicalChildDirectory(context.state, RESTORE_MARKER_DIR, create);
    if (!markerRoot || !isPathWithin(context.omcRoot.path, markerRoot.path)) {
        return null;
    }
    const parent = canonicalChildDirectory(markerRoot, sessionId, create);
    if (!parent ||
        !isPathWithin(context.omcRoot.path, parent.path) ||
        !isPathWithinOrEqual(context.state.path, parent.path) ||
        !isStableCheckpointContext(omcRoot, context)) {
        return null;
    }
    return { context, markerRoot, parent, path: join(parent.path, 'restored.json') };
}
function isStableRestoreMarkerTarget(target, parentFd) {
    try {
        if (!isStableCheckpointContext(target.context.omcRoot.path, target.context) ||
            !isStableCanonicalDirectory(join(target.context.state.path, RESTORE_MARKER_DIR), target.markerRoot) ||
            !isStableCanonicalDirectory(join(target.context.state.path, RESTORE_MARKER_DIR, basename(target.parent.path)), target.parent)) {
            return false;
        }
        if (parentFd !== undefined) {
            const stat = fstatSync(parentFd);
            if (!stat.isDirectory() ||
                stat.isSymbolicLink() ||
                stat.dev !== target.parent.dev ||
                stat.ino !== target.parent.ino) {
                return false;
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
function openBoundedDirectory(directory) {
    const readOnly = constants.O_RDONLY;
    const directoryFlag = constants.O_DIRECTORY;
    const noFollow = constants.O_NOFOLLOW;
    if (typeof readOnly !== 'number' ||
        typeof directoryFlag !== 'number' ||
        typeof noFollow !== 'number' ||
        noFollow === 0) {
        return null;
    }
    let fd = null;
    try {
        fd = openSync(directory.path, readOnly | directoryFlag | noFollow);
        const stat = fstatSync(fd);
        if (!stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.dev !== directory.dev ||
            stat.ino !== directory.ino ||
            realpathSync(directory.path) !== directory.path) {
            closeSync(fd);
            return null;
        }
        return fd;
    }
    catch {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                // Ignore close failures; the descriptor is unusable.
            }
        }
        return null;
    }
}
function descriptorChildPath(parentFd, name) {
    // Linux and other procfs hosts can bind a child open to the directory
    // descriptor. Native Windows lacks this API; callers fail closed there.
    if (process.platform === 'win32') {
        return null;
    }
    return `/proc/self/fd/${parentFd}/${name}`;
}
function readBoundedFile(path, expected, maxBytes) {
    const noFollow = constants.O_NOFOLLOW;
    const readOnly = constants.O_RDONLY;
    if (typeof readOnly !== 'number') {
        return null;
    }
    let fd = null;
    try {
        // O_NOFOLLOW is unavailable on native Windows. The explicit lstat and
        // realpath checks below provide the same fail-closed identity validation
        // around open/read there instead of disabling valid checkpoint restores.
        const beforePath = lstatSync(path);
        if (!beforePath.isFile() ||
            beforePath.isSymbolicLink() ||
            beforePath.nlink > 1 ||
            beforePath.dev !== expected.dev ||
            beforePath.ino !== expected.ino ||
            realpathSync(path) !== expected.path) {
            return null;
        }
        const flags = typeof noFollow === 'number' && noFollow !== 0 ? readOnly | noFollow : readOnly;
        fd = openSync(path, flags);
        const before = fstatSync(fd);
        if (!before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink > 1 ||
            before.dev !== expected.dev ||
            before.ino !== expected.ino ||
            !Number.isFinite(before.size) ||
            before.size > maxBytes ||
            realpathSync(path) !== expected.path) {
            return null;
        }
        const openedPath = lstatSync(path);
        if (!openedPath.isFile() ||
            openedPath.isSymbolicLink() ||
            openedPath.nlink > 1 ||
            openedPath.dev !== before.dev ||
            openedPath.ino !== before.ino) {
            return null;
        }
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
            const count = readSync(fd, buffer, offset, buffer.length - offset, null);
            if (count === 0) {
                return null;
            }
            offset += count;
        }
        const after = fstatSync(fd);
        const afterPath = lstatSync(path);
        if (!after.isFile() ||
            after.isSymbolicLink() ||
            after.nlink > 1 ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            afterPath.dev !== before.dev ||
            afterPath.ino !== before.ino ||
            afterPath.isSymbolicLink() ||
            afterPath.nlink > 1 ||
            realpathSync(path) !== expected.path) {
            return null;
        }
        const raw = buffer.toString('utf-8');
        return raw.length <= maxBytes ? raw : null;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                // Ignore close failures; the read has already failed open.
            }
        }
    }
}
function readBoundedCheckpoint(path, expected) {
    return readBoundedFile(path, expected, CHECKPOINT_MAX_BYTES);
}
/**
 * Resolve a checkpoint candidate without following a symlinked entry.
 *
 * The candidate is checked before and after realpath resolution so an
 * obvious replacement race fails closed. The resolved path is also checked
 * against the canonical checkpoint directory before any content is read.
 */
function resolveContainedRegularPath(context, omcRoot, candidatePath) {
    try {
        if (!isStableCheckpointContext(omcRoot, context)) {
            return null;
        }
        const before = lstatSync(candidatePath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
            return null;
        }
        const resolvedPath = realpathSync(candidatePath);
        if (!isPathWithin(context.checkpoints.path, resolvedPath)) {
            return null;
        }
        if (!isStableCheckpointContext(omcRoot, context)) {
            return null;
        }
        const after = lstatSync(candidatePath);
        if (!after.isFile() ||
            after.isSymbolicLink() ||
            after.nlink > 1 ||
            after.dev !== before.dev ||
            after.ino !== before.ino) {
            return null;
        }
        const resolvedAgain = realpathSync(candidatePath);
        if (resolvedAgain !== resolvedPath || !isPathWithin(context.checkpoints.path, resolvedAgain)) {
            return null;
        }
        const resolvedStat = lstatSync(resolvedPath);
        if (!resolvedStat.isFile() ||
            resolvedStat.isSymbolicLink() ||
            resolvedStat.nlink > 1 ||
            resolvedStat.dev !== after.dev ||
            resolvedStat.ino !== after.ino) {
            return null;
        }
        return isStableCheckpointContext(omcRoot, context)
            ? { path: resolvedPath, dev: after.dev, ino: after.ino }
            : null;
    }
    catch {
        return null;
    }
}
function listCheckpointCandidates(omcRoot, checkpointDir, context) {
    if (!isStableCheckpointContext(omcRoot, context)) {
        return [];
    }
    let entries;
    try {
        entries = readdirSync(checkpointDir);
    }
    catch {
        return [];
    }
    const candidates = [];
    for (const name of entries) {
        if (!CHECKPOINT_FILE_PATTERN.test(name)) {
            continue;
        }
        const path = join(checkpointDir, name);
        try {
            const resolvedPath = resolveContainedRegularPath(context, omcRoot, path);
            if (!resolvedPath) {
                continue;
            }
            const stat = lstatSync(resolvedPath.path);
            candidates.push({ name, path, mtimeMs: stat.mtimeMs, verified: resolvedPath });
        }
        catch {
            // Unreadable entry — skip it.
        }
    }
    return candidates;
}
function parseCheckpoint(omcRoot, candidate, context) {
    let raw;
    try {
        const checkpointBytes = readBoundedCheckpoint(candidate.path, candidate.verified);
        if (checkpointBytes === null || !isStableCheckpointContext(omcRoot, context)) {
            return null;
        }
        raw = checkpointBytes;
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.created_at !== 'string' || !isValidSessionId(parsed?.session_id ?? '')) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function isWithinAgeBound(createdAt) {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) {
        return false;
    }
    const age = Date.now() - created;
    return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}
function compareCheckpointNames(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function reclaimStaleLock(lockPath, stale, parentFd) {
    const quarantinePath = descriptorChildPath(parentFd, `.${basename(lockPath)}.reclaim-${randomUUID()}`);
    if (quarantinePath === null)
        return false;
    try {
        renameSync(lockPath, quarantinePath);
        const moved = lstatSync(quarantinePath);
        if (moved.dev !== stale.dev || moved.ino !== stale.ino ||
            moved.mtimeMs !== stale.mtimeMs || moved.size !== stale.size) {
            try {
                linkSync(quarantinePath, lockPath);
            }
            catch { /* preserve any newer pathname owner */ }
            unlinkSync(quarantinePath);
            return false;
        }
        unlinkSync(quarantinePath);
        return true;
    }
    catch {
        try {
            unlinkSync(quarantinePath);
        }
        catch { /* ignore */ }
        return false;
    }
}
function legacyCheckpointMtime(directory, checkpointPath, sessionId) {
    try {
        const omcRoot = getOmcRoot(directory);
        const context = getCanonicalCheckpointContext(omcRoot);
        if (!context)
            return null;
        const resolved = resolveContainedRegularPath(context, omcRoot, checkpointPath);
        if (!resolved || !isStableCheckpointContext(omcRoot, context))
            return null;
        const raw = readBoundedCheckpoint(resolved.path, resolved);
        if (raw === null || JSON.parse(raw)?.session_id !== sessionId)
            return null;
        const stat = lstatSync(resolved.path);
        return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? stat.mtimeMs : null;
    }
    catch {
        return null;
    }
}
/**
 * Sort candidates newest-first. The authoritative order key is the
 * checkpoint's `created_at` field (parsed from JSON). File mtime is a
 * tiebreaker only, because files written in quick succession may share
 * the same mtime millisecond.
 */
function sortNewestFirst(candidates) {
    return candidates.sort((a, b) => {
        const ta = Date.parse(a.checkpoint.created_at);
        const tb = Date.parse(b.checkpoint.created_at);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
            return tb - ta;
        }
        if (a.mtimeMs !== b.mtimeMs)
            return b.mtimeMs - a.mtimeMs;
        return compareCheckpointNames(b.name, a.name);
    });
}
/**
 * Find the newest checkpoint eligible for restore in this directory/session.
 *
 * Returns `ok: false` with a reason on every failure mode; never throws.
 */
export function findLatestCheckpointForRestore(directory, sessionId) {
    // Session ID becomes a path segment in the replay-marker directory. Reject
    // anything the canonical session-ID contract rejects so a malicious ID
    // cannot traverse out of .omc/state/checkpoints-restored/.
    if (!isValidSessionId(sessionId)) {
        return { ok: false, reason: 'invalid_session_id' };
    }
    const omcRoot = getOmcRoot(directory);
    const checkpointDir = join(omcRoot, 'state', 'checkpoints');
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context) {
        return { ok: false, reason: 'missing' };
    }
    const raw = listCheckpointCandidates(omcRoot, checkpointDir, context);
    if (raw.length === 0) {
        return { ok: false, reason: 'no_checkpoints' };
    }
    // Parse every candidate; keep parseable ones. Malformed candidates are
    // dropped rather than failing the whole restore — the newest *parseable*
    // checkpoint is the restore target.
    const scored = [];
    let newestUnparseable = null;
    for (const c of raw) {
        const checkpoint = parseCheckpoint(omcRoot, c, context);
        if (checkpoint?.session_id === sessionId) {
            scored.push({ name: c.name, path: c.path, mtimeMs: c.mtimeMs, checkpoint });
        }
        else if (!newestUnparseable || c.mtimeMs > newestUnparseable.mtimeMs) {
            newestUnparseable = c;
        }
    }
    if (scored.length === 0) {
        const c = newestUnparseable;
        return {
            ok: false,
            reason: 'malformed',
            path: c?.path,
            detail: c ? `could not parse ${c.name} (or it exceeds ${CHECKPOINT_MAX_BYTES} bytes)` : undefined,
        };
    }
    sortNewestFirst(scored);
    // Walk newest-to-oldest. The session marker is a monotonic checkpoint
    // cursor: once the newest candidate matches it, older checkpoints must not
    // replay. A newer candidate can still advance the marker atomically.
    //
    // Age and malformed candidates are graded failure modes that report the
    // relevant checkpoint path so callers get actionable diagnostics.
    const newestOverall = scored[0];
    for (const candidate of scored) {
        if (sessionId && isCheckpointRestored(directory, sessionId, candidate.path)) {
            return {
                ok: false,
                reason: 'already_restored',
                path: candidate.path,
                detail: `newest eligible checkpoint already restored for session ${sessionId}`,
            };
        }
        // First non-restored candidate.
        if (!isWithinAgeBound(candidate.checkpoint.created_at)) {
            return {
                ok: false,
                reason: 'stale',
                path: candidate.path,
                detail: `checkpoint ${candidate.name} older than ${CHECKPOINT_MAX_AGE_MS}ms`,
            };
        }
        return { ok: true, checkpoint: candidate.checkpoint, path: candidate.path, mtimeMs: candidate.mtimeMs };
    }
    // No parseable candidate was eligible for restoration.
    return {
        ok: false,
        reason: 'already_restored',
        path: newestOverall.path,
        detail: `all ${scored.length} checkpoint(s) already restored for session ${sessionId}`,
    };
}
/**
 * Find and render the newest checkpoint only after replay-marker publication
 * succeeds. An existing marker is accepted only when its securely read
 * checkpoint path exactly matches the candidate; unsupported or failed marker
 * publication never exposes checkpoint text to the caller.
 */
export function restorePreCompactCheckpoint(directory, sessionId) {
    try {
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        for (let attempt = 0; attempt < RESTORE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
            const candidate = findLatestCheckpointForRestore(directory, sessionId);
            if (!candidate.ok)
                return null;
            const marker_status = markCheckpointRestored(directory, sessionId, candidate.path, candidate.checkpoint.created_at, candidate.mtimeMs);
            if (marker_status === 'written') {
                return {
                    text: formatCheckpointRestoreContext(candidate.checkpoint, candidate.path),
                    marker_status,
                };
            }
            if (marker_status !== 'contended')
                return null;
            Atomics.wait(waitCell, 0, 0, RESTORE_LOCK_RETRY_MS);
        }
        return null;
    }
    catch {
        return null;
    }
}
// ============================================================================
// Restore context formatting
// ============================================================================
function truncate(text, max) {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}
/**
 * Format a restored checkpoint as bounded, advisory SessionStart context.
 *
 * Mirrors the durable anchors the writer records (modes, TODOs, plan refs) —
 * it does not re-serialize conversation content or native summaries.
 */
export function formatCheckpointRestoreContext(checkpoint, path) {
    const lines = [
        '[PRECOMPACT CHECKPOINT RESTORED]',
        '',
        `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
        'Source: PreCompact checkpoint written before the last compaction.',
    ];
    const modes = checkpoint.active_modes ?? {};
    const modeEntries = Object.entries(modes).filter(([, v]) => v != null);
    if (modeEntries.length > 0) {
        lines.push('', 'Active modes at compaction time:');
        for (const [name, mode] of modeEntries) {
            if ('iteration' in mode && typeof mode.iteration === 'number') {
                lines.push(`- ${name} (iteration ${mode.iteration})`);
            }
            else if ('cycle' in mode && typeof mode.cycle === 'number') {
                lines.push(`- ${name} (cycle ${mode.cycle})`);
            }
            else if ('phase' in mode && typeof mode.phase === 'string') {
                lines.push(`- ${name} (phase ${mode.phase})`);
            }
            else {
                lines.push(`- ${name}`);
            }
        }
    }
    const todos = checkpoint.todo_summary;
    const todoTotal = (todos?.pending ?? 0) + (todos?.in_progress ?? 0) + (todos?.completed ?? 0);
    if (todoTotal > 0) {
        lines.push('', `TODOs at compaction time: ${todos.pending} pending, ${todos.in_progress} in progress, ${todos.completed} completed.`);
    }
    const refs = checkpoint.plan_refs;
    if (refs?.prd) {
        const prd = refs.prd;
        lines.push('', `Active PRD: ${prd.title ?? 'untitled'} (status: ${prd.status ?? 'unknown'}, stories: ${prd.stories_completed ?? 0}/${prd.stories_total ?? 0})`);
        lines.push(`PRD file: ${prd.path}`);
    }
    if (refs?.boulder) {
        const boulder = refs.boulder;
        lines.push('', `Active plan (boulder): ${boulder.plan_name ?? 'unnamed'} — ${boulder.progress?.completed ?? 0}/${boulder.progress?.total ?? 0} steps done.`);
        lines.push(`Plan file: ${boulder.active_plan}`);
    }
    if (checkpoint.wisdom_exported) {
        lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
    }
    lines.push('', 'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.', `Raw checkpoint: ${path}`);
    return truncate(lines.join('\n'), RESTORE_CONTEXT_MAX_CHARS);
}
//# sourceMappingURL=restore.js.map