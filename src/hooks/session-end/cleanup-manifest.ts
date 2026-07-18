import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';

export type SessionEndActionName = 'foreground-cleanup' | 'wiki-capture' | 'team-cleanup' | 'python-cleanup' | 'reply-cleanup' | 'callback' | 'notification' | 'openclaw';
export type ActionStatus = 'pending' | 'claimed' | 'retryable' | 'completed' | 'expired';

export interface SessionEndActionState {
  class: 'required' | 'best-effort'; phase: 'deferred-required' | 'deferred-best-effort'; status: ActionStatus;
  attempts: number; idempotencyKey: string; payload: Record<string, unknown>; budgetMs: number;
  claimantNonce?: string; claimedAt?: string;
  runner?: { attempt: number; runnerNonce: string; phase: 'reserved' | 'started' | 'armed' | 'result-recorded' | 'terminal'; deadlineAt: string };
  lastOutcomeCode?: string; completedAt?: string;
}
export interface ProducerSlot { state: 'absent' | 'prepared' | 'sealed' | 'no-op'; intentKey?: string; payloadDigest?: string; sealedAt?: string; sealedBy?: 'foreground' | 'recovery' | 'wiki-producer'; }
export interface WorkerOwner { nonce: string; pid: number; processStartIdentity: string; claimedAt: string; heartbeatAt: string; leaseExpiresAt: string; runDeadlineAt: string; leaseGeneration: number; claimedFromRevision: number; }
export interface SessionEndJobV1 {
  version: 1; jobId: string; sessionId: string; scopeKey: string; revision: number; createdAt: string; updatedAt: string;
  producerGraceExpiresAt: string; bestEffortDeadlineAt: string; producers: { core: ProducerSlot; wiki: ProducerSlot };
  actions: Record<SessionEndActionName, SessionEndActionState>; owner: WorkerOwner | null;
  phase: 'collecting' | 'ready' | 'processing' | 'recoverable-failure' | 'complete';
  completion?: { completedAt: string; terminalDigest: string; terminalRevision: number };
}

export interface OpenClawRoutingSnapshot {
  openClawConfig?: string;
  replyChannel?: string;
  replyTarget?: string;
  replyThread?: string;
  tmux?: string;
  tmuxPane?: string;
}

function openClawRoutingSnapshot(): OpenClawRoutingSnapshot {
  const values: Array<[keyof OpenClawRoutingSnapshot, string]> = [
    ['openClawConfig', 'OMC_OPENCLAW_CONFIG'],
    ['replyChannel', 'OPENCLAW_REPLY_CHANNEL'],
    ['replyTarget', 'OPENCLAW_REPLY_TARGET'],
    ['replyThread', 'OPENCLAW_REPLY_THREAD'],
    ['tmux', 'TMUX'],
    ['tmuxPane', 'TMUX_PANE'],
  ];
  return Object.fromEntries(values.flatMap(([property, environment]) => process.env[environment] === undefined ? [] : [[property, process.env[environment]]])) as OpenClawRoutingSnapshot;
}

function withOpenClawRouting(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, openClawRouting: openClawRoutingSnapshot() };
}

const ACTIONS: Array<[SessionEndActionName, 'required' | 'best-effort']> = [
  ['foreground-cleanup', 'required'], ['wiki-capture', 'required'], ['team-cleanup', 'required'], ['python-cleanup', 'required'], ['reply-cleanup', 'required'],
  ['callback', 'best-effort'], ['notification', 'best-effort'], ['openclaw', 'best-effort'],
];
const TEST_PRODUCER_GRACE_ENV = 'OMC_SESSION_END_TEST_PRODUCER_GRACE_MS';
const PRODUCER_GRACE_MS = process.env.NODE_ENV === 'test' && /^\d+$/.test(process.env[TEST_PRODUCER_GRACE_ENV] ?? '')
  ? Math.max(1, Number(process.env[TEST_PRODUCER_GRACE_ENV]))
  : 30_000;
