import { createHash, randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'node:child_process';

import { getNativeContainedFs } from '../graph/runtime/native-contained-fs.js';
import type { TeamConfig, TeamRecoveryAttempt, TeamRuntimeOwnerEpoch } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';

export interface OwnerFence {
  epoch: number;
  nonce: string;
}

export interface OwnerEpochRecord extends TeamRuntimeOwnerEpoch {
  schema_version: 1;
  heartbeat?: { observed_at: string; detail?: string };
  payload_hash: string;
}

export interface OwnerEpochInput {
  pid?: number;
  processStartedAt?: string;
  nonce?: string;
  heartbeat?: OwnerEpochRecord['heartbeat'];
}

export type OwnerFenceCheck = { ok: true; record: OwnerEpochRecord } | { ok: false; reason: 'missing' | 'malformed' | 'superseded' | 'mismatch' };

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function recordBytes(record: Omit<OwnerEpochRecord, 'payload_hash'>): string {
  const payloadHash = digest(record);
  return canonicalize({ ...record, payload_hash: payloadHash });
}

function parseRecord(path: string, expectedEpoch?: number): OwnerEpochRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as OwnerEpochRecord;
    if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1
      || (expectedEpoch !== undefined && parsed.epoch !== expectedEpoch)
      || typeof parsed.nonce !== 'string' || typeof parsed.pid !== 'number'
      || !isValidProcessStartIdentity(parsed.process_started_at) || typeof parsed.payload_hash !== 'string') return null;
    const { payload_hash, ...unsigned } = parsed;
    return digest(unsigned) === payload_hash ? parsed : null;
  } catch {
    return null;
  }
}

function darwinProcessStartFromKinfo(raw: Buffer, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  // `kern.proc.pid` returns `struct kinfo_proc`; its first member is `extern_proc`,
  // whose documented leading union is `timeval p_starttime` on supported 64-bit Darwin.
  if (raw.length < 16) return null;
  const seconds = raw.readBigUInt64LE(0);
  const micros = raw.readBigUInt64LE(8);
  if (seconds < 946684800n || seconds > BigInt(nowSeconds + 86400) || micros >= 1_000_000n) return null;
  return `${seconds}:${micros}`;
}

export function processStartIdentityForPlatform(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: typeof execFileSync = execFileSync,
): string | null {
  return probeProcessStartIdentityForPlatform(pid, platform, exec, readFileSync, false).identity;
}

interface ProcessStartIdentityProbe {
  identity: string | null;
  precise: boolean;
}

function darwinProcessStartIdentityFromNative(pid: number): string | null {
  try {
    const native = getNativeContainedFs();
    if (typeof native.processStartTime !== 'function') return null;
    const started = native.processStartTime(pid);
    if (!started || typeof started !== 'object' || Array.isArray(started)
      || !Number.isSafeInteger(started.seconds) || started.seconds < 946684800
      || started.seconds > Math.floor(Date.now() / 1000) + 86400
      || !Number.isSafeInteger(started.microseconds) || started.microseconds < 1
      || started.microseconds >= 1_000_000) return null;
    return `darwin:${started.seconds}:${started.microseconds}`;
  } catch {
    // A missing addon, old addon, or failed kernel probe is unknown.
    return null;
  }
}

/**
 * Shared process-creation probes used by both the historical owner-election
 * format and the strict resource-ownership format.  The owner-election
 * format intentionally retains its Darwin `ps` fallback for compatibility;
 * destructive resource matching calls this same probe in strict mode, where
 * that fallback is reported as unavailable instead.
 */
