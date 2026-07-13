/**
 * Dispatch Queue - Low-level file-based dispatch request operations.
 *
 * Manages dispatch/requests.json with atomic read/write, dedup, and
 * directory-based locking (O_EXCL mkdir) with stale lock detection.
 *
 * State file: .omc/state/team/{name}/dispatch/requests.json
 * Lock path:  .omc/state/team/{name}/dispatch/.lock/
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

// ── Types ──────────────────────────────────────────────────────────────────

export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchRequestStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';

export interface TeamDispatchRequest {
  request_id: string;
  kind: TeamDispatchRequestKind;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference: TeamDispatchTransportPreference;
  fallback_allowed: boolean;
  status: TeamDispatchRequestStatus;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

export interface TeamDispatchRequestInput {
  kind: TeamDispatchRequestKind;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference?: TeamDispatchTransportPreference;
  fallback_allowed?: boolean;
  last_reason?: string;
}

/**
 * Result of reading raw dispatch evidence for the mailbox authorization guard.
 * This intentionally does not share the compatibility normalization path.
 */
export type StrictDispatchReadResult =
  | { kind: 'valid'; request: TeamDispatchRequest }
  | { kind: 'store_missing' }
  | { kind: 'malformed_store'; cause: 'json' | 'non_array' }
  | { kind: 'malformed_row'; rowIndex: number; field: string }
  | { kind: 'team_mismatch'; rowIndex: number }
  | { kind: 'invalid_kind'; rowIndex: number }
  | { kind: 'invalid_status'; rowIndex: number }
  | { kind: 'duplicate_request_id'; requestId: string; rowIndexes: number[] }
  | { kind: 'request_missing' }
  | { kind: 'ambiguous_request'; rowIndexes: number[] };

/** A checked, non-transitioning diagnostic patch for a strict pending request. */
export type PatchPendingDispatchReasonResult =
  | { kind: 'patched'; request: TeamDispatchRequest }
  | { kind: 'missing' }
  | { kind: 'not_pending'; request: TeamDispatchRequest }
  | { kind: 'unsafe'; read: Exclude<StrictDispatchReadResult, { kind: 'valid' | 'request_missing' }> }
  | { kind: 'write_failed' };

// ── Lock constants ─────────────────────────────────────────────────────────

const OMC_DISPATCH_LOCK_TIMEOUT_ENV = 'OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS';
const DEFAULT_DISPATCH_LOCK_TIMEOUT_MS = 15_000;
const MIN_DISPATCH_LOCK_TIMEOUT_MS = 1_000;
const MAX_DISPATCH_LOCK_TIMEOUT_MS = 120_000;
const DISPATCH_LOCK_INITIAL_POLL_MS = 25;
const DISPATCH_LOCK_MAX_POLL_MS = 500;
const LOCK_STALE_MS = 5 * 60 * 1000;

// ── Validation ─────────────────────────────────────────────────────────────

function validateWorkerName(name: string): void {
  if (!WORKER_NAME_SAFE_PATTERN.test(name)) {
    throw new Error(`Invalid worker name: "${name}"`);
  }
}

function isDispatchKind(value: unknown): value is TeamDispatchRequestKind {
  return value === 'inbox' || value === 'mailbox' || value === 'nudge';
}

function isDispatchStatus(value: unknown): value is TeamDispatchRequestStatus {
  return value === 'pending' || value === 'notified' || value === 'delivered' || value === 'failed';
}

function isDispatchTransportPreference(value: unknown): value is TeamDispatchTransportPreference {
  return value === 'hook_preferred_with_fallback' || value === 'transport_direct' || value === 'prompt_stdin';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isStrictText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function isStrictTimestamp(value: unknown): value is string {
  return isStrictText(value) && Number.isFinite(Date.parse(value));
}

function isStrictNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

// ── Lock ───────────────────────────────────────────────────────────────────

export function resolveDispatchLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OMC_DISPATCH_LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  return Math.max(MIN_DISPATCH_LOCK_TIMEOUT_MS, Math.min(MAX_DISPATCH_LOCK_TIMEOUT_MS, Math.floor(parsed)));
}