const REQUIRED_ACTION_EXECUTION_MS = ACTIONS.filter(([, actionClass]) => actionClass === 'required').length * 9_000;
const BEST_EFFORT_ACTION_EXECUTION_MS = ACTIONS.filter(([, actionClass]) => actionClass === 'best-effort').length * 2_000;
const REQUIRED_ACTION_MAX_ATTEMPTS = 3;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const DISCOVERY_FILE = 'discovery.json';
export interface DiscoveryTicket { sessionId: string; claimNonce?: string; leaseExpiresAt?: string; attempts: number; retryAt: string; acknowledgedAt?: string; }
interface DiscoveryIndex { version: 2; cursor: number; tickets: DiscoveryTicket[]; }

export function sessionEndJobPath(directory: string, sessionId: string): string { validateSessionId(sessionId); return path.join(getOmcRoot(directory), 'state', 'session-end-jobs', `${sessionId}.json`); }
export function sessionEndJobsDirectory(directory: string): string { return path.join(getOmcRoot(directory), 'state', 'session-end-jobs'); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function nowIso(): string { return new Date().toISOString(); }
function initialDeadlines(): { producerGraceExpiresAt: string; bestEffortDeadlineAt: string } {
  const startedAt = Date.now();
  return {
    producerGraceExpiresAt: new Date(startedAt + PRODUCER_GRACE_MS).toISOString(),
    bestEffortDeadlineAt: new Date(startedAt + PRODUCER_GRACE_MS + REQUIRED_ACTION_EXECUTION_MS + BEST_EFFORT_ACTION_EXECUTION_MS).toISOString(),
  };
}

function lockPath(file: string): string { return `${file}.lock`; }
interface ManifestLock { pid: number; processStartIdentity: string | null; nonce: string; createdAt: string; }
function lockIsReclaimable(lock: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8')) as ManifestLock;
    if (Number.isInteger(parsed.pid) && parsed.pid > 0) {
      try {
        process.kill(parsed.pid, 0);
        if (parsed.processStartIdentity && process.platform === 'linux') { try { const stat = fs.readFileSync(`/proc/${parsed.pid}/stat`, 'utf8'); if ((stat.substring(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '') !== parsed.processStartIdentity) return true; } catch { return true; } }
        return false;
      } catch { return true; }
    }
    return Date.now() - Date.parse(parsed.createdAt) > 30_000;
  } catch { try { return Date.now() - fs.statSync(lock).mtimeMs > 30_000; } catch { return false; } }
}
function withLock<T>(file: string, body: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = lockPath(file); const reclaim = `${lock}.reclaim`; let fd: number | undefined; const nonce = randomUUID();
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      if (fs.existsSync(reclaim)) throw Object.assign(new Error('reclaim-in-progress'), { code: 'EEXIST' });
      fd = fs.openSync(lock, 'wx');
      let processStartIdentity: string | null = null; try { const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'); processStartIdentity = stat.substring(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { /* platform fallback retains nonce/timestamp bounded stale reclaim */ }
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, processStartIdentity, nonce, createdAt: nowIso() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 20 && lockIsReclaimable(lock)) {
        let reclaimFd: number | undefined;
        try {
          reclaimFd = fs.openSync(reclaim, 'wx');
          if (lockIsReclaimable(lock)) fs.unlinkSync(lock);
        } catch { /* another contender owns reclamation */ }
        finally { if (reclaimFd !== undefined) { fs.closeSync(reclaimFd); try { fs.unlinkSync(reclaim); } catch { /* next contender observes absence */ } } }
      }
      Atomics.wait(LOCK_WAIT, 0, 0, Math.min(20, attempt + 1));
    }
  }
  if (fd === undefined) throw new Error('session-end-manifest-lock-timeout');
  try { return body(); } finally { fs.closeSync(fd); try { const holder = JSON.parse(fs.readFileSync(lock, 'utf8')) as ManifestLock; if (holder.nonce === nonce) fs.unlinkSync(lock); } catch { /* missing or replaced lock is not ours to remove */ } }
}
function readPath(jobPath: string): SessionEndJobV1 | null { try { return JSON.parse(fs.readFileSync(jobPath, 'utf8')) as SessionEndJobV1; } catch { return null; } }
function discoveryPath(directory: string): string { return path.join(sessionEndJobsDirectory(directory), DISCOVERY_FILE); }
function readIndex(file: string): DiscoveryIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiscoveryIndex>;
    if (parsed.version === 2 && Array.isArray(parsed.tickets)) return { version: 2, cursor: Number.isInteger(parsed.cursor) ? parsed.cursor! : 0, tickets: parsed.tickets.filter((ticket): ticket is DiscoveryTicket => !!ticket && typeof ticket.sessionId === 'string').map(ticket => ({ sessionId: ticket.sessionId, attempts: Number.isInteger(ticket.attempts) ? ticket.attempts : 0, retryAt: typeof ticket.retryAt === 'string' ? ticket.retryAt : nowIso(), claimNonce: ticket.claimNonce, leaseExpiresAt: ticket.leaseExpiresAt, acknowledgedAt: ticket.acknowledgedAt })) };
  } catch { /* empty index */ }
  return { version: 2, cursor: 0, tickets: [] };
}
function updateTicket(directory: string, sessionId: string, present: boolean): void {
  const file = discoveryPath(directory);
  withLock(file, () => {
    const index = readIndex(file); const ticket = index.tickets.find(item => item.sessionId === sessionId);
    if (!present) index.tickets = index.tickets.filter(item => item.sessionId !== sessionId);
    else if (!ticket) index.tickets.push({ sessionId, attempts: 0, retryAt: nowIso() });
    index.cursor = index.tickets.length === 0 ? 0 : index.cursor % index.tickets.length;
    atomicWriteJsonSync(file, index);
  });
}
function newAction(name: SessionEndActionName, actionClass: 'required' | 'best-effort', payload: Record<string, unknown>): SessionEndActionState { return { class: actionClass, phase: actionClass === 'required' ? 'deferred-required' : 'deferred-best-effort', status: 'pending', attempts: 0, idempotencyKey: digest([name, payload]), payload, budgetMs: actionClass === 'required' ? 9_000 : 2_000 }; }