function probeProcessStartIdentityForPlatform(
  pid: number,
  platform: NodeJS.Platform,
  exec: typeof execFileSync,
  read: typeof readFileSync,
  strict: boolean,
): ProcessStartIdentityProbe {
  if (!Number.isSafeInteger(pid) || pid < 1) return { identity: null, precise: false };
  try {
    if (platform === 'linux') {
      const stat = read(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const ticks = fields[19];
      if (!ticks) return { identity: null, precise: false };
      if (!strict) return { identity: `linux:${ticks}`, precise: false };
      if (!/^[1-9]\d*$/.test(ticks)) return { identity: null, precise: false };
      const bootId = String(read('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bootId)) {
        return { identity: null, precise: false };
      }
      return { identity: `linux:${bootId}:${ticks}`, precise: true };
    }
    if (platform === 'win32') {
      if (strict) return { identity: null, precise: false };
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const ticks = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', windowsHide: true }).trim();
      return /^\d+$/.test(ticks)
        ? { identity: `win32:${ticks}`, precise: true }
        : { identity: null, precise: false };
    }
    if (platform === 'darwin') {
      if (strict) {
        const identity = darwinProcessStartIdentityFromNative(pid);
        return identity ? { identity, precise: true } : { identity: null, precise: false };
      }
      try {
        const raw = exec('/usr/sbin/sysctl', ['-b', `kern.proc.pid.${pid}`], {
          encoding: null, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const birth = darwinProcessStartFromKinfo(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        if (birth) return { identity: `darwin:${birth}`, precise: true };
      } catch {
        // Fall through to the historical portable process listing.
      }
      const started = exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }).trim();
      const startedAtMs = Date.parse(started);
      return started && Number.isFinite(startedAtMs)
        ? { identity: `darwin:${Math.floor(startedAtMs / 1000)}:0`, precise: false }
        : { identity: null, precise: false };
    }
    if (strict) return { identity: null, precise: false };
    const started = exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return started
      ? { identity: `${platform}:${started}`, precise: false }
      : { identity: null, precise: false };
  } catch {
    return { identity: null, precise: false };
  }
}

export function isValidProcessStartIdentity(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  if (platform === 'linux') return /^linux:[1-9]\d*$/.test(value);
  if (platform === 'win32') return /^win32:[1-9]\d*$/.test(value);
  if (platform === 'darwin') {
    const match = /^darwin:([1-9]\d*):(\d+)$/.exec(value);
    return match !== null && Number(match[2]) < 1_000_000;
  }
  const separator = value.indexOf(':');
  return separator > 0 && value.slice(0, separator) === platform
    && value.slice(separator + 1).length > 0 && !/[\u0000-\u001f\u007f]/.test(value.slice(separator + 1));
}

/**
 * Return a process creation token suitable for destructive resource
 * ownership.  Unlike `processStartIdentityForPlatform`, this never uses the
 * Darwin second-resolution `ps` fallback and includes Linux boot identity so
 * PID/start-tick reuse after reboot cannot match.
 */
export function strictProcessStartIdentityForPlatform(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: typeof execFileSync = execFileSync,
  read: typeof readFileSync = readFileSync,
): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return null;
  const result = probeProcessStartIdentityForPlatform(pid, platform, exec, read, true);
  return result.precise ? result.identity : null;
}

/** Alias describing the strict token in creation-identity terminology. */
export const processCreationIdentityForPlatform = strictProcessStartIdentityForPlatform;

export function isValidStrictProcessStartIdentity(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  if (platform === 'linux') {
    return /^linux:[A-Za-z0-9][A-Za-z0-9._-]*:[1-9]\d*$/.test(value);
  }
  if (platform === 'darwin') {
    const match = /^darwin:([1-9]\d*):(\d+)$/.exec(value);
    // A zero-microsecond Darwin token is indistinguishable from the legacy
    // second-resolution fallback and is not destructive evidence.
    return match !== null && Number(match[2]) > 0 && Number(match[2]) < 1_000_000;
  }
  return false;
}

export function currentProcessStartIdentity(pid: number = process.pid): string | null {
  return processStartIdentityForPlatform(pid);
}

export function currentStrictProcessStartIdentity(pid: number = process.pid): string | null {
  return strictProcessStartIdentityForPlatform(pid);
}

/** Alias used by tmux resource ownership callers. */
export const currentProcessCreationIdentity = currentStrictProcessStartIdentity;

export type ProcessIdentityObservation = 'matching' | 'dead' | 'unknown';

/**
 * Observe one strict process incarnation.  `unknown` is deliberately
 * distinct from `dead`: an unavailable or coarse probe never authorizes
 * destructive cleanup.
 */
export function observeProcessIdentity(
  record: Pick<TeamRuntimeOwnerEpoch, 'pid' | 'process_started_at'>,
): ProcessIdentityObservation {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1
    || !isValidStrictProcessStartIdentity(record.process_started_at)) return 'unknown';
  try {
    process.kill(record.pid, 0);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  const observed = currentStrictProcessStartIdentity(record.pid);
  if (!observed || !isValidStrictProcessStartIdentity(observed)) return 'unknown';
  return observed === record.process_started_at ? 'matching' : 'dead';
}

function processStartIdentitiesMayMatch(recorded: string, observed: string): boolean {
  if (recorded === observed) return true;
  const recordedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(recorded);
  const observedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(observed);
  return recordedDarwin !== null && observedDarwin !== null
    && recordedDarwin[1] === observedDarwin[1]
    && (recordedDarwin[2] === '0' || observedDarwin[2] === '0');
}


export function isProcessIdentityDead(record: Pick<OwnerEpochRecord, 'pid' | 'process_started_at'>): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !isValidProcessStartIdentity(record.process_started_at)) return false;
  try {
    process.kill(record.pid, 0);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const observed = currentProcessStartIdentity(record.pid);
  // Unknown or malformed identity is never positive proof of death.
  return isValidProcessStartIdentity(observed) && !processStartIdentitiesMayMatch(record.process_started_at, observed);
}

export function readLatestOwnerEpoch(cwd: string, teamName: string): OwnerEpochRecord | null {
  const directory = absPath(cwd, TeamPaths.ownerEpochs(teamName));
  if (!existsSync(directory)) return null;
  const epochs = readdirSync(directory)
    .map((name) => /^([1-9]\d*)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  const latestEpoch = epochs[0];
  if (latestEpoch === undefined) return null;
  const record = parseRecord(join(directory, `${latestEpoch}.json`), latestEpoch);
  if (!record) throw new Error('invalid_owner_epoch_record');
  return record;
}

/** Publish a complete, canonical epoch through a hard link. Epoch files are never reclaimed. */
export function publishOwnerEpoch(cwd: string, teamName: string, epoch: number, input: OwnerEpochInput = {}): OwnerEpochRecord {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid_owner_epoch');
  const target = absPath(cwd, TeamPaths.ownerEpoch(teamName, epoch));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const start = input.processStartedAt ?? currentProcessStartIdentity(input.pid ?? process.pid);
  if (!isValidProcessStartIdentity(start)) throw new Error('process_start_identity_unavailable');
  const unsigned = {
    schema_version: 1 as const,
    epoch,
    nonce: input.nonce ?? randomUUID(),
    pid: input.pid ?? process.pid,
    process_started_at: start,
    created_at: new Date().toISOString(),
    ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
  };
  const bytes = recordBytes(unsigned);
  const record = JSON.parse(bytes) as OwnerEpochRecord;
  const temp = join(dirname(target), `.${epoch}.${record.nonce}.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });
  try {
    linkSync(temp, target);
  } catch (error: unknown) {
    const existing = parseRecord(target, epoch);
    try { unlinkSync(temp); } catch { /* unique losing temp cleanup is best-effort */ }
    // A competing successor won this epoch. Returning its verified record makes the loser
    // observe the fence it does not hold rather than attempting deletion or reclamation.
    if (existing) return existing;
    throw error;
  }
  const verified = parseRecord(target, epoch);
  if (!verified || canonicalize(verified) !== bytes) throw new Error('owner_epoch_publication_verification_failed');
  // Verification precedes unlinking only the successful temporary alias.
  unlinkSync(temp);
  return verified;
}

export function requireOwnerProcessIdentity(
  record: OwnerEpochRecord,
  pid = process.pid,
  processStartedAt = currentProcessStartIdentity(pid),
): OwnerEpochRecord {
  if (!processStartedAt || record.pid !== pid || record.process_started_at !== processStartedAt) {
    throw new Error('runtime_owner_fence_lost');
  }
  return record;
}

export function acquireSuccessorOwnerEpoch(cwd: string, teamName: string, input: OwnerEpochInput = {}): OwnerEpochRecord {
  const latest = readLatestOwnerEpoch(cwd, teamName);
  if (latest && !isProcessIdentityDead(latest)) throw new Error('runtime_owner_not_confirmed_dead');
  return publishOwnerEpoch(cwd, teamName, (latest?.epoch ?? 0) + 1, input);
}

export function checkOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerFenceCheck {
  let latest: OwnerEpochRecord | null;
  try { latest = readLatestOwnerEpoch(cwd, teamName); } catch { return { ok: false, reason: 'malformed' }; }
  if (!latest) return { ok: false, reason: 'missing' };
  if (latest.epoch !== fence.epoch) return { ok: false, reason: 'superseded' };
  if (latest.nonce !== fence.nonce) return { ok: false, reason: 'mismatch' };
  return { ok: true, record: latest };
}

export function requireOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerEpochRecord {
  const result = checkOwnerFence(cwd, teamName, fence);
  if (!result.ok) throw new Error('runtime_owner_fence_lost');
  return result.record;
}

export function isFreshRecoveryElection(config: TeamConfig, fence: OwnerFence, expectedRevision: number): boolean {
  return config.state_revision === expectedRevision
    && config.lifecycle_state === 'active'
    && config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && !config.active_recovery;
}

export function isSameAttemptSuccessorRebind(config: TeamConfig, prior: TeamRuntimeOwnerEpoch, successor: OwnerFence, requestId: string, recoveryId: string): boolean {
  const active = config.active_recovery;
  return successor.epoch === prior.epoch + 1
    && isProcessIdentityDead(prior)
    && !!active
    && active.request_id === requestId
    && active.recovery_id === recoveryId
    && active.owner_epoch === prior.epoch
    && active.owner_nonce === prior.nonce;
}

export function isActiveRecoveryEffect(config: TeamConfig, fence: OwnerFence, requestId: string, recoveryId: string): boolean {
  const active: TeamRecoveryAttempt | undefined = config.active_recovery;
  return config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && active?.request_id === requestId
    && active.recovery_id === recoveryId
    && active.owner_epoch === fence.epoch
    && active.owner_nonce === fence.nonce;
}

export function isFencedServiceMaintenance(config: TeamConfig, fence: OwnerFence): boolean {
  const marker = (config as TeamConfig & { service_recovery?: OwnerFence }).service_recovery;
  return !config.active_recovery
    && config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && marker?.epoch === fence.epoch
    && marker.nonce === fence.nonce;
}
