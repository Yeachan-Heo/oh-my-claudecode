import type { TeamReminderIntent } from './reminder-intents.js';
/**
 * Dispatch Queue - Low-level file-based dispatch request operations.
 *
 * Manages dispatch/requests.json with atomic read/write, dedup, and
 * directory-based locking (O_EXCL mkdir) with stale lock detection.
 *
 * State file: .omc/state/team/{name}/dispatch/requests.json
 * Lock path:  .omc/state/team/{name}/dispatch/.lock/
 *
 * OMX-derived behavior adapted to OMC .omc state-root contracts.
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
  intent?: TeamReminderIntent;
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
  intent?: TeamReminderIntent;
}

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
    intent: typeof raw.intent === 'string' ? raw.intent : undefined,
  };
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
