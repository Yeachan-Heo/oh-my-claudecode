/**
 * Dispatch Queue - Low-level file-based dispatch request operations.
 *
 * Manages dispatch/requests.json with atomic read/write, dedup, and a
 * process-identity file lock that is reclaimed only from a dead holder.
 *
 * State file: .omc/state/team/{name}/dispatch/requests.json
 * Lock paths: .omc/state/team/{name}/dispatch/requests.lock, then dispatch/.lock/
 *
 * Mirrors OMX src/team/state/dispatch.ts behavior exactly.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { TeamPaths, absPath } from './state-paths.js';
import { atomicWriteJson, ensureDirWithMode } from './fs-utils.js';
import { WORKER_NAME_SAFE_PATTERN } from './contracts.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { currentProcessStartIdentity, isProcessIdentityDead } from './team-owner-epoch.js';
/** Thrown by writers instead of replacing a requests.json they could not parse. */
export class DispatchStoreInvalidError extends Error {
    path;
    reason;
    constructor(path, reason) {
        super(`Refusing to overwrite invalid dispatch store ${path} (${reason})`);
        this.path = path;
        this.reason = reason;
        this.name = 'DispatchStoreInvalidError';
    }
}
/** Thrown when the team's dispatch lock stays held past the acquisition deadline. */
export class DispatchLockTimeoutError extends Error {
    constructor(teamName, timeoutMs) {
        super(`Timed out acquiring dispatch lock for ${teamName} after ${timeoutMs}ms. ` +
            `Set ${OMC_DISPATCH_LOCK_TIMEOUT_ENV} to increase (current: ${timeoutMs}ms, max: ${MAX_DISPATCH_LOCK_TIMEOUT_MS}ms).`);
        this.name = 'DispatchLockTimeoutError';
    }
}
/** Failures of the team's shared lock or store, which every other enqueue for the team would hit as well. */
export function isTeamWideDispatchFailure(error) {
    return error instanceof DispatchLockTimeoutError || error instanceof DispatchStoreInvalidError;
}
// ── Lock constants ─────────────────────────────────────────────────────────
const OMC_DISPATCH_LOCK_TIMEOUT_ENV = 'OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS';
const DEFAULT_DISPATCH_LOCK_TIMEOUT_MS = 15_000;
const MIN_DISPATCH_LOCK_TIMEOUT_MS = 1_000;
const MAX_DISPATCH_LOCK_TIMEOUT_MS = 120_000;
const LEGACY_LOCK_STALE_MS = 5 * 60 * 1000;
const LEGACY_LOCK_INITIAL_POLL_MS = 25;
const LEGACY_LOCK_MAX_POLL_MS = 500;
// ── Validation ─────────────────────────────────────────────────────────────
function validateWorkerName(name) {
    if (!WORKER_NAME_SAFE_PATTERN.test(name)) {
        throw new Error(`Invalid worker name: "${name}"`);
    }
}
function isDispatchKind(value) {
    return value === 'inbox' || value === 'mailbox' || value === 'nudge';
}
function isDispatchStatus(value) {
    return value === 'pending' || value === 'notified' || value === 'delivered' || value === 'failed';
}
function isDispatchTransportPreference(value) {
    return value === 'hook_preferred_with_fallback' || value === 'transport_direct' || value === 'prompt_stdin';
}
function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function isStrictText(value) {
    return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}