/** Terminality is solely a manifest property. Discovery tickets are deliberately excluded. */
export function isManifestTerminal(job: SessionEndJobV1): boolean { return ['sealed', 'no-op'].includes(job.producers.core.state) && ['sealed', 'no-op'].includes(job.producers.wiki.state) && Object.values(job.actions).every((action) => action.status === 'completed' || action.status === 'expired') && job.owner === null && Object.values(job.actions).every((action) => !action.runner || action.runner.phase === 'terminal'); }
export function readSessionEndJob(directory: string, sessionId: string): SessionEndJobV1 | null { try { return readPath(sessionEndJobPath(directory, sessionId)); } catch { return null; } }

/** Locked expected-revision CAS with an exact post-write reread. */
export function mutateSessionEndJob(directory: string, sessionId: string, expectedRevision: number, mutate: (job: SessionEndJobV1) => void): SessionEndJobV1 | null {
  let terminal = false;
  try {
    const jobPath = sessionEndJobPath(directory, sessionId);
    const result = withLock(jobPath, () => {
      const current = readPath(jobPath);
      if (!current || current.revision !== expectedRevision) return null;
      mutate(current);
      const next: SessionEndJobV1 = { ...current, revision: current.revision + 1, updatedAt: nowIso() };
      if (isManifestTerminal(next) && next.phase !== 'complete') { next.phase = 'complete'; next.completion = { completedAt: next.updatedAt, terminalDigest: digest({ producers: next.producers, actions: next.actions }), terminalRevision: next.revision }; }
      atomicWriteJsonSync(jobPath, next);
      const reread = readPath(jobPath);
      if (!reread || reread.revision !== next.revision || digest(reread) !== digest(next)) throw new Error('session-end-manifest-reread-mismatch');
      terminal = reread.phase === 'complete';
      return reread;
    });
    if (result && terminal) acknowledgeSessionEndDiscoveryTicket(directory, sessionId);
    return result;
  } catch { return null; }
}
function mutateLatest(directory: string, sessionId: string, mutate: (job: SessionEndJobV1) => void): SessionEndJobV1 | null { for (let i = 0; i < 8; i++) { const current = readSessionEndJob(directory, sessionId); if (!current) return null; const result = mutateSessionEndJob(directory, sessionId, current.revision, mutate); if (result) return result; } return null; }

