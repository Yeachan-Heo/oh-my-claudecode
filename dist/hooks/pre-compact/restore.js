/**
 * Portable PreCompact checkpoint restore and replay fencing (issue #3817).
 *
 * Marker publication is intentionally fail-closed.  The canonical OMC/state
 * ancestry is revalidated around every sensitive operation. Publication uses
 * a deterministic immutable claim created by no-clobber hard-link CAS from a
 * random O_EXCL stage; the retained stage link is the ownership witness, so no
 * raced pathname cleanup is required on Linux, macOS, or Windows.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { getOmcRoot } from '../../lib/worktree-paths.js';
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CHECKPOINT_MAX_BYTES = 256 * 1024;
export const RESTORE_CONTEXT_MAX_CHARS = 1200;
const RESTORE_MARKER_MAX_BYTES = 16 * 1024;
const RESTORE_LOCK_RETRY_ATTEMPTS = 100;
const RESTORE_LOCK_RETRY_MS = 10;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;
const RESTORE_MARKER_DIR = 'checkpoints-restored';
const RESTORE_CLAIM_PATTERN = /^restored-[0-9a-f]{64}\.json$/;
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const WINDOWS_RESERVED_SESSION_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function errorCode(error) {
    return error?.code;
}
function isValidSessionId(sessionId) {
    return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId) &&
        !WINDOWS_RESERVED_SESSION_ID.test(sessionId);
}
function compareCheckpointNames(a, b) {
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function normalizeMtimeMs(value) {
    return Math.trunc(value);
}
function compareCheckpointOrder(a, b) {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    if (aTime !== bTime)
        return aTime - bTime;
    if (a.mtimeMs !== b.mtimeMs)
        return a.mtimeMs - b.mtimeMs;
    const nameOrder = compareCheckpointNames(a.name, b.name);
    if (nameOrder !== 0)
        return nameOrder;
    return compareCheckpointNames(a.contentSha256, b.contentSha256);
}
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
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return null;
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
    if (!root || !state || !checkpoints)
        return null;
    if (!isPathWithinOrEqual(root.path, state.path) ||
        !isPathWithinOrEqual(root.path, checkpoints.path) ||
        !isPathWithinOrEqual(state.path, checkpoints.path))
        return null;
    return { omcRoot: root, state, checkpoints };
}
function isStableCanonicalDirectory(path, expected) {
    try {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink() &&
            stat.dev === expected.dev && stat.ino === expected.ino &&
            realpathSync(path) === expected.path;
    }
    catch {
        return false;
    }
}
function isStableCheckpointContext(omcRoot, context) {
    return isStableCanonicalDirectory(omcRoot, context.omcRoot) &&
        isStableCanonicalDirectory(join(omcRoot, 'state'), context.state) &&
        isStableCanonicalDirectory(join(omcRoot, 'state', 'checkpoints'), context.checkpoints);
}
function canonicalChildDirectory(parent, name) {
    const childPath = join(parent.path, name);
    try {
        const stat = lstatSync(childPath);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return null;
        const canonicalPath = realpathSync(childPath);
        if (!isPathWithinOrEqual(parent.path, canonicalPath))
            return null;
        const after = lstatSync(childPath);
        if (!after.isDirectory() || after.isSymbolicLink() ||
            after.dev !== stat.dev || after.ino !== stat.ino ||
            realpathSync(childPath) !== canonicalPath)
            return null;
        return { path: canonicalPath, dev: after.dev, ino: after.ino };
    }
    catch {
        return null;
    }
}
function getRestoreMarkerTarget(omcRoot, sessionId) {
    if (!isValidSessionId(sessionId))
        return null;
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context))
        return null;
    const markerRoot = canonicalChildDirectory(context.state, RESTORE_MARKER_DIR);
    if (!markerRoot || !isPathWithin(context.omcRoot.path, markerRoot.path))
        return null;
    const parent = canonicalChildDirectory(markerRoot, sessionId);
    if (!parent || !isPathWithin(context.omcRoot.path, parent.path) ||
        !isPathWithinOrEqual(context.state.path, parent.path) ||
        !isStableCheckpointContext(omcRoot, context))
        return null;
    return { context, markerRoot, parent, path: join(parent.path, 'restored.json') };
}
function publisherPath() {
    return fileURLToPath(new URL('../../../scripts/lib/precompact-publisher.mjs', import.meta.url));
}
function publisherExecArgs() {
    const preload = process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT;
    return typeof preload === 'string' && preload.startsWith('file:') ? ['--import', preload] : [];
}
function runPublisher(request, cwd) {
    try {
        const raw = execFileSync(process.execPath, [...publisherExecArgs(), publisherPath()], {
            cwd,
            input: JSON.stringify(request),
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15_000,
        });
        const result = JSON.parse(raw);
        return result && typeof result.status === 'string' ? result : null;
    }
    catch {
        return null;
    }
}
function ensureRestoreMarkerTarget(omcRoot, sessionId) {
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context))
        return false;
    const rootResult = runPublisher({ operation: 'ensure-root', expectedCwd: context.state }, context.state.path);
    if (rootResult?.status !== 'ready')
        return false;
    const markerRoot = canonicalChildDirectory(context.state, RESTORE_MARKER_DIR);
    if (!markerRoot || !isStableCheckpointContext(omcRoot, context))
        return false;
    const sessionResult = runPublisher({ operation: 'ensure-session', sessionId, expectedCwd: markerRoot }, markerRoot.path);
    return sessionResult?.status === 'ready' && !!getRestoreMarkerTarget(omcRoot, sessionId);
}
function isStableRestoreMarkerTarget(target) {
    try {
        return isStableCheckpointContext(target.context.omcRoot.path, target.context) &&
            isStableCanonicalDirectory(join(target.context.state.path, RESTORE_MARKER_DIR), target.markerRoot) &&
            isStableCanonicalDirectory(join(target.context.state.path, RESTORE_MARKER_DIR, basename(target.parent.path)), target.parent);
    }
    catch {
        return false;
    }
}
function readBoundedFile(path, expected, maxBytes, allowHardlinks = false) {
    const readOnly = constants.O_RDONLY;
    if (typeof readOnly !== 'number')
        return null;
    const noFollow = constants.O_NOFOLLOW;
    let fd = null;
    try {
        const beforePath = lstatSync(path);
        if (!beforePath.isFile() || beforePath.isSymbolicLink() || (!allowHardlinks && beforePath.nlink > 1) ||
            beforePath.dev !== expected.dev || beforePath.ino !== expected.ino ||
            realpathSync(path) !== expected.path)
            return null;
        const flags = readOnly | (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0);
        fd = openSync(path, flags);
        const before = fstatSync(fd);
        if (!before.isFile() || before.isSymbolicLink() || (!allowHardlinks && before.nlink > 1) ||
            before.dev !== expected.dev || before.ino !== expected.ino ||
            !Number.isFinite(before.size) || before.size > maxBytes ||
            realpathSync(path) !== expected.path)
            return null;
        const openedPath = lstatSync(path);
        if (!openedPath.isFile() || openedPath.isSymbolicLink() || (!allowHardlinks && openedPath.nlink > 1) ||
            openedPath.dev !== before.dev || openedPath.ino !== before.ino)
            return null;
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
            const count = readSync(fd, buffer, offset, buffer.length - offset, null);
            if (!Number.isInteger(count) || count <= 0)
                return null;
            offset += count;
        }
        const after = fstatSync(fd);
        const afterPath = lstatSync(path);
        if (!after.isFile() || after.isSymbolicLink() || (!allowHardlinks && after.nlink > 1) ||
            after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
            afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
            afterPath.isSymbolicLink() || (!allowHardlinks && afterPath.nlink > 1) || afterPath.size !== before.size ||
            afterPath.mtimeMs !== before.mtimeMs || afterPath.ctimeMs !== before.ctimeMs ||
            realpathSync(path) !== expected.path)
            return null;
        const raw = buffer.toString('utf8');
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
            catch { /* ignore */ }
        }
    }
}
function readBoundedCheckpoint(path, expected) {
    return readBoundedFile(path, expected, CHECKPOINT_MAX_BYTES);
}
function resolveContainedRegularPath(context, omcRoot, candidatePath) {
    try {
        if (!isStableCheckpointContext(omcRoot, context))
            return null;
        const before = lstatSync(candidatePath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1)
            return null;
        const resolvedPath = realpathSync(candidatePath);
        if (!isPathWithin(context.checkpoints.path, resolvedPath))
            return null;
        if (!isStableCheckpointContext(omcRoot, context))
            return null;
        const after = lstatSync(candidatePath);
        if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 ||
            after.dev !== before.dev || after.ino !== before.ino)
            return null;
        const resolvedAgain = realpathSync(candidatePath);
        if (resolvedAgain !== resolvedPath || !isPathWithin(context.checkpoints.path, resolvedAgain))
            return null;
        const resolvedStat = lstatSync(resolvedPath);
        if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink() || resolvedStat.nlink > 1 ||
            resolvedStat.dev !== after.dev || resolvedStat.ino !== after.ino)
            return null;
        return isStableCheckpointContext(omcRoot, context)
            ? { path: resolvedPath, dev: after.dev, ino: after.ino }
            : null;
    }
    catch {
        return null;
    }
}
function checkpointOrderForSession(directory, checkpointPath, sessionId) {
    try {
        const omcRoot = getOmcRoot(directory);
        const context = getCanonicalCheckpointContext(omcRoot);
        if (!context)
            return null;
        const resolved = resolveContainedRegularPath(context, omcRoot, checkpointPath);
        if (!resolved || dirname(resolved.path) !== context.checkpoints.path ||
            !CHECKPOINT_FILE_PATTERN.test(basename(resolved.path)) || !isStableCheckpointContext(omcRoot, context))
            return null;
        const raw = readBoundedCheckpoint(resolved.path, resolved);
        if (raw === null)
            return null;
        const checkpoint = JSON.parse(raw);
        if (checkpoint.session_id !== sessionId || typeof checkpoint.created_at !== 'string' ||
            !Number.isFinite(Date.parse(checkpoint.created_at)))
            return null;
        const activeModes = checkpoint.active_modes;
        if (activeModes !== undefined &&
            (activeModes === null || typeof activeModes !== 'object' || Array.isArray(activeModes) ||
                Object.values(activeModes).some((mode) => mode !== null && (typeof mode !== 'object' || Array.isArray(mode)))))
            return null;
        const stat = lstatSync(resolved.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 ||
            stat.dev !== resolved.dev || stat.ino !== resolved.ino)
            return null;
        return {
            path: resolved.path,
            createdAt: checkpoint.created_at,
            mtimeMs: normalizeMtimeMs(stat.mtimeMs),
            name: basename(resolved.path),
            contentSha256: createHash('sha256').update(raw).digest('hex'),
        };
    }
    catch {
        return null;
    }
}
function markerOrderMatches(marker, order) {
    return !!order && typeof marker?.checkpoint_created_at === 'string' &&
        typeof marker?.checkpoint_mtime_ms === 'number' && typeof marker?.checkpoint_sha256 === 'string' &&
        marker.checkpoint_created_at === order.createdAt &&
        marker.checkpoint_mtime_ms === order.mtimeMs && marker.checkpoint_sha256 === order.contentSha256;
}
function claimNameForMarker(marker) {
    if (!isValidSessionId(marker?.session_id) || typeof marker?.checkpoint !== 'string' ||
        typeof marker?.checkpoint_created_at !== 'string' || typeof marker?.checkpoint_mtime_ms !== 'number' ||
        typeof marker?.checkpoint_sha256 !== 'string' || !Number.isFinite(Date.parse(marker.checkpoint_created_at)) ||
        !Number.isSafeInteger(marker.checkpoint_mtime_ms) || marker.checkpoint_mtime_ms < 0 ||
        !/^[0-9a-f]{64}$/.test(marker.checkpoint_sha256))
        return null;
    const digest = createHash('sha256').update(`${marker.session_id}\0${marker.checkpoint}\0${marker.checkpoint_created_at}\0${marker.checkpoint_mtime_ms}\0${marker.checkpoint_sha256}`).digest('hex');
    return `restored-${digest}.json`;
}
function canonicalMarkerRaw(marker) {
    return JSON.stringify({
        session_id: marker.session_id,
        checkpoint: marker.checkpoint,
        checkpoint_created_at: marker.checkpoint_created_at,
        checkpoint_mtime_ms: marker.checkpoint_mtime_ms,
        checkpoint_sha256: marker.checkpoint_sha256,
        claim_id: marker.claim_id,
    });
}
function markerEntryOrder(directory, target, sessionId, name) {
    try {
        const path = join(target.parent.path, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (name === 'restored.json' && stat.nlink !== 1))
            return null;
        const resolved = realpathSync(path);
        if (resolved !== path || !isPathWithin(target.context.omcRoot.path, resolved))
            return null;
        const raw = readBoundedFile(path, { path: resolved, dev: stat.dev, ino: stat.ino }, RESTORE_MARKER_MAX_BYTES, name !== 'restored.json');
        if (raw === null)
            return null;
        const marker = JSON.parse(raw);
        if (marker?.session_id !== sessionId || typeof marker?.checkpoint !== 'string')
            return null;
        const expectedClaimName = claimNameForMarker(marker);
        if (!expectedClaimName || marker?.claim_id !== expectedClaimName || raw !== canonicalMarkerRaw(marker))
            return null;
        if (name === 'restored.json') {
            const claimPath = join(target.parent.path, marker.claim_id);
            const claimStat = lstatSync(claimPath);
            if (!claimStat.isFile() || claimStat.isSymbolicLink())
                return null;
            const claimResolved = realpathSync(claimPath);
            const claimRaw = readBoundedFile(claimPath, { path: claimResolved, dev: claimStat.dev, ino: claimStat.ino }, RESTORE_MARKER_MAX_BYTES, true);
            if (claimRaw !== raw)
                return null;
        }
        else if (expectedClaimName !== name)
            return null;
        const order = checkpointOrderForSession(directory, marker.checkpoint, sessionId);
        return markerOrderMatches(marker, order) && marker.checkpoint === order?.path
            ? { checkpoint: marker.checkpoint, order: order }
            : null;
    }
    catch {
        return null;
    }
}
function newestSessionMarkerClaim(directory, target, sessionId) {
    let newest = null;
    try {
        if (!isStableRestoreMarkerTarget(target))
            return null;
        const names = readdirSync(target.parent.path).filter((name) => RESTORE_CLAIM_PATTERN.test(name));
        for (const name of names) {
            const entry = markerEntryOrder(directory, target, sessionId, name);
            if (entry && (!newest || compareCheckpointOrder(entry.order, newest.order) > 0))
                newest = entry;
        }
    }
    catch { /* fail closed */ }
    return newest;
}
function isCheckpointRestored(directory, sessionId, checkpointPath) {
    try {
        if (!isValidSessionId(sessionId))
            return false;
        const omcRoot = getOmcRoot(directory);
        const target = getRestoreMarkerTarget(omcRoot, sessionId);
        if (!target)
            return false;
        const newest = newestSessionMarkerClaim(directory, target, sessionId);
        const candidateOrder = checkpointOrderForSession(directory, checkpointPath, sessionId);
        if (newest && candidateOrder && compareCheckpointOrder(newest.order, candidateOrder) >= 0)
            return true;
        return false;
    }
    catch {
        return false;
    }
}
export function markCheckpointRestored(directory, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256) {
    if (!isValidSessionId(sessionId))
        return 'invalid_session_id';
    try {
        const omcRoot = getOmcRoot(directory);
        if (!ensureRestoreMarkerTarget(omcRoot, sessionId))
            return 'unsupported';
        const target = getRestoreMarkerTarget(omcRoot, sessionId);
        if (!target)
            return 'failed';
        const candidateOrder = checkpointOrderForSession(directory, checkpointPath, sessionId);
        if (!candidateOrder)
            return 'failed';
        const canonicalCheckpointPath = candidateOrder.path;
        if (!canonicalCheckpointPath)
            return 'failed';
        if (checkpointCreatedAt !== undefined && candidateOrder.createdAt !== checkpointCreatedAt)
            return 'contended';
        if (checkpointMtimeMs !== undefined && candidateOrder.mtimeMs !== normalizeMtimeMs(checkpointMtimeMs))
            return 'contended';
        if (checkpointSha256 !== undefined && candidateOrder.contentSha256 !== checkpointSha256)
            return 'contended';
        const result = runPublisher({
            operation: 'publish',
            sessionId,
            checkpointPath: canonicalCheckpointPath,
            checkpointCreatedAt: candidateOrder.createdAt,
            checkpointMtimeMs: candidateOrder.mtimeMs,
            checkpointSha256: checkpointSha256 ?? candidateOrder.contentSha256,
            checkpointRoot: target.context.checkpoints,
            expectedCwd: target.parent,
        }, target.parent.path);
        if (!isStableRestoreMarkerTarget(target))
            return 'failed';
        const publishedOrder = checkpointOrderForSession(directory, canonicalCheckpointPath, sessionId);
        if (!publishedOrder || compareCheckpointOrder(candidateOrder, publishedOrder) !== 0)
            return 'contended';
        if (result?.status === 'written') {
            const claimName = claimNameForMarker({
                session_id: sessionId,
                checkpoint: canonicalCheckpointPath,
                checkpoint_created_at: candidateOrder.createdAt,
                checkpoint_mtime_ms: candidateOrder.mtimeMs,
                checkpoint_sha256: candidateOrder.contentSha256,
            });
            if (!claimName || !markerEntryOrder(directory, target, sessionId, claimName))
                return 'failed';
        }
        if (result?.status === 'existing') {
            const newest = newestSessionMarkerClaim(directory, target, sessionId);
            if (!newest || compareCheckpointOrder(newest.order, candidateOrder) < 0)
                return 'failed';
        }
        return result?.status === 'written' || result?.status === 'existing' || result?.status === 'contended'
            ? result.status
            : 'failed';
    }
    catch (error) {
        return errorCode(error) === 'EEXIST' ? 'existing' : 'failed';
    }
}
function parseCheckpoint(omcRoot, candidate, context) {
    try {
        const raw = readBoundedCheckpoint(candidate.path, candidate.verified);
        if (raw === null || !isStableCheckpointContext(omcRoot, context))
            return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at)) || !isValidSessionId(parsed?.session_id))
            return null;
        if (parsed.active_modes !== undefined &&
            (parsed.active_modes === null || typeof parsed.active_modes !== 'object' || Array.isArray(parsed.active_modes) ||
                Object.values(parsed.active_modes).some((mode) => mode !== null && (typeof mode !== 'object' || Array.isArray(mode)))))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function isWithinAgeBound(createdAt) {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created))
        return false;
    const age = Date.now() - created;
    return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}