function isStrictTimestamp(value) {
    return isStrictText(value) && Number.isFinite(Date.parse(value));
}
function isStrictNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
// ── Lock ───────────────────────────────────────────────────────────────────
export function resolveDispatchLockTimeoutMs(env = process.env) {
    const raw = env[OMC_DISPATCH_LOCK_TIMEOUT_ENV];
    if (raw === undefined || raw === '')
        return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
    return Math.max(MIN_DISPATCH_LOCK_TIMEOUT_MS, Math.min(MAX_DISPATCH_LOCK_TIMEOUT_MS, Math.floor(parsed)));
}
async function withDispatchLock(teamName, cwd, fn) {
    const root = absPath(cwd, TeamPaths.root(teamName));
    if (!existsSync(root))
        throw new Error(`Team ${teamName} not found`);
    const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
    const deadline = Date.now() + timeoutMs;
    const timedOut = () => new DispatchLockTimeoutError(teamName, timeoutMs);
    try {
        return await withProcessIdentityFileLock(absPath(cwd, TeamPaths.dispatchLock(teamName)), () => withLegacyDispatchLockDir(absPath(cwd, TeamPaths.dispatchLegacyLockDir(teamName)), deadline, timedOut, fn), timeoutMs);
    }
    catch (error) {
        if (error instanceof Error && error.message === 'process_identity_lock_timeout')
            throw timedOut();
        throw error;
    }
}
async function isLegacyDispatchLockReclaimable(lockDir) {
    try {
        const owner = JSON.parse(await readFile(join(lockDir, 'owner'), 'utf8'));
        if (isProcessIdentityDead(owner))
            return true;
    }
    catch {
        // Older versions write a non-JSON token; only age can retire their directory.
    }
    try {
        return Date.now() - (await stat(lockDir)).mtimeMs > LEGACY_LOCK_STALE_MS;
    }
    catch {
        return false;
    }
}
// Migration shim: OMC versions without requests.lock still serialize on this mkdir lock; delete once none can be running.
async function withLegacyDispatchLockDir(lockDir, deadline, timedOut, fn) {
    const ownerPath = join(lockDir, 'owner');
    const owner = JSON.stringify({ pid: process.pid, process_started_at: currentProcessStartIdentity(), nonce: randomUUID() });
    let pollMs = LEGACY_LOCK_INITIAL_POLL_MS;
    while (true) {
        try {
            await mkdir(lockDir);
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        if (await isLegacyDispatchLockReclaimable(lockDir)) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
        }
        if (Date.now() >= deadline)
            throw timedOut();
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        pollMs = Math.min(pollMs * 2, LEGACY_LOCK_MAX_POLL_MS);
    }
    try {
        await writeFile(ownerPath, owner, 'utf8');
    }
    catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
    }
    try {
        return await fn();
    }
    finally {
        // Release is best effort: fn() may already have committed, and a failed rm must not report it as failed.
        if (await readFile(ownerPath, 'utf8').catch(() => null) === owner) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
// ── IO ─────────────────────────────────────────────────────────────────────
async function readDispatchStore(teamName, cwd) {
    const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        return error.code === 'ENOENT'
            ? { kind: 'ok', entries: [] }
            : { kind: 'invalid', reason: 'unreadable' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: 'invalid', reason: 'json' };
    }
    if (!Array.isArray(parsed))
        return { kind: 'invalid', reason: 'non_array' };
    return {
        kind: 'ok',
        entries: parsed.map((raw) => {
            const request = isPlainRecord(raw) ? normalizeDispatchRequest(teamName, raw) : null;
            return request ? { kind: 'request', request } : { kind: 'unrecognized', raw };
        }),
    };
}
function requestsOf(entries) {
    return entries.flatMap((entry) => (entry.kind === 'request' ? [entry.request] : []));
}
async function readDispatchRequestsFromFile(teamName, cwd) {
    const store = await readDispatchStore(teamName, cwd);
    return store.kind === 'ok' ? requestsOf(store.entries) : [];
}
async function readDispatchStoreForWrite(teamName, cwd) {
    const store = await readDispatchStore(teamName, cwd);
    if (store.kind === 'invalid') {
        throw new DispatchStoreInvalidError(absPath(cwd, TeamPaths.dispatchRequests(teamName)), store.reason);
    }
    return store.entries;
}
async function writeDispatchStore(teamName, entries, cwd) {
    const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
    ensureDirWithMode(dirname(path));
    atomicWriteJson(path, entries.map((entry) => (entry.kind === 'request' ? entry.request : entry.raw)));
}
// ── Normalization ──────────────────────────────────────────────────────────
export function normalizeDispatchRequest(teamName, raw, nowIso = new Date().toISOString()) {
    if (!isDispatchKind(raw.kind))
        return null;
    if (typeof raw.to_worker !== 'string' || raw.to_worker.trim() === '')
        return null;
    if (typeof raw.trigger_message !== 'string' || raw.trigger_message.trim() === '')
        return null;
    const status = isDispatchStatus(raw.status) ? raw.status : 'pending';
    return {
        request_id: typeof raw.request_id === 'string' && raw.request_id.trim() !== '' ? raw.request_id : randomUUID(),
        kind: raw.kind,
        team_name: teamName,
        to_worker: raw.to_worker,
        worker_index: typeof raw.worker_index === 'number' ? raw.worker_index : undefined,
        pane_id: typeof raw.pane_id === 'string' && raw.pane_id !== '' ? raw.pane_id : undefined,
        trigger_message: raw.trigger_message,
        message_id: typeof raw.message_id === 'string' && raw.message_id !== '' ? raw.message_id : undefined,
        inbox_correlation_key: typeof raw.inbox_correlation_key === 'string' && raw.inbox_correlation_key !== '' ? raw.inbox_correlation_key : undefined,
        transport_preference: raw.transport_preference === 'transport_direct' || raw.transport_preference === 'prompt_stdin'
            ? raw.transport_preference
            : 'hook_preferred_with_fallback',
        fallback_allowed: raw.fallback_allowed !== false,
        status,
        attempt_count: Number.isFinite(raw.attempt_count) ? Math.max(0, Math.floor(raw.attempt_count)) : 0,
        created_at: typeof raw.created_at === 'string' && raw.created_at !== '' ? raw.created_at : nowIso,
        updated_at: typeof raw.updated_at === 'string' && raw.updated_at !== '' ? raw.updated_at : nowIso,
        notified_at: typeof raw.notified_at === 'string' && raw.notified_at !== '' ? raw.notified_at : undefined,
        delivered_at: typeof raw.delivered_at === 'string' && raw.delivered_at !== '' ? raw.delivered_at : undefined,
        failed_at: typeof raw.failed_at === 'string' && raw.failed_at !== '' ? raw.failed_at : undefined,
        last_reason: typeof raw.last_reason === 'string' && raw.last_reason !== '' ? raw.last_reason : undefined,
    };
}
function strictMalformedRow(rowIndex, field) {
    return { kind: 'malformed_row', rowIndex, field };
}
function materializeStrictDispatchRequest(raw) {
    const request = {
        request_id: raw.request_id,
        kind: raw.kind,
        team_name: raw.team_name,
        to_worker: raw.to_worker,
        trigger_message: raw.trigger_message,
        transport_preference: raw.transport_preference,
        fallback_allowed: raw.fallback_allowed,
        status: raw.status,
        attempt_count: raw.attempt_count,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    };
    if ('worker_index' in raw)
        request.worker_index = raw.worker_index;
    if ('pane_id' in raw)
        request.pane_id = raw.pane_id;
    if ('message_id' in raw)
        request.message_id = raw.message_id;
    if ('inbox_correlation_key' in raw)
        request.inbox_correlation_key = raw.inbox_correlation_key;
    if ('notified_at' in raw)
        request.notified_at = raw.notified_at;
    if ('delivered_at' in raw)
        request.delivered_at = raw.delivered_at;
    if ('failed_at' in raw)
        request.failed_at = raw.failed_at;
    if ('last_reason' in raw)
        request.last_reason = raw.last_reason;
    return request;
}
function validateStrictDispatchRow(teamName, raw, rowIndex) {
    if (!isPlainRecord(raw))
        return strictMalformedRow(rowIndex, '$');
    if (!isStrictText(raw.request_id))
        return strictMalformedRow(rowIndex, 'request_id');
    if (typeof raw.team_name !== 'string' || raw.team_name === '')
        return strictMalformedRow(rowIndex, 'team_name');
    if (raw.team_name !== teamName)
        return { kind: 'team_mismatch', rowIndex };
    if (!isDispatchKind(raw.kind))
        return { kind: 'invalid_kind', rowIndex };
    if (!isStrictText(raw.to_worker))
        return strictMalformedRow(rowIndex, 'to_worker');
    if (!isStrictText(raw.trigger_message))
        return strictMalformedRow(rowIndex, 'trigger_message');
    if (!isDispatchTransportPreference(raw.transport_preference))
        return strictMalformedRow(rowIndex, 'transport_preference');
    if (typeof raw.fallback_allowed !== 'boolean')
        return strictMalformedRow(rowIndex, 'fallback_allowed');
    if (!isDispatchStatus(raw.status))
        return { kind: 'invalid_status', rowIndex };
    if (!isStrictNonNegativeInteger(raw.attempt_count))
        return strictMalformedRow(rowIndex, 'attempt_count');
    if (!isStrictTimestamp(raw.created_at))
        return strictMalformedRow(rowIndex, 'created_at');
    if (!isStrictTimestamp(raw.updated_at))
        return strictMalformedRow(rowIndex, 'updated_at');
    if (raw.kind === 'mailbox' && !isStrictText(raw.message_id))
        return strictMalformedRow(rowIndex, 'message_id');
    if ('message_id' in raw && !isStrictText(raw.message_id))
        return strictMalformedRow(rowIndex, 'message_id');
    if ('worker_index' in raw && !isStrictNonNegativeInteger(raw.worker_index))
        return strictMalformedRow(rowIndex, 'worker_index');
    if ('pane_id' in raw && !isStrictText(raw.pane_id))
        return strictMalformedRow(rowIndex, 'pane_id');
    if ('inbox_correlation_key' in raw && !isStrictText(raw.inbox_correlation_key)) {
        return strictMalformedRow(rowIndex, 'inbox_correlation_key');
    }
    if ('notified_at' in raw && !isStrictTimestamp(raw.notified_at))
        return strictMalformedRow(rowIndex, 'notified_at');
    if ('delivered_at' in raw && !isStrictTimestamp(raw.delivered_at))
        return strictMalformedRow(rowIndex, 'delivered_at');
    if ('failed_at' in raw && !isStrictTimestamp(raw.failed_at))
        return strictMalformedRow(rowIndex, 'failed_at');
    if ('last_reason' in raw && typeof raw.last_reason !== 'string')
        return strictMalformedRow(rowIndex, 'last_reason');
    return materializeStrictDispatchRequest(raw);
}
async function readStrictDispatchStore(teamName, cwd) {
    const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        const code = error.code;
        return code === 'ENOENT'
            ? { kind: 'store_missing' }
            : { kind: 'malformed_store', cause: 'json' };
    }
    if (!Array.isArray(parsed))
        return { kind: 'malformed_store', cause: 'non_array' };
    const rawRows = [];
    const requests = [];
    for (let rowIndex = 0; rowIndex < parsed.length; rowIndex += 1) {
        const raw = parsed[rowIndex];
        const validated = validateStrictDispatchRow(teamName, raw, rowIndex);
        if (!('request_id' in validated))
            return validated;
        rawRows.push(raw);
        requests.push(validated);
    }
    return { kind: 'valid_store', rawRows, requests };
}
function lookupStrictDispatchRequest(store, requestId) {
    const indexesByRequestId = new Map();
    for (const [rowIndex, request] of store.requests.entries()) {
        const indexes = indexesByRequestId.get(request.request_id) ?? [];
        indexes.push(rowIndex);
        indexesByRequestId.set(request.request_id, indexes);
    }
    const requestedIndexes = indexesByRequestId.get(requestId) ?? [];
    if (requestedIndexes.length > 1) {
        return { kind: 'duplicate_request_id', requestId, rowIndexes: requestedIndexes };
    }
    const duplicateIndexes = [...indexesByRequestId.values()].filter((indexes) => indexes.length > 1).flat();
    if (duplicateIndexes.length > 0)
        return { kind: 'ambiguous_request', rowIndexes: duplicateIndexes };
    if (requestedIndexes.length === 0)
        return { kind: 'request_missing' };
    const rowIndex = requestedIndexes[0];
    const request = store.requests[rowIndex];
    if (request.kind !== 'mailbox')
        return { kind: 'invalid_kind', rowIndex };
    return { kind: 'valid', request, rowIndex };
}
async function readStrictDispatchRequestWithIndex(teamName, requestId, cwd) {
    const store = await readStrictDispatchStore(teamName, cwd);
    if (store.kind !== 'valid_store')
        return { read: store };
    return { read: lookupStrictDispatchRequest(store, requestId), store };
}
/**
 * Reads raw dispatch evidence for the direct mailbox authorization boundary.
 * Unlike readDispatchRequest, it neither defaults nor rewrites persisted data.
 */