async function withDispatchLock<T>(teamName: string, cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = absPath(cwd, TeamPaths.root(teamName));
  if (!existsSync(root)) throw new Error(`Team ${teamName} not found`);

  const lockDir = absPath(cwd, TeamPaths.dispatchLockDir(teamName));
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  let pollMs = DISPATCH_LOCK_INITIAL_POLL_MS;

  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;

      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out acquiring dispatch lock for ${teamName} after ${timeoutMs}ms. ` +
          `Set ${OMC_DISPATCH_LOCK_TIMEOUT_ENV} to increase (current: ${timeoutMs}ms, max: ${MAX_DISPATCH_LOCK_TIMEOUT_MS}ms).`,
        );
      }

      const jitter = 0.5 + Math.random() * 0.5;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(pollMs * jitter)));
      pollMs = Math.min(pollMs * 2, DISPATCH_LOCK_MAX_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

// ── IO ─────────────────────────────────────────────────────────────────────

async function readDispatchRequestsFromFile(teamName: string, cwd: string): Promise<TeamDispatchRequest[]> {
  const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  try {
    if (!existsSync(path)) return [];
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeDispatchRequest(teamName, entry as Partial<TeamDispatchRequest>))
      .filter((req): req is TeamDispatchRequest => req !== null);
  } catch {
    return [];
  }
}

async function writeDispatchRequestsToFile(teamName: string, requests: TeamDispatchRequest[], cwd: string): Promise<void> {
  const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  const dir = dirname(path);
  ensureDirWithMode(dir);
  atomicWriteJson(path, requests);
}

// ── Normalization ──────────────────────────────────────────────────────────

export function normalizeDispatchRequest(
  teamName: string,
  raw: Partial<TeamDispatchRequest>,
  nowIso: string = new Date().toISOString(),
): TeamDispatchRequest | null {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== 'string' || raw.to_worker.trim() === '') return null;
  if (typeof raw.trigger_message !== 'string' || raw.trigger_message.trim() === '') return null;

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
    inbox_correlation_key:
      typeof raw.inbox_correlation_key === 'string' && raw.inbox_correlation_key !== '' ? raw.inbox_correlation_key : undefined,
    transport_preference:
      raw.transport_preference === 'transport_direct' || raw.transport_preference === 'prompt_stdin'
        ? raw.transport_preference
        : 'hook_preferred_with_fallback',
    fallback_allowed: raw.fallback_allowed !== false,
    status,
    attempt_count: Number.isFinite(raw.attempt_count) ? Math.max(0, Math.floor(raw.attempt_count as number)) : 0,
    created_at: typeof raw.created_at === 'string' && raw.created_at !== '' ? raw.created_at : nowIso,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at !== '' ? raw.updated_at : nowIso,
    notified_at: typeof raw.notified_at === 'string' && raw.notified_at !== '' ? raw.notified_at : undefined,
    delivered_at: typeof raw.delivered_at === 'string' && raw.delivered_at !== '' ? raw.delivered_at : undefined,
    failed_at: typeof raw.failed_at === 'string' && raw.failed_at !== '' ? raw.failed_at : undefined,
    last_reason: typeof raw.last_reason === 'string' && raw.last_reason !== '' ? raw.last_reason : undefined,
  };
}

type StrictDispatchStoreFailure = Exclude<
  StrictDispatchReadResult,
  { kind: 'valid' | 'duplicate_request_id' | 'request_missing' | 'ambiguous_request' }
>;

interface StrictValidatedDispatchStore {
  kind: 'valid_store';
  rawRows: Record<string, unknown>[];
  requests: TeamDispatchRequest[];
}

type StrictDispatchStoreResult = StrictValidatedDispatchStore | StrictDispatchStoreFailure;

type StrictDispatchLookupResult =
  | { kind: 'valid'; request: TeamDispatchRequest; rowIndex: number }
  | Exclude<StrictDispatchReadResult, { kind: 'valid' }>;

function strictMalformedRow(rowIndex: number, field: string): StrictDispatchStoreFailure {
  return { kind: 'malformed_row', rowIndex, field };
}

function materializeStrictDispatchRequest(raw: Record<string, unknown>): TeamDispatchRequest {
  const request: TeamDispatchRequest = {
    request_id: raw.request_id as string,
    kind: raw.kind as TeamDispatchRequestKind,
    team_name: raw.team_name as string,
    to_worker: raw.to_worker as string,
    trigger_message: raw.trigger_message as string,
    transport_preference: raw.transport_preference as TeamDispatchTransportPreference,
    fallback_allowed: raw.fallback_allowed as boolean,
    status: raw.status as TeamDispatchRequestStatus,
    attempt_count: raw.attempt_count as number,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  };
  if ('worker_index' in raw) request.worker_index = raw.worker_index as number;
  if ('pane_id' in raw) request.pane_id = raw.pane_id as string;
  if ('message_id' in raw) request.message_id = raw.message_id as string;
  if ('inbox_correlation_key' in raw) request.inbox_correlation_key = raw.inbox_correlation_key as string;
  if ('notified_at' in raw) request.notified_at = raw.notified_at as string;
  if ('delivered_at' in raw) request.delivered_at = raw.delivered_at as string;
  if ('failed_at' in raw) request.failed_at = raw.failed_at as string;
  if ('last_reason' in raw) request.last_reason = raw.last_reason as string;
  return request;
}

function validateStrictDispatchRow(
  teamName: string,
  raw: unknown,
  rowIndex: number,
): TeamDispatchRequest | StrictDispatchStoreFailure {
  if (!isPlainRecord(raw)) return strictMalformedRow(rowIndex, '$');
  if (!isStrictText(raw.request_id)) return strictMalformedRow(rowIndex, 'request_id');
  if (typeof raw.team_name !== 'string' || raw.team_name === '') return strictMalformedRow(rowIndex, 'team_name');
  if (raw.team_name !== teamName) return { kind: 'team_mismatch', rowIndex };
  if (!isDispatchKind(raw.kind)) return { kind: 'invalid_kind', rowIndex };
  if (!isStrictText(raw.to_worker)) return strictMalformedRow(rowIndex, 'to_worker');
  if (!isStrictText(raw.trigger_message)) return strictMalformedRow(rowIndex, 'trigger_message');
  if (!isDispatchTransportPreference(raw.transport_preference)) return strictMalformedRow(rowIndex, 'transport_preference');
  if (typeof raw.fallback_allowed !== 'boolean') return strictMalformedRow(rowIndex, 'fallback_allowed');
  if (!isDispatchStatus(raw.status)) return { kind: 'invalid_status', rowIndex };
  if (!isStrictNonNegativeInteger(raw.attempt_count)) return strictMalformedRow(rowIndex, 'attempt_count');
  if (!isStrictTimestamp(raw.created_at)) return strictMalformedRow(rowIndex, 'created_at');
  if (!isStrictTimestamp(raw.updated_at)) return strictMalformedRow(rowIndex, 'updated_at');

  if (raw.kind === 'mailbox' && !isStrictText(raw.message_id)) return strictMalformedRow(rowIndex, 'message_id');
  if ('message_id' in raw && !isStrictText(raw.message_id)) return strictMalformedRow(rowIndex, 'message_id');
  if ('worker_index' in raw && !isStrictNonNegativeInteger(raw.worker_index)) return strictMalformedRow(rowIndex, 'worker_index');
  if ('pane_id' in raw && !isStrictText(raw.pane_id)) return strictMalformedRow(rowIndex, 'pane_id');
  if ('inbox_correlation_key' in raw && !isStrictText(raw.inbox_correlation_key)) {
    return strictMalformedRow(rowIndex, 'inbox_correlation_key');
  }
  if ('notified_at' in raw && !isStrictTimestamp(raw.notified_at)) return strictMalformedRow(rowIndex, 'notified_at');
  if ('delivered_at' in raw && !isStrictTimestamp(raw.delivered_at)) return strictMalformedRow(rowIndex, 'delivered_at');
  if ('failed_at' in raw && !isStrictTimestamp(raw.failed_at)) return strictMalformedRow(rowIndex, 'failed_at');
  if ('last_reason' in raw && typeof raw.last_reason !== 'string') return strictMalformedRow(rowIndex, 'last_reason');

  return materializeStrictDispatchRequest(raw);
}

async function readStrictDispatchStore(teamName: string, cwd: string): Promise<StrictDispatchStoreResult> {
  const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'store_missing' }
      : { kind: 'malformed_store', cause: 'json' };
  }
  if (!Array.isArray(parsed)) return { kind: 'malformed_store', cause: 'non_array' };

  const rawRows: Record<string, unknown>[] = [];
  const requests: TeamDispatchRequest[] = [];
  for (let rowIndex = 0; rowIndex < parsed.length; rowIndex += 1) {
    const raw = parsed[rowIndex];
    const validated = validateStrictDispatchRow(teamName, raw, rowIndex);
    if (!('request_id' in validated)) return validated;
    rawRows.push(raw as Record<string, unknown>);
    requests.push(validated);
  }
  return { kind: 'valid_store', rawRows, requests };
}

function lookupStrictDispatchRequest(
  store: StrictValidatedDispatchStore,
  requestId: string,
): StrictDispatchLookupResult {
  const indexesByRequestId = new Map<string, number[]>();
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
  if (duplicateIndexes.length > 0) return { kind: 'ambiguous_request', rowIndexes: duplicateIndexes };
  if (requestedIndexes.length === 0) return { kind: 'request_missing' };

  const rowIndex = requestedIndexes[0]!;
  const request = store.requests[rowIndex]!;
  if (request.kind !== 'mailbox') return { kind: 'invalid_kind', rowIndex };
  return { kind: 'valid', request, rowIndex };
}

async function readStrictDispatchRequestWithIndex(
  teamName: string,
  requestId: string,
  cwd: string,
): Promise<{ read: StrictDispatchLookupResult; store?: StrictValidatedDispatchStore }> {
  const store = await readStrictDispatchStore(teamName, cwd);
  if (store.kind !== 'valid_store') return { read: store };
  return { read: lookupStrictDispatchRequest(store, requestId), store };
}

/**
 * Reads raw dispatch evidence for the direct mailbox authorization boundary.
 * Unlike readDispatchRequest, it neither defaults nor rewrites persisted data.
 */
export async function readDispatchRequestStrict(
  teamName: string,
  requestId: string,
  cwd: string,
): Promise<StrictDispatchReadResult> {
  const { read } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
  if (read.kind === 'valid') return { kind: 'valid', request: { ...read.request } };
  return read;
}

/**
 * Patches only a uniquely validated pending mailbox request. Invalid or
 * ambiguous persisted stores are left byte-for-byte untouched.
 */
export async function patchPendingDispatchReason(
  teamName: string,
  requestId: string,
  reason: string,
  cwd: string,
): Promise<PatchPendingDispatchReasonResult> {
  if (!existsSync(absPath(cwd, TeamPaths.root(teamName)))) return { kind: 'missing' };

  try {
    return await withDispatchLock(teamName, cwd, async () => {
      const { read, store } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
      if (read.kind === 'store_missing' || read.kind === 'request_missing') return { kind: 'missing' };
      if (read.kind !== 'valid') return { kind: 'unsafe', read };
      if (!store) return { kind: 'write_failed' };
      if (read.request.status !== 'pending') return { kind: 'not_pending', request: { ...read.request } };

      const nowIso = new Date().toISOString();
      const nextRows = store.rawRows.map((row) => ({ ...row }));
      nextRows[read.rowIndex] = {
        ...nextRows[read.rowIndex],
        last_reason: reason,
        updated_at: nowIso,
      };
      try {
        atomicWriteJson(absPath(cwd, TeamPaths.dispatchRequests(teamName)), nextRows);
      } catch {
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
  } catch {
    return { kind: 'write_failed' };
  }
}

// ── Dedup ──────────────────────────────────────────────────────────────────

function equivalentPendingDispatch(existing: TeamDispatchRequest, input: TeamDispatchRequestInput): boolean {
  if (existing.status !== 'pending') return false;
  if (existing.kind !== input.kind) return false;
  if (existing.to_worker !== input.to_worker) return false;

  if (input.kind === 'mailbox') {
    return Boolean(input.message_id) && existing.message_id === input.message_id;
  }

  if (input.kind === 'inbox' && input.inbox_correlation_key) {
    return existing.inbox_correlation_key === input.inbox_correlation_key;
  }

  return existing.trigger_message === input.trigger_message;
}

// ── Status transitions ─────────────────────────────────────────────────────

function canTransitionDispatchStatus(from: TeamDispatchRequestStatus, to: TeamDispatchRequestStatus): boolean {
  if (from === to) return true;
  if (from === 'pending' && (to === 'notified' || to === 'failed')) return true;
  if (from === 'notified' && (to === 'delivered' || to === 'failed')) return true;
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function enqueueDispatchRequest(
  teamName: string,
  requestInput: TeamDispatchRequestInput,
  cwd: string,
): Promise<{ request: TeamDispatchRequest; deduped: boolean }> {
  if (!isDispatchKind(requestInput.kind)) throw new Error(`Invalid dispatch request kind: ${String(requestInput.kind)}`);
  if (requestInput.kind === 'mailbox' && (!requestInput.message_id || requestInput.message_id.trim() === '')) {
    throw new Error('mailbox dispatch requests require message_id');
  }
  validateWorkerName(requestInput.to_worker);

  return await withDispatchLock(teamName, cwd, async () => {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    const existing = requests.find((req) => equivalentPendingDispatch(req, requestInput));
    if (existing) return { request: existing, deduped: true };

    const nowIso = new Date().toISOString();
    const request = normalizeDispatchRequest(
      teamName,
      {
        request_id: randomUUID(),
        ...requestInput,
        status: 'pending',
        attempt_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      },
      nowIso,
    );
    if (!request) throw new Error('failed_to_normalize_dispatch_request');

    requests.push(request);
    await writeDispatchRequestsToFile(teamName, requests, cwd);
    return { request, deduped: false };
  });
}

export async function listDispatchRequests(
  teamName: string,
  cwd: string,
  opts: { status?: TeamDispatchRequestStatus; kind?: TeamDispatchRequestKind; to_worker?: string; limit?: number } = {},
): Promise<TeamDispatchRequest[]> {
  const requests = await readDispatchRequestsFromFile(teamName, cwd);
  let filtered = requests;
  if (opts.status) filtered = filtered.filter((req) => req.status === opts.status);
  if (opts.kind) filtered = filtered.filter((req) => req.kind === opts.kind);
  if (opts.to_worker) filtered = filtered.filter((req) => req.to_worker === opts.to_worker);
  if (typeof opts.limit === 'number' && opts.limit > 0) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

export async function readDispatchRequest(
  teamName: string,
  requestId: string,
  cwd: string,
): Promise<TeamDispatchRequest | null> {
  const requests = await readDispatchRequestsFromFile(teamName, cwd);
  return requests.find((req) => req.request_id === requestId) ?? null;
}

export async function transitionDispatchRequest(
  teamName: string,
  requestId: string,
  from: TeamDispatchRequestStatus,
  to: TeamDispatchRequestStatus,
  patch: Partial<TeamDispatchRequest> = {},
  cwd: string,
): Promise<TeamDispatchRequest | null> {
  return await withDispatchLock(teamName, cwd, async () => {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    const index = requests.findIndex((req) => req.request_id === requestId);
    if (index < 0) return null;

    const existing = requests[index]!;
    if (existing.status !== from && existing.status !== to) return null;
    if (!canTransitionDispatchStatus(existing.status, to)) return null;

    const nowIso = new Date().toISOString();
    const nextAttemptCount = Math.max(
      existing.attempt_count,
      Number.isFinite(patch.attempt_count)
        ? Math.floor(patch.attempt_count as number)
        : (existing.status === to ? existing.attempt_count : existing.attempt_count + 1),
    );

    const next: TeamDispatchRequest = {
      ...existing,
      ...patch,
      status: to,
      attempt_count: Math.max(0, nextAttemptCount),
      updated_at: nowIso,
    };
    if (to === 'notified') next.notified_at = patch.notified_at ?? nowIso;
    if (to === 'delivered') next.delivered_at = patch.delivered_at ?? nowIso;
    if (to === 'failed') next.failed_at = patch.failed_at ?? nowIso;

    requests[index] = next;
    await writeDispatchRequestsToFile(teamName, requests, cwd);
    return next;
  });
}

export async function markDispatchRequestNotified(
  teamName: string,
  requestId: string,
  patch: Partial<TeamDispatchRequest> = {},
  cwd: string,
): Promise<TeamDispatchRequest | null> {
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return null;
  if (current.status === 'notified' || current.status === 'delivered') return current;
  return await transitionDispatchRequest(teamName, requestId, current.status, 'notified', patch, cwd);
}

export async function markDispatchRequestDelivered(
  teamName: string,
  requestId: string,
  patch: Partial<TeamDispatchRequest> = {},
  cwd: string,
): Promise<TeamDispatchRequest | null> {
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return null;
  if (current.status === 'delivered') return current;
  return await transitionDispatchRequest(teamName, requestId, current.status, 'delivered', patch, cwd);
}