export function prepareCoreManifest(directory: string, sessionId: string, payload: Record<string, unknown>): SessionEndJobV1 | null {
  const durablePayload = withOpenClawRouting(payload);
  let jobPath: string; try { jobPath = sessionEndJobPath(directory, sessionId); } catch { return null; }
  try {
    const result = withLock(jobPath, () => {
      const existing = readPath(jobPath);
      if (existing) {
        if (existing.phase === 'complete' || existing.producers.core.state !== 'absent') return existing;
        const next = { ...existing, producers: { ...existing.producers, core: { state: 'prepared' as const, intentKey: digest(durablePayload), payloadDigest: digest(durablePayload) } }, actions: { ...existing.actions }, revision: existing.revision + 1, updatedAt: nowIso() };
        for (const [name, action] of Object.entries(next.actions)) if (name !== 'wiki-capture') action.payload = durablePayload;
        atomicWriteJsonSync(jobPath, next); const reread = readPath(jobPath); if (!reread || reread.revision !== next.revision) throw new Error('session-end-manifest-reread-mismatch'); return reread;
      }
      const now = nowIso(); const actions = Object.fromEntries(ACTIONS.map(([name, klass]) => [name, newAction(name, klass, durablePayload)])) as SessionEndJobV1['actions'];
      const job: SessionEndJobV1 = { version: 1, jobId: randomUUID(), sessionId, scopeKey: digest(directory), revision: 0, createdAt: now, updatedAt: now, ...initialDeadlines(), producers: { core: { state: 'prepared', intentKey: digest(durablePayload), payloadDigest: digest(durablePayload) }, wiki: { state: 'absent' } }, actions, owner: null, phase: 'collecting' };
      atomicWriteJsonSync(jobPath, job); return readPath(jobPath);
    });
    if (result) updateTicket(directory, sessionId, true);
    return result;
  } catch { return null; }
}
/** Foreground cleanup is idempotent local work; its durable result is the prerequisite for producer-grace sealing. */
export function completeForegroundCleanup(directory: string, sessionId: string, outcome: Record<string, unknown>): SessionEndJobV1 | null {
  return mutateLatest(directory, sessionId, job => {
    const action = job.actions['foreground-cleanup'];
    if (action.status === 'completed') return;
    if (action.status !== 'pending' && action.status !== 'retryable') throw new Error('foreground-cleanup-conflict');
    action.status = 'completed'; action.completedAt = nowIso(); action.lastOutcomeCode = 'completed'; action.payload = { ...action.payload, foregroundResult: outcome };
  });
}
export function completeForegroundCleanupAndSealCore(
  directory: string,
  sessionId: string,
  outcome: Record<string, unknown>,
): SessionEndJobV1 | null {
  return mutateLatest(directory, sessionId, (job) => {
    const action = job.actions['foreground-cleanup'];
    if (action.status !== 'completed') {
      if (action.status !== 'pending' && action.status !== 'retryable') throw new Error('foreground-cleanup-conflict');
      action.status = 'completed';
      action.completedAt = nowIso();
      action.lastOutcomeCode = 'completed';
      action.payload = { ...action.payload, foregroundResult: outcome };
    }
    if (job.phase !== 'complete' && job.producers.core.state !== 'sealed') {
      job.producers.core = { ...job.producers.core, state: 'sealed', sealedAt: nowIso(), sealedBy: 'foreground' };
      if (job.phase === 'collecting') job.phase = 'ready';
    }
  });
}
export function sealCoreManifest(directory: string, sessionId: string): SessionEndJobV1 | null { return mutateLatest(directory, sessionId, (job) => { if (job.phase !== 'complete' && job.producers.core.state !== 'sealed') { job.producers.core = { ...job.producers.core, state: 'sealed', sealedAt: nowIso(), sealedBy: 'foreground' }; if (job.phase === 'collecting') job.phase = 'ready'; } }); }
export function sealWikiManifest(directory: string, sessionId: string, payload?: Record<string, unknown>): SessionEndJobV1 | null {
  let jobPath: string; try { jobPath = sessionEndJobPath(directory, sessionId); } catch { return null; }
  try {
    const result = withLock(jobPath, () => {
      const existing = readPath(jobPath);
      if (!existing) {
        const now = nowIso();
        const actions = Object.fromEntries(ACTIONS.map(([name, klass]) => [name, newAction(name, klass, {})])) as SessionEndJobV1['actions'];
        const wiki = payload ? { state: 'sealed' as const, intentKey: digest(payload), payloadDigest: digest(payload), sealedAt: now, sealedBy: 'wiki-producer' as const } : { state: 'no-op' as const, sealedAt: now, sealedBy: 'wiki-producer' as const };
        if (payload) actions['wiki-capture'].payload = payload; else { actions['wiki-capture'].status = 'completed'; actions['wiki-capture'].completedAt = now; }
        const job: SessionEndJobV1 = { version: 1, jobId: randomUUID(), sessionId, scopeKey: digest(directory), revision: 0, createdAt: now, updatedAt: now, ...initialDeadlines(), producers: { core: { state: 'absent' }, wiki }, actions, owner: null, phase: 'collecting' };
        atomicWriteJsonSync(jobPath, job); return readPath(jobPath);
      }
      if (existing.phase === 'complete' || ['sealed', 'no-op'].includes(existing.producers.wiki.state)) return existing;
      const now = nowIso(); const next = structuredClone(existing); next.revision++; next.updatedAt = now;
      next.producers.wiki = payload ? { state: 'sealed', intentKey: digest(payload), payloadDigest: digest(payload), sealedAt: now, sealedBy: 'wiki-producer' } : { state: 'no-op', sealedAt: now, sealedBy: 'wiki-producer' };
      if (payload) next.actions['wiki-capture'].payload = payload; else { next.actions['wiki-capture'].status = 'completed'; next.actions['wiki-capture'].completedAt = now; }
      atomicWriteJsonSync(jobPath, next); return readPath(jobPath);
    });
    if (result) updateTicket(directory, sessionId, true);
    return result;
  } catch { return null; }
}
export function claimSessionEndJob(directory: string, sessionId: string, nonce: string, identity: string, deadlineAt: number): SessionEndJobV1 | null { const current = readSessionEndJob(directory, sessionId); if (!current) return null; const now = Date.now(); return mutateSessionEndJob(directory, sessionId, current.revision, (job) => { if (job.phase === 'complete' || job.owner) throw new Error('claim-conflict'); job.owner = { nonce, pid: process.pid, processStartIdentity: identity, claimedAt: nowIso(), heartbeatAt: nowIso(), leaseExpiresAt: new Date(Math.min(now + 750, deadlineAt)).toISOString(), runDeadlineAt: new Date(deadlineAt).toISOString(), leaseGeneration: 1, claimedFromRevision: job.revision }; job.phase = 'processing'; }); }
export function renewSessionEndLease(directory: string, sessionId: string, nonce: string, generation: number, deadlineAt: number): SessionEndJobV1 | null { const current = readSessionEndJob(directory, sessionId); if (!current) return null; return mutateSessionEndJob(directory, sessionId, current.revision, (job) => { const owner = job.owner; if (!owner || owner.nonce !== nonce || owner.leaseGeneration !== generation) throw new Error('lease-conflict'); owner.leaseGeneration++; owner.heartbeatAt = nowIso(); owner.leaseExpiresAt = new Date(Math.min(Date.now() + 750, deadlineAt)).toISOString(); }); }
/** Reaping is intentionally separate from a new claim. Caller must establish dead or PID-reused identity. */
export function reapStaleSessionEndOwner(directory: string, sessionId: string, expectedNonce: string, expectedGeneration: number, liveness: 'dead' | 'mismatch'): SessionEndJobV1 | null { const current = readSessionEndJob(directory, sessionId); if (!current || Date.now() < Date.parse(current.owner?.leaseExpiresAt ?? '')) return null; return mutateSessionEndJob(directory, sessionId, current.revision, (job) => { if (!job.owner || job.owner.nonce !== expectedNonce || job.owner.leaseGeneration !== expectedGeneration || Date.now() < Date.parse(job.owner.leaseExpiresAt) || (liveness !== 'dead' && liveness !== 'mismatch')) throw new Error('reap-conflict'); if (Object.values(job.actions).some(action => action.status === 'claimed' && action.runner && action.runner.phase !== 'terminal' && Date.now() < Date.parse(action.runner.deadlineAt))) throw new Error('runner-still-bounded'); for (const action of Object.values(job.actions)) { if (action.status === 'claimed' && action.claimantNonce === expectedNonce) { action.status = action.class === 'best-effort' ? 'expired' : 'retryable'; action.claimantNonce = undefined; action.lastOutcomeCode = action.class === 'best-effort' ? 'delivery-uncertain-owner-reaped' : 'owner-reaped'; if (action.runner) action.runner.phase = 'terminal'; } } job.owner = null; job.phase = 'recoverable-failure'; }); }
export function releaseSessionEndJob(directory: string, sessionId: string, nonce: string, generation: number): SessionEndJobV1 | null { const current = readSessionEndJob(directory, sessionId); if (!current) return null; return mutateSessionEndJob(directory, sessionId, current.revision, (job) => { if (!job.owner || job.owner.nonce !== nonce || job.owner.leaseGeneration !== generation) throw new Error('release-conflict'); job.owner = null; if (job.phase !== 'complete') job.phase = 'recoverable-failure'; }); }
export function updateSessionEndJob(directory: string, sessionId: string, expectedOwner: string, mutate: (job: SessionEndJobV1) => void): SessionEndJobV1 | null { const current = readSessionEndJob(directory, sessionId); if (!current) return null; return mutateSessionEndJob(directory, sessionId, current.revision, (job) => { if (job.owner?.nonce !== expectedOwner || job.phase === 'complete') throw new Error('owner-conflict'); mutate(job); }); }
export function claimSessionEndAction(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, deadlineAt: number): SessionEndJobV1 | null { return updateSessionEndJob(directory, sessionId, ownerNonce, (job) => { const action = job.actions[name]; if (!action || !['pending', 'retryable'].includes(action.status) || action.claimantNonce) throw new Error('action-claim-conflict'); if (action.class === 'best-effort' && action.attempts > 0) { action.status = 'expired'; action.lastOutcomeCode = 'delivery-attempted'; return; } if ((action.class === 'required' && (action.attempts >= REQUIRED_ACTION_MAX_ATTEMPTS || Date.now() >= Date.parse(job.bestEffortDeadlineAt))) || (action.class === 'best-effort' && Date.now() >= Date.parse(job.bestEffortDeadlineAt))) { action.status = 'expired'; action.lastOutcomeCode = action.class === 'required' ? action.attempts >= REQUIRED_ACTION_MAX_ATTEMPTS ? 'required-attempt-limit' : 'required-deadline-expired' : 'deadline-expired'; return; } action.status = 'claimed'; action.attempts++; action.claimantNonce = ownerNonce; action.claimedAt = nowIso(); action.runner = { attempt: action.attempts, runnerNonce: randomUUID(), phase: 'reserved', deadlineAt: new Date(deadlineAt).toISOString() }; }); }
export function markSessionEndActionRunner(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, runnerNonce: string, phase: 'started' | 'armed' | 'result-recorded'): SessionEndJobV1 | null { return updateSessionEndJob(directory, sessionId, ownerNonce, (job) => { const action = job.actions[name]; if (action.status !== 'claimed' || action.runner?.runnerNonce !== runnerNonce) throw new Error('runner-phase-conflict'); action.runner.phase = phase; }); }
export function finishSessionEndAction(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, runnerNonce: string, completed: boolean, code: string): SessionEndJobV1 | null { return updateSessionEndJob(directory, sessionId, ownerNonce, (job) => { const action = job.actions[name]; if (action.status !== 'claimed' || action.claimantNonce !== ownerNonce || action.runner?.runnerNonce !== runnerNonce) throw new Error('action-result-conflict'); action.status = completed ? 'completed' : action.class === 'best-effort' ? 'expired' : 'retryable'; action.lastOutcomeCode = code; action.completedAt = completed ? nowIso() : undefined; action.claimantNonce = undefined; action.runner.phase = 'terminal'; }); }
/** Claims fair durable discovery tickets and retires tickets whose manifests are terminal. */
export function claimSessionEndDiscoveryTickets(directory: string, limit = 4, leaseMs = 15_000): Array<{ sessionId: string; nonce: string }> {
  try { const file = discoveryPath(directory); if (!fs.existsSync(file)) return []; const claimed = withLock(file, () => {
    const index = readIndex(file); const now = Date.now(); const claimed: Array<{ sessionId: string; nonce: string }> = [];
    for (let offset = 0; offset < index.tickets.length && claimed.length < Math.max(0, limit); offset++) {
      const ticket = index.tickets[(index.cursor + offset) % index.tickets.length];
      if (ticket.acknowledgedAt) continue;
      const job = readSessionEndJob(directory, ticket.sessionId);
      if (job?.phase === 'complete' || (job && isManifestTerminal(job))) { ticket.acknowledgedAt = nowIso(); ticket.claimNonce = undefined; ticket.leaseExpiresAt = undefined; continue; }
      const leased = ticket.leaseExpiresAt && Date.parse(ticket.leaseExpiresAt) > now;
      if (leased || Date.parse(ticket.retryAt) > now) continue;
      const nonce = randomUUID(); ticket.claimNonce = nonce; ticket.leaseExpiresAt = new Date(now + leaseMs).toISOString(); claimed.push({ sessionId: ticket.sessionId, nonce });
    }
    index.cursor = index.tickets.length ? (index.cursor + Math.max(1, claimed.length)) % index.tickets.length : 0; atomicWriteJsonSync(file, index); return claimed;
  });
  return claimed;
  } catch { return []; }
}
export function releaseSessionEndDiscoveryTicket(directory: string, sessionId: string, nonce: string, spawned: boolean): void {
  try { const file = discoveryPath(directory); withLock(file, () => { const index = readIndex(file); const ticket = index.tickets.find(item => item.sessionId === sessionId); if (!ticket || ticket.claimNonce !== nonce) return; ticket.claimNonce = undefined; ticket.leaseExpiresAt = undefined; if (!spawned) { ticket.attempts++; ticket.retryAt = new Date(Date.now() + Math.min(30_000, 250 * 2 ** Math.min(ticket.attempts, 7))).toISOString(); } else ticket.retryAt = nowIso(); atomicWriteJsonSync(file, index); }); } catch { /* recovery retries lease expiry */ }
}
export function acknowledgeSessionEndDiscoveryTicket(directory: string, sessionId: string): void { try { const file = discoveryPath(directory); withLock(file, () => { const index = readIndex(file); const ticket = index.tickets.find(item => item.sessionId === sessionId); if (!ticket) return; ticket.acknowledgedAt = nowIso(); ticket.claimNonce = undefined; ticket.leaseExpiresAt = undefined; atomicWriteJsonSync(file, index); }); } catch { /* terminal ticket remains safely rediscoverable */ } }
/** Compatibility read-only page retained for callers that do not claim tickets. */
export function takeSessionEndDiscoveryPage(directory: string, limit = 4): string[] { return claimSessionEndDiscoveryTickets(directory, limit).map(ticket => ticket.sessionId); }