function listCheckpointCandidates(omcRoot, checkpointDir, context) {
    if (!isStableCheckpointContext(omcRoot, context))
        return [];
    let entries;
    try {
        entries = readdirSync(checkpointDir);
    }
    catch {
        return [];
    }
    const candidates = [];
    for (const name of entries) {
        if (!CHECKPOINT_FILE_PATTERN.test(name))
            continue;
        const path = join(checkpointDir, name);
        try {
            const verified = resolveContainedRegularPath(context, omcRoot, path);
            if (!verified)
                continue;
            const stat = lstatSync(verified.path);
            candidates.push({ name, path, mtimeMs: normalizeMtimeMs(stat.mtimeMs), verified });
        }
        catch { /* skip unreadable */ }
    }
    return candidates;
}
function sortNewestFirst(candidates) {
    return candidates.sort((a, b) => -compareCheckpointOrder({ createdAt: a.checkpoint.created_at, mtimeMs: a.mtimeMs, name: a.name, contentSha256: a.contentSha256 }, { createdAt: b.checkpoint.created_at, mtimeMs: b.mtimeMs, name: b.name, contentSha256: b.contentSha256 }));
}
export function findLatestCheckpointForRestore(directory, sessionId) {
    if (!isValidSessionId(sessionId))
        return { ok: false, reason: 'invalid_session_id' };
    const omcRoot = getOmcRoot(directory);
    const checkpointDir = join(omcRoot, 'state', 'checkpoints');
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context)
        return { ok: false, reason: 'missing' };
    const rawCandidates = listCheckpointCandidates(omcRoot, checkpointDir, context);
    if (rawCandidates.length === 0)
        return { ok: false, reason: 'no_checkpoints' };
    const scored = [];
    let newestUnparseable = null;
    for (const candidate of rawCandidates) {
        const checkpoint = parseCheckpoint(omcRoot, candidate, context);
        if (checkpoint?.session_id === sessionId) {
            const raw = readBoundedCheckpoint(candidate.verified.path, candidate.verified);
            if (raw !== null) {
                try {
                    if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(checkpoint))
                        continue;
                }
                catch {
                    continue;
                }
                scored.push({ ...candidate, checkpoint, contentSha256: createHash('sha256').update(raw).digest('hex') });
            }
        }
        else if (!newestUnparseable || candidate.mtimeMs > newestUnparseable.mtimeMs) {
            newestUnparseable = candidate;
        }
    }
    if (scored.length === 0) {
        const candidate = newestUnparseable;
        return { ok: false, reason: 'malformed', path: candidate?.path, detail: candidate ? `could not parse ${candidate.name} (or it exceeds ${CHECKPOINT_MAX_BYTES} bytes)` : undefined };
    }
    sortNewestFirst(scored);
    const newestOverall = scored[0];
    for (const candidate of scored) {
        if (isCheckpointRestored(directory, sessionId, candidate.path)) {
            return { ok: false, reason: 'already_restored', path: candidate.path, detail: `newest eligible checkpoint already restored for session ${sessionId}` };
        }
        if (!isWithinAgeBound(candidate.checkpoint.created_at)) {
            return { ok: false, reason: 'stale', path: candidate.path, detail: `checkpoint ${candidate.name} older than ${CHECKPOINT_MAX_AGE_MS}ms` };
        }
        return {
            ok: true,
            checkpoint: candidate.checkpoint,
            path: candidate.path,
            mtimeMs: candidate.mtimeMs,
            contentSha256: candidate.contentSha256,
        };
    }
    return { ok: false, reason: 'already_restored', path: newestOverall.path, detail: `all ${scored.length} checkpoint(s) already restored for session ${sessionId}` };
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
export function formatCheckpointRestoreContext(checkpoint, path) {
    const lines = [
        '[PRECOMPACT CHECKPOINT RESTORED]',
        '',
        `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
        'Source: PreCompact checkpoint written before the last compaction.',
    ];
    const modes = checkpoint.active_modes ?? {};
    const entries = Object.entries(modes).filter(([, value]) => value != null);
    if (entries.length > 0) {
        lines.push('', 'Active modes at compaction time:');
        for (const [name, mode] of entries) {
            if (mode === null || typeof mode !== 'object' || Array.isArray(mode))
                continue;
            if ('iteration' in mode && typeof mode.iteration === 'number')
                lines.push(`- ${name} (iteration ${mode.iteration})`);
            else if ('cycle' in mode && typeof mode.cycle === 'number')
                lines.push(`- ${name} (cycle ${mode.cycle})`);
            else if ('phase' in mode && typeof mode.phase === 'string')
                lines.push(`- ${name} (phase ${mode.phase})`);
            else
                lines.push(`- ${name}`);
        }
    }
    const todos = checkpoint.todo_summary;
    const todoTotal = (todos?.pending ?? 0) + (todos?.in_progress ?? 0) + (todos?.completed ?? 0);
    if (todoTotal > 0)
        lines.push('', `TODOs at compaction time: ${todos?.pending ?? 0} pending, ${todos?.in_progress ?? 0} in progress, ${todos?.completed ?? 0} completed.`);
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
    if (checkpoint.wisdom_exported)
        lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
    lines.push('', 'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.', `Raw checkpoint: ${path}`);
    return truncate(lines.join('\n'), RESTORE_CONTEXT_MAX_CHARS);
}
export function restorePreCompactCheckpoint(directory, sessionId) {
    try {
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        for (let attempt = 0; attempt < RESTORE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
            const candidate = findLatestCheckpointForRestore(directory, sessionId);
            if (!candidate.ok)
                return null;
            const marker_status = markCheckpointRestored(directory, sessionId, candidate.path, candidate.checkpoint.created_at, candidate.mtimeMs, candidate.contentSha256);
            if (marker_status === 'written')
                return { text: formatCheckpointRestoreContext(candidate.checkpoint, candidate.path), marker_status };
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
//# sourceMappingURL=restore.js.map