export async function readDispatchRequestStrict(teamName, requestId, cwd) {
    const { read } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
    if (read.kind === 'valid')
        return { kind: 'valid', request: { ...read.request } };
    return read;
}
/**
 * Patches only a uniquely validated pending mailbox request. Invalid or
 * ambiguous persisted stores are left byte-for-byte untouched.
 */
export async function patchPendingDispatchReason(teamName, requestId, reason, cwd) {
    if (!existsSync(absPath(cwd, TeamPaths.root(teamName))))
        return { kind: 'missing' };
    try {
        return await withDispatchLock(teamName, cwd, async () => {
            const { read, store } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
            if (read.kind === 'store_missing' || read.kind === 'request_missing')
                return { kind: 'missing' };
            if (read.kind !== 'valid')
                return { kind: 'unsafe', read };
            if (!store)
                return { kind: 'write_failed' };
            if (read.request.status !== 'pending')
                return { kind: 'not_pending', request: { ...read.request } };
            const nowIso = new Date().toISOString();
            const nextRows = store.rawRows.map((row) => ({ ...row }));
            nextRows[read.rowIndex] = {
                ...nextRows[read.rowIndex],
                last_reason: reason,
                updated_at: nowIso,
            };
            try {
                atomicWriteJson(absPath(cwd, TeamPaths.dispatchRequests(teamName)), nextRows);
            }
            catch {
                return { kind: 'write_failed' };
            }
            return {
                kind: 'patched',
                request: {
                    ...read.request,
                    last_reason: reason,
                    updated_at: nowIso,
                },
            };
        });
    }
    catch {
        return { kind: 'write_failed' };
    }
}
// ── Dedup ──────────────────────────────────────────────────────────────────
function equivalentPendingDispatch(existing, input) {
    if (existing.status !== 'pending')
        return false;
    if (existing.kind !== input.kind)
        return false;
    if (existing.to_worker !== input.to_worker)
        return false;
    if (input.kind === 'mailbox') {
        return Boolean(input.message_id) && existing.message_id === input.message_id;
    }
    if (input.kind === 'inbox' && input.inbox_correlation_key) {
        return existing.inbox_correlation_key === input.inbox_correlation_key;
    }
    return existing.trigger_message === input.trigger_message;
}
// ── Status transitions ─────────────────────────────────────────────────────
function canTransitionDispatchStatus(from, to) {
    if (from === to)
        return true;
    if (from === 'pending' && (to === 'notified' || to === 'failed'))
        return true;
    if (from === 'notified' && (to === 'delivered' || to === 'failed'))
        return true;
    return false;
}
// ── Public API ─────────────────────────────────────────────────────────────
export async function enqueueDispatchRequest(teamName, requestInput, cwd) {
    if (!isDispatchKind(requestInput.kind))
        throw new Error(`Invalid dispatch request kind: ${String(requestInput.kind)}`);
    if (requestInput.kind === 'mailbox' && (!requestInput.message_id || requestInput.message_id.trim() === '')) {
        throw new Error('mailbox dispatch requests require message_id');
    }
    validateWorkerName(requestInput.to_worker);
    return await withDispatchLock(teamName, cwd, async () => {
        const entries = await readDispatchStoreForWrite(teamName, cwd);
        const existing = requestsOf(entries).find((req) => equivalentPendingDispatch(req, requestInput));
        if (existing)
            return { request: existing, deduped: true };
        const nowIso = new Date().toISOString();
        const request = normalizeDispatchRequest(teamName, {
            request_id: randomUUID(),
            ...requestInput,
            status: 'pending',
            attempt_count: 0,
            created_at: nowIso,
            updated_at: nowIso,
        }, nowIso);
        if (!request)
            throw new Error('failed_to_normalize_dispatch_request');
        entries.push({ kind: 'request', request });
        await writeDispatchStore(teamName, entries, cwd);
        return { request, deduped: false };
    });
}
export async function listDispatchRequests(teamName, cwd, opts = {}) {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    let filtered = requests;
    if (opts.status)
        filtered = filtered.filter((req) => req.status === opts.status);
    if (opts.kind)
        filtered = filtered.filter((req) => req.kind === opts.kind);
    if (opts.to_worker)
        filtered = filtered.filter((req) => req.to_worker === opts.to_worker);
    if (typeof opts.limit === 'number' && opts.limit > 0)
        filtered = filtered.slice(0, opts.limit);
    return filtered;
}
export async function readDispatchRequest(teamName, requestId, cwd) {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    return requests.find((req) => req.request_id === requestId) ?? null;
}
export async function transitionDispatchRequest(teamName, requestId, from, to, patch = {}, cwd) {
    return await withDispatchLock(teamName, cwd, async () => {
        const entries = await readDispatchStoreForWrite(teamName, cwd);
        const index = entries.findIndex((entry) => entry.kind === 'request' && entry.request.request_id === requestId);
        const entry = entries[index];
        if (entry?.kind !== 'request')
            return null;
        const existing = entry.request;
        if (existing.status !== from && existing.status !== to)
            return null;
        if (!canTransitionDispatchStatus(existing.status, to))
            return null;
        const nowIso = new Date().toISOString();
        const nextAttemptCount = Math.max(existing.attempt_count, Number.isFinite(patch.attempt_count)
            ? Math.floor(patch.attempt_count)
            : (existing.status === to ? existing.attempt_count : existing.attempt_count + 1));
        const next = {
            ...existing,
            ...patch,
            status: to,
            attempt_count: Math.max(0, nextAttemptCount),
            updated_at: nowIso,
        };
        if (to === 'notified')
            next.notified_at = patch.notified_at ?? nowIso;
        if (to === 'delivered')
            next.delivered_at = patch.delivered_at ?? nowIso;
        if (to === 'failed')
            next.failed_at = patch.failed_at ?? nowIso;
        entries[index] = { kind: 'request', request: next };
        await writeDispatchStore(teamName, entries, cwd);
        return next;
    });
}
export async function markDispatchRequestNotified(teamName, requestId, patch = {}, cwd) {
    const current = await readDispatchRequest(teamName, requestId, cwd);
    if (!current)
        return null;
    if (current.status === 'notified' || current.status === 'delivered')
        return current;
    return await transitionDispatchRequest(teamName, requestId, current.status, 'notified', patch, cwd);
}
export async function markDispatchRequestDelivered(teamName, requestId, patch = {}, cwd) {
    const current = await readDispatchRequest(teamName, requestId, cwd);
    if (!current)
        return null;
    if (current.status === 'delivered')
        return current;
    return await transitionDispatchRequest(teamName, requestId, current.status, 'delivered', patch, cwd);
}
//# sourceMappingURL=dispatch-queue.js.map