/** Recovery may seal a prepared core only after foreground cleanup has a durable completed result. */
export function recoverPreparedCoreProducer(directory: string, sessionId: string): SessionEndJobV1 | null {
  return mutateLatest(directory, sessionId, job => {
    if (!['prepared', 'sealed'].includes(job.producers.core.state) || Date.now() < Date.parse(job.producerGraceExpiresAt)) return;
    const foreground = job.actions['foreground-cleanup'];
    if (foreground?.status !== 'completed') return;
    if (job.producers.core.state === 'prepared') job.producers.core = { ...job.producers.core, state: 'sealed', sealedAt: nowIso(), sealedBy: 'recovery' };
    if (job.producers.wiki.state === 'absent') {
      job.producers.wiki = { state: 'no-op', sealedAt: nowIso(), sealedBy: 'recovery' };
      const wikiCapture = job.actions['wiki-capture'];
      if (wikiCapture.status === 'pending' || wikiCapture.status === 'retryable') {
        wikiCapture.status = 'completed';
        wikiCapture.completedAt = nowIso();
        wikiCapture.lastOutcomeCode = 'producer-absent';
      }
    }
    if (job.phase === 'collecting') job.phase = 'ready';
  });
}

/** A prepared core cannot be recovered once its foreground prerequisite is exhausted after grace. */
export function failClosedExhaustedForegroundCleanup(directory: string, sessionId: string): SessionEndJobV1 | null {
  return mutateLatest(directory, sessionId, job => {
    const foreground = job.actions['foreground-cleanup'];
    const exhausted = foreground.status === 'expired'
      || (foreground.status === 'retryable' && foreground.attempts >= REQUIRED_ACTION_MAX_ATTEMPTS);
    if (job.producers.core.state !== 'prepared' || Date.now() < Date.parse(job.producerGraceExpiresAt) || !exhausted) return;

    const evidence = {
      reason: 'foreground-cleanup-exhausted',
      attempts: foreground.attempts,
      outcomeCode: foreground.lastOutcomeCode,
    };
    job.producers.core = { ...job.producers.core, state: 'no-op', sealedAt: nowIso(), sealedBy: 'recovery' };
    if (job.producers.wiki.state === 'absent') job.producers.wiki = { state: 'no-op', sealedAt: nowIso(), sealedBy: 'recovery' };
    for (const [name, action] of Object.entries(job.actions) as Array<[SessionEndActionName, SessionEndActionState]>) {
      if (action.status !== 'pending' && action.status !== 'retryable') continue;
      action.status = 'expired';
      action.lastOutcomeCode = name === 'foreground-cleanup'
        ? 'required-foreground-cleanup-exhausted'
        : action.class === 'required'
          ? 'required-core-producer-unavailable'
          : 'best-effort-core-producer-unavailable';
      action.payload = { ...action.payload, terminalization: evidence };
      if (action.runner) action.runner.phase = 'terminal';
    }
    if (job.phase === 'collecting') job.phase = 'ready';
  });
}

/** A wiki-only handoff cannot safely infer the missing core cleanup intent. */
export function failClosedMissingCoreProducer(directory: string, sessionId: string): SessionEndJobV1 | null {
  return mutateLatest(directory, sessionId, job => {
    if (job.producers.core.state !== 'absent' || !['sealed', 'no-op'].includes(job.producers.wiki.state) || Date.now() < Date.parse(job.producerGraceExpiresAt)) return;
    job.producers.core = { state: 'no-op', sealedAt: nowIso(), sealedBy: 'recovery' };
    for (const [name, action] of Object.entries(job.actions) as Array<[SessionEndActionName, SessionEndActionState]>) {
      if (name === 'wiki-capture' || (action.status !== 'pending' && action.status !== 'retryable')) continue;
      action.status = 'expired';
      action.lastOutcomeCode = action.class === 'required' ? 'required-core-producer-absent' : 'best-effort-core-producer-absent';
    }
    if (job.phase === 'collecting') job.phase = 'ready';
  });
}
