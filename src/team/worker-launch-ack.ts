import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { getProcessStartIdentitySync, isProcessAlive, isProcessIdentityLive, terminateOwnedProcessTree } from '../platform/process-utils.js';
import type { CliAgentType } from './model-contract.js';
import { absPath, TeamPaths } from './state-paths.js';
import { atomicWriteJson } from '../lib/atomic-write.js';
import { lockPathFor, withFileLock } from '../lib/file-lock.js';

const WORKER_LAUNCH_SCHEMA_VERSION = 1 as const;
const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_DECISION_TIMEOUT_MS = 15_000;

const WORKER_LAUNCH_TRANSPORT_OWNER_KIND = 'worker_launch_transport_owner' as const;
const WORKER_LAUNCH_TRANSPORT_CLEANUP_KIND = 'worker_launch_transport_cleanup_complete' as const;
const WORKER_LAUNCH_BOOTSTRAP_DESCRIPTOR_FILE = 'bootstrap.json' as const;
const WORKER_LAUNCH_INTERNAL_ENV_KEYS = new Set([
  'OMC_WORKER_LAUNCH_SPEC',
  'OMC_WORKER_LAUNCH_SPEC_B64',
  'OMC_WORKER_LAUNCH_SPEC_FILE',
]);

interface WorkerLaunchIdentity {
  schema_version: typeof WORKER_LAUNCH_SCHEMA_VERSION;
  attempt_id: string;
  nonce: string;
  team_name: string;
  worker_name: string;
  pane_id: string;
  provider: CliAgentType;
  created_at: string;
}

interface WorkerLaunchTransportOwner extends WorkerLaunchIdentity {
  kind: typeof WORKER_LAUNCH_TRANSPORT_OWNER_KIND;
}

interface WorkerLaunchTransportCleanupComplete extends WorkerLaunchIdentity {
  kind: typeof WORKER_LAUNCH_TRANSPORT_CLEANUP_KIND;
  reason: string;
  written_at: string;
}

export type WorkerLaunchContext =
  | { kind: 'initial' }
  | {
    kind: 'recovery';
    recovery_id: string;
    replacement_generation: number;
    pane_attempt_id: string;
  };

interface WorkerLaunchAcknowledgement extends WorkerLaunchIdentity {
  kind: 'worker_launch_ack';
  written_at: string;
}

interface WorkerLaunchDecision extends WorkerLaunchIdentity {
  kind: 'worker_launch_decision';
  decision: 'accepted' | 'revoked';
  reason: string;
  written_at: string;
}

interface WorkerLaunchProviderStarted extends WorkerLaunchIdentity {
  kind: 'worker_launch_provider_started';
  pid: number | null;
  written_at: string;
  process_start_identity: string;
  supervisor_completion_path?: string;
}

export interface WorkerLaunchAttempt extends WorkerLaunchIdentity {
  currentPath: string;
  expectedPath: string;
  ackPath: string;
  decisionPath: string;
  startedPath: string;
  transportOwnerPath: string;
  bootstrapDescriptorPath: string;
  wrapperPath: string;
  transportCleanupCompletePath: string;
  runtimeCliPath: string;
  context?: WorkerLaunchContext;
}

export interface WorkerLaunchBootstrapSpec extends WorkerLaunchIdentity {
  current_path: string;
  expected_path: string;
  ack_path: string;
  decision_path: string;
  started_path: string;
  transport_owner_path: string;
  bootstrap_descriptor_path: string;
  wrapper_path: string;
  transport_cleanup_complete_path: string;
  provider_argv: string[];
  provider_env: Record<string, string>;
  cwd: string;
  decision_timeout_ms: number;
  release_after_spawn: boolean;
}

export type WorkerLaunchAcceptance =
  | { ok: true }
  | { ok: false; reason: 'ack_timeout' | 'ack_malformed' | 'ack_mismatch' | 'decision_conflict' | 'expected_record_invalid' | 'attempt_superseded' };

export type WorkerLaunchBootstrapResult =
  | { outcome: 'ran'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { outcome: 'invalid_spec' | 'expected_record_invalid' | 'ack_conflict' | 'decision_timeout' | 'revoked' | 'superseded' | 'provider_spawn_failed' | 'provider_cleanup_unverified' };

export interface ProviderSpawnInvocation {
  command: string;
  args: string[];
  batchScript?: string;
}

export interface MaterializedProviderSpawnInvocation {
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
  completionPath?: string;
}

export interface MaterializedWorkerLaunchTransport {
  wrapperPath: string;
  bootstrapDescriptorPath: string;
  wrapperRelativePath: string;
}

type JsonReadResult = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'value'; value: unknown };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isExactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isValidEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function normalizeProviderEnvironment(value: NodeJS.ProcessEnv | Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (WORKER_LAUNCH_INTERNAL_ENV_KEYS.has(key)) continue;
    if (!isValidEnvironmentKey(key)) throw new Error('worker_launch_provider_env_key_invalid');
    if (typeof entry !== 'string') throw new Error('worker_launch_provider_env_value_invalid');
    normalized[key] = entry;
  }
  return normalized;
}

function isValidProviderEnvironment(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => isValidEnvironmentKey(key)
    && !WORKER_LAUNCH_INTERNAL_ENV_KEYS.has(key) && typeof entry === 'string');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isProvider(value: unknown): value is CliAgentType {
  return value === 'claude' || value === 'codex' || value === 'gemini'
    || value === 'cursor' || value === 'grok' || value === 'antigravity';
}

function identityMatches(value: unknown, expected: WorkerLaunchIdentity): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<WorkerLaunchIdentity>;
  return record.schema_version === WORKER_LAUNCH_SCHEMA_VERSION
    && record.attempt_id === expected.attempt_id
    && record.nonce === expected.nonce
    && record.team_name === expected.team_name
    && record.worker_name === expected.worker_name
    && record.pane_id === expected.pane_id
    && record.provider === expected.provider
    && record.created_at === expected.created_at;
}

function isValidIdentity(value: unknown): value is WorkerLaunchIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<WorkerLaunchIdentity>;
  return record.schema_version === WORKER_LAUNCH_SCHEMA_VERSION
    && isUuid(record.attempt_id)
    && isUuid(record.nonce)
    && isExactText(record.team_name)
    && isExactText(record.worker_name)
    && isExactText(record.pane_id)
    && isProvider(record.provider)
    && typeof record.created_at === 'string'
    && Number.isFinite(Date.parse(record.created_at));
}

function isValidLaunchContext(value: unknown): value is WorkerLaunchContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<WorkerLaunchContext>;
  if (record.kind === 'initial') return true;
  return record.kind === 'recovery'
    && isExactText(record.recovery_id)
    && Number.isSafeInteger(record.replacement_generation)
    && Number(record.replacement_generation) >= 1
    && isExactText(record.pane_attempt_id);
}

function identityOf(attempt: WorkerLaunchIdentity): WorkerLaunchIdentity {
  return {
    schema_version: attempt.schema_version,
    attempt_id: attempt.attempt_id,
    nonce: attempt.nonce,
    team_name: attempt.team_name,
    worker_name: attempt.worker_name,
    pane_id: attempt.pane_id,
    provider: attempt.provider,
    created_at: attempt.created_at,
  };
}

async function readJson(path: string): Promise<JsonReadResult> {
  try {
    return { kind: 'value', value: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'malformed' };
  }
}

async function isCurrentLaunchIdentity(currentPath: string, identity: WorkerLaunchIdentity): Promise<boolean> {
  const current = await readJson(currentPath);
  return current.kind === 'value' && identityMatches(current.value, identity);
}

async function writeExclusiveAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

async function writeExclusiveTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

function resolvePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function prepareWorkerLaunchAttempt(input: {
  cwd: string;
  teamName: string;
  workerName: string;
  paneId: string;
  provider: CliAgentType;
  runtimeCliPath: string;
  context?: WorkerLaunchContext;
}): Promise<WorkerLaunchAttempt> {
  const attemptId = randomUUID();
  const identity: WorkerLaunchIdentity = {
    schema_version: WORKER_LAUNCH_SCHEMA_VERSION,
    attempt_id: attemptId,
    nonce: randomUUID(),
    team_name: input.teamName,
    worker_name: input.workerName,
    pane_id: input.paneId,
    provider: input.provider,
    created_at: new Date().toISOString(),
  };
  const attempt: WorkerLaunchAttempt = {
    ...identity,
    currentPath: absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName)),
    expectedPath: absPath(input.cwd, TeamPaths.workerLaunchExpected(input.teamName, input.workerName, attemptId)),
    ackPath: absPath(input.cwd, TeamPaths.workerLaunchAck(input.teamName, input.workerName, attemptId)),
    decisionPath: absPath(input.cwd, TeamPaths.workerLaunchDecision(input.teamName, input.workerName, attemptId)),
    startedPath: absPath(input.cwd, TeamPaths.workerLaunchStarted(input.teamName, input.workerName, attemptId)),
    transportOwnerPath: absPath(input.cwd, TeamPaths.workerLaunchTransportOwner(input.teamName, input.workerName, attemptId)),
    bootstrapDescriptorPath: absPath(input.cwd, TeamPaths.workerLaunchBootstrapDescriptor(input.teamName, input.workerName, attemptId)),
    wrapperPath: absPath(input.cwd, TeamPaths.workerLaunchWrapper(input.teamName, input.workerName, attemptId)),
    transportCleanupCompletePath: absPath(input.cwd, TeamPaths.workerLaunchTransportCleanupComplete(input.teamName, input.workerName, attemptId)),
    runtimeCliPath: input.runtimeCliPath,
    ...(input.context ? { context: input.context } : {}),
  };
  if (existsSync(attempt.expectedPath) || existsSync(attempt.ackPath)
    || existsSync(attempt.decisionPath) || existsSync(attempt.startedPath)
    || existsSync(attempt.transportOwnerPath) || existsSync(attempt.bootstrapDescriptorPath)
    || existsSync(attempt.wrapperPath) || existsSync(attempt.transportCleanupCompletePath)) {
    throw new Error('worker_launch_attempt_path_conflict');
  }
  await writeExclusiveAtomic(attempt.expectedPath, identity);
  try {
    await withFileLock(lockPathFor(attempt.currentPath), async () => {
      await atomicWriteJson(
        attempt.currentPath,
        {
          ...identity,
          runtime_cli_path: input.runtimeCliPath,
          ...(input.context ? { context: input.context } : {}),
        },
      );
    });
  } catch (error) {
    await unlink(attempt.expectedPath).catch(() => undefined);
    throw error;
  }
  return attempt;
}

export async function loadWorkerLaunchAttempt(input: {
  cwd: string;
  teamName: string;
  workerName: string;
  paneId: string;
  provider: CliAgentType;
  attemptId: string;
  runtimeCliPath: string;
}): Promise<WorkerLaunchAttempt | null> {
  const expectedPath = absPath(input.cwd, TeamPaths.workerLaunchExpected(input.teamName, input.workerName, input.attemptId));
  const expected = await readJson(expectedPath);
  if (expected.kind !== 'value' || !isValidIdentity(expected.value)) return null;
  const identity = expected.value;
  if (identity.attempt_id !== input.attemptId || identity.team_name !== input.teamName
    || identity.worker_name !== input.workerName || identity.pane_id !== input.paneId
    || identity.provider !== input.provider) return null;
  return {
    ...identity,
    currentPath: absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName)),
    expectedPath,
    ackPath: absPath(input.cwd, TeamPaths.workerLaunchAck(input.teamName, input.workerName, input.attemptId)),
    decisionPath: absPath(input.cwd, TeamPaths.workerLaunchDecision(input.teamName, input.workerName, input.attemptId)),
    startedPath: absPath(input.cwd, TeamPaths.workerLaunchStarted(input.teamName, input.workerName, input.attemptId)),
    transportOwnerPath: absPath(input.cwd, TeamPaths.workerLaunchTransportOwner(input.teamName, input.workerName, input.attemptId)),
    bootstrapDescriptorPath: absPath(input.cwd, TeamPaths.workerLaunchBootstrapDescriptor(input.teamName, input.workerName, input.attemptId)),
    wrapperPath: absPath(input.cwd, TeamPaths.workerLaunchWrapper(input.teamName, input.workerName, input.attemptId)),
    transportCleanupCompletePath: absPath(input.cwd, TeamPaths.workerLaunchTransportCleanupComplete(input.teamName, input.workerName, input.attemptId)),
    runtimeCliPath: input.runtimeCliPath,
  };
}

export async function loadCurrentWorkerLaunchAttempt(input: {
  cwd: string;
  teamName: string;
  workerName: string;
  provider: CliAgentType;
}): Promise<WorkerLaunchAttempt | null> {
  const currentPath = absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName));
  try {
    return await withFileLock(lockPathFor(currentPath), async () => {
      const current = await readJson(currentPath);
      if (current.kind !== 'value' || !isValidIdentity(current.value)) return null;
      const record = current.value as WorkerLaunchIdentity & { runtime_cli_path?: unknown; context?: unknown };
      if (record.team_name !== input.teamName || record.worker_name !== input.workerName
        || record.provider !== input.provider || !isExactText(record.runtime_cli_path)
        || (record.context !== undefined && !isValidLaunchContext(record.context))) return null;
      const attempt = await loadWorkerLaunchAttempt({
        cwd: input.cwd,
        teamName: input.teamName,
        workerName: input.workerName,
        paneId: record.pane_id,
        provider: input.provider,
        attemptId: record.attempt_id,
        runtimeCliPath: record.runtime_cli_path,
      });
      if (!attempt || !await isWorkerLaunchAttemptAccepted(attempt)
        || !await isWorkerLaunchProviderStarted(attempt)
        || !await isCurrentLaunchIdentity(currentPath, attempt)) return null;
      return {
        ...attempt,
        ...(record.context ? { context: record.context } : {}),
      };
    });
  } catch {
    return null;
  }
}

export function buildWorkerLaunchBootstrapSpec(
  attempt: WorkerLaunchAttempt,
  providerArgv: string[],
  cwd: string,
  options: { releaseAfterSpawn?: boolean; providerEnv?: NodeJS.ProcessEnv | Record<string, string> } = {},
): WorkerLaunchBootstrapSpec {
  return {
    ...identityOf(attempt),
    current_path: attempt.currentPath,
    expected_path: attempt.expectedPath,
    ack_path: attempt.ackPath,
    decision_path: attempt.decisionPath,
    started_path: attempt.startedPath,
    transport_owner_path: attempt.transportOwnerPath,
    bootstrap_descriptor_path: attempt.bootstrapDescriptorPath,
    wrapper_path: attempt.wrapperPath,
    transport_cleanup_complete_path: attempt.transportCleanupCompletePath,
    provider_argv: [...providerArgv],
    provider_env: normalizeProviderEnvironment(options.providerEnv),
    cwd,
    decision_timeout_ms: resolvePositiveInteger(process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS, DEFAULT_DECISION_TIMEOUT_MS),
    release_after_spawn: options.releaseAfterSpawn === true,
  };
}

function attemptTransportPathsAreDeterministic(attempt: WorkerLaunchAttempt): boolean {
  const expectedRoot = dirname(attempt.expectedPath);
  return isDeterministicTransportPath(attempt.expectedPath, attempt.transportOwnerPath, 'transport-owner.json')
    && isDeterministicTransportPath(attempt.expectedPath, attempt.bootstrapDescriptorPath, WORKER_LAUNCH_BOOTSTRAP_DESCRIPTOR_FILE)
    && isDeterministicTransportPath(attempt.expectedPath, attempt.wrapperPath, 'launch.cmd')
    && isDeterministicTransportPath(attempt.expectedPath, attempt.transportCleanupCompletePath, 'transport-cleanup-complete.json')
    && resolve(attempt.expectedPath) === resolve(join(expectedRoot, 'expected.json'));
}

function transportOwnerMatches(value: unknown, attempt: WorkerLaunchIdentity): value is WorkerLaunchTransportOwner {
  return identityMatches(value, attempt)
    && typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === WORKER_LAUNCH_TRANSPORT_OWNER_KIND;
}

function cleanupProofMatches(value: unknown, attempt: WorkerLaunchIdentity): value is WorkerLaunchTransportCleanupComplete {
  return identityMatches(value, attempt)
    && typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === WORKER_LAUNCH_TRANSPORT_CLEANUP_KIND
    && isExactText((value as { reason?: unknown }).reason)
    && typeof (value as { written_at?: unknown }).written_at === 'string'
    && Number.isFinite(Date.parse((value as { written_at: string }).written_at));
}

function windowsWrapperRelativePath(cwd: string, wrapperPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(wrapperPath)).replace(/\//g, '\\');
  if (!relativePath || relativePath.startsWith('\\') || /^[A-Za-z]:/.test(relativePath)
    || !/^[A-Za-z0-9._\\-]+$/.test(relativePath)) {
    throw new Error('worker_launch_transport_relative_path_invalid');
  }
  return relativePath;
}

function buildWorkerLaunchWrapper(attempt: WorkerLaunchAttempt): string {
  const runtimeCli = quoteWindowsCmdArgument(attempt.runtimeCliPath);
  const nodeExecutable = quoteWindowsCmdArgument(process.execPath);
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "OMC_WORKER_LAUNCH_SPEC_FILE=%~dp0bootstrap.json"',
    `${nodeExecutable} ${runtimeCli} --worker-launch`,
    'set "_OMC_WORKER_LAUNCH_EXIT=%ERRORLEVEL%"',
    'del /f /q "%~f0" >nul 2>&1',
    'endlocal & exit /b %_OMC_WORKER_LAUNCH_EXIT%',
    '',
  ].join('\\r\\n');
}

export async function materializeWorkerLaunchTransport(input: {
  attempt: WorkerLaunchAttempt;
  providerArgv: string[];
  cwd: string;
  providerEnv?: NodeJS.ProcessEnv | Record<string, string>;
  releaseAfterSpawn?: boolean;
}): Promise<MaterializedWorkerLaunchTransport> {
  const { attempt } = input;
  if (!attemptTransportPathsAreDeterministic(attempt)) throw new Error('worker_launch_transport_paths_invalid');
  const spec = buildWorkerLaunchBootstrapSpec(attempt, input.providerArgv, input.cwd, {
    providerEnv: input.providerEnv,
    releaseAfterSpawn: input.releaseAfterSpawn,
  });
  const owner: WorkerLaunchTransportOwner = {
    ...identityOf(attempt),
    kind: WORKER_LAUNCH_TRANSPORT_OWNER_KIND,
  };
  const wrapperRelativePath = windowsWrapperRelativePath(input.cwd, attempt.wrapperPath);
  const wrapper = buildWorkerLaunchWrapper(attempt);
  let ownerCreated = false;
  let descriptorCreated = false;
  let wrapperCreated = false;
  try {
    await withFileLock(lockPathFor(attempt.currentPath), async () => {
      if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)
        || (await readJson(`${attempt.decisionPath}.retired`)).kind !== 'absent') {
        throw new Error('worker_launch_attempt_inactive');
      }
      const existingOwner = await readJson(attempt.transportOwnerPath);
      if (existingOwner.kind === 'malformed'
        || (existingOwner.kind === 'value' && !transportOwnerMatches(existingOwner.value, attempt))) {
        throw new Error('worker_launch_transport_owner_conflict');
      }
      if (existingOwner.kind === 'absent') {
        await writeExclusiveAtomic(attempt.transportOwnerPath, owner);
        ownerCreated = true;
      }
      if (existsSync(attempt.bootstrapDescriptorPath) || existsSync(attempt.wrapperPath)) {
        throw new Error('worker_launch_transport_path_conflict');
      }
      await writeExclusiveAtomic(attempt.bootstrapDescriptorPath, spec);
      descriptorCreated = true;
      await writeExclusiveTextAtomic(attempt.wrapperPath, wrapper);
      wrapperCreated = true;
    });
  } catch (error) {
    let cleanupVerified = true;
    if (wrapperCreated) {
      await unlink(attempt.wrapperPath).catch(() => { cleanupVerified = false; });
      cleanupVerified &&= !existsSync(attempt.wrapperPath);
    }
    if (descriptorCreated) {
      await unlink(attempt.bootstrapDescriptorPath).catch(() => { cleanupVerified = false; });
      cleanupVerified &&= !existsSync(attempt.bootstrapDescriptorPath);
    }
    if (ownerCreated) {
      await unlink(attempt.transportOwnerPath).catch(() => { cleanupVerified = false; });
      cleanupVerified &&= !existsSync(attempt.transportOwnerPath);
    }
    if (!cleanupVerified) {
      const cleanupError = new Error('worker_launch_transport_partial_cleanup_unverified');
      (cleanupError as { cause?: unknown }).cause = error;
      throw cleanupError;
    }
    throw error;
  }
  return {
    wrapperPath: attempt.wrapperPath,
    bootstrapDescriptorPath: attempt.bootstrapDescriptorPath,
    wrapperRelativePath,
  };
}

async function cleanupWorkerLaunchTransportUnlocked(
  attempt: WorkerLaunchAttempt,
  reason: string,
): Promise<boolean> {
  const owner = await readJson(attempt.transportOwnerPath);
  const proof = await readJson(attempt.transportCleanupCompletePath);
  if (owner.kind === 'malformed' || proof.kind === 'malformed') return false;
  if (owner.kind === 'value' && !transportOwnerMatches(owner.value, attempt)) return false;
  if (proof.kind === 'value' && !cleanupProofMatches(proof.value, attempt)) return false;
  const hasTransportFiles = existsSync(attempt.bootstrapDescriptorPath) || existsSync(attempt.wrapperPath);
  if (owner.kind === 'absent') {
    return !hasTransportFiles && (proof.kind === 'absent' || cleanupProofMatches(proof.value, attempt));
  }
  await unlink(attempt.bootstrapDescriptorPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await unlink(attempt.wrapperPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  if (existsSync(attempt.bootstrapDescriptorPath) || existsSync(attempt.wrapperPath)) return false;
  if (proof.kind === 'absent') {
    await writeExclusiveAtomic(attempt.transportCleanupCompletePath, {
      ...identityOf(attempt),
      kind: WORKER_LAUNCH_TRANSPORT_CLEANUP_KIND,
      reason,
      written_at: new Date().toISOString(),
    });
  }
  const completed = await readJson(attempt.transportCleanupCompletePath);
  return completed.kind === 'value' && cleanupProofMatches(completed.value, attempt)
    && !existsSync(attempt.bootstrapDescriptorPath) && !existsSync(attempt.wrapperPath);
}

export async function cleanupWorkerLaunchTransport(attempt: WorkerLaunchAttempt, reason = 'transport_cleanup'): Promise<boolean> {
  if (!attemptTransportPathsAreDeterministic(attempt)) return false;
  try {
    return await withFileLock(
      lockPathFor(attempt.currentPath),
      () => cleanupWorkerLaunchTransportUnlocked(attempt, reason),
      { timeoutMs: 5_000, retryDelayMs: 10 },
    );
  } catch {
    return false;
  }
}

export async function readAndConsumeWorkerLaunchDescriptor(descriptorPath: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(descriptorPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'worker_launch_descriptor_missing' : 'worker_launch_descriptor_invalid');
  }
  if (!isValidBootstrapSpec(parsed)) throw new Error('worker_launch_descriptor_invalid');
  const spec = parsed;
  if (resolve(descriptorPath) !== resolve(spec.bootstrap_descriptor_path)) {
    throw new Error('worker_launch_descriptor_path_mismatch');
  }
  const owner = await readJson(spec.transport_owner_path);
  if (owner.kind !== 'value' || !transportOwnerMatches(owner.value, spec)
    || !existsSync(spec.wrapper_path)) {
    throw new Error('worker_launch_descriptor_owner_invalid');
  }
  try {
    await withFileLock(lockPathFor(spec.current_path), async () => {
      const currentOwner = await readJson(spec.transport_owner_path);
      if (currentOwner.kind !== 'value' || !transportOwnerMatches(currentOwner.value, spec)
        || !await isCurrentLaunchIdentity(spec.current_path, spec)
        || (await readJson(`${spec.decision_path}.retired`)).kind !== 'absent') {
        throw new Error('worker_launch_descriptor_owner_invalid');
      }
      await unlink(descriptorPath);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('worker_launch_descriptor_')) throw error;
    throw new Error('worker_launch_descriptor_remove_failed');
  }
  return spec;
}

async function publishDecision(
  attempt: WorkerLaunchAttempt,
  decision: WorkerLaunchDecision['decision'],
  reason: string,
): Promise<boolean> {
  const record: WorkerLaunchDecision = {
    ...identityOf(attempt),
    kind: 'worker_launch_decision',
    decision,
    reason,
    written_at: new Date().toISOString(),
  };
  try {
    await writeExclusiveAtomic(attempt.decisionPath, record);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readJson(attempt.decisionPath);
    return existing.kind === 'value'
      && identityMatches(existing.value, attempt)
      && (existing.value as Partial<WorkerLaunchDecision>).kind === 'worker_launch_decision'
      && (existing.value as Partial<WorkerLaunchDecision>).decision === decision;
  }
}

export async function revokeWorkerLaunchAttempt(attempt: WorkerLaunchAttempt, reason: string): Promise<boolean> {
  return publishDecision(attempt, 'revoked', reason).catch(() => false);
}

async function rejectWorkerLaunchAttempt(
  attempt: WorkerLaunchAttempt,
  reason: Exclude<WorkerLaunchAcceptance, { ok: true }>['reason'],
): Promise<WorkerLaunchAcceptance> {
  return await revokeWorkerLaunchAttempt(attempt, reason)
    ? { ok: false, reason }
    : { ok: false, reason: 'decision_conflict' };
}

function acknowledgementResult(value: unknown, attempt: WorkerLaunchAttempt): WorkerLaunchAcceptance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'ack_malformed' };
  const record = value as Partial<WorkerLaunchAcknowledgement>;
  if (record.kind !== 'worker_launch_ack' || typeof record.written_at !== 'string'
    || !Number.isFinite(Date.parse(record.written_at))) return { ok: false, reason: 'ack_malformed' };
  return identityMatches(record, attempt) ? null : { ok: false, reason: 'ack_mismatch' };
}

async function acceptObservedAcknowledgement(
  attempt: WorkerLaunchAttempt,
  read: JsonReadResult,
): Promise<WorkerLaunchAcceptance | null> {
  if (read.kind === 'absent') return null;
  if (read.kind === 'malformed') return { ok: false, reason: 'ack_malformed' };
  const invalid = acknowledgementResult(read.value, attempt);
  if (invalid) return invalid;
  try {
    return await withFileLock(lockPathFor(attempt.currentPath), async () => {
      if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)) {
        return { ok: false, reason: 'attempt_superseded' } as WorkerLaunchAcceptance;
      }
      return await publishDecision(attempt, 'accepted', 'ack_valid')
        ? { ok: true } as WorkerLaunchAcceptance
        : { ok: false, reason: 'decision_conflict' } as WorkerLaunchAcceptance;
    });
  } catch {
    return { ok: false, reason: 'decision_conflict' };
  }
}

export async function awaitWorkerLaunchAcknowledgement(
  attempt: WorkerLaunchAttempt,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<WorkerLaunchAcceptance> {
  const expected = await readJson(attempt.expectedPath);
  if (expected.kind !== 'value' || !identityMatches(expected.value, attempt)) {
    return rejectWorkerLaunchAttempt(attempt, 'expected_record_invalid');
  }
  const timeoutMs = options.timeoutMs ?? resolvePositiveInteger(process.env.OMC_TEAM_START_ACK_TIMEOUT_MS, DEFAULT_ACK_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await acceptObservedAcknowledgement(attempt, await readJson(attempt.ackPath));
    if (result) {
      return result.ok ? result : rejectWorkerLaunchAttempt(attempt, result.reason);
    }
    await sleep(pollIntervalMs);
  }
  const finalResult = await acceptObservedAcknowledgement(attempt, await readJson(attempt.ackPath));
  if (finalResult) {
    return finalResult.ok ? finalResult : rejectWorkerLaunchAttempt(attempt, finalResult.reason);
  }
  return rejectWorkerLaunchAttempt(attempt, 'ack_timeout');
}

export async function isWorkerLaunchAttemptAccepted(attempt: WorkerLaunchAttempt): Promise<boolean> {
  const decision = await readJson(attempt.decisionPath);
  return decision.kind === 'value'
    && identityMatches(decision.value, attempt)
    && (decision.value as Partial<WorkerLaunchDecision>).kind === 'worker_launch_decision'
    && (decision.value as Partial<WorkerLaunchDecision>).decision === 'accepted';
}

export async function isWorkerLaunchAttemptCurrent(attempt: WorkerLaunchAttempt): Promise<boolean> {
  try {
    return await withFileLock(lockPathFor(attempt.currentPath), () => isCurrentLaunchIdentity(attempt.currentPath, attempt));
  } catch {
    return false;
  }
}

export async function withWorkerLaunchAttemptFence<T>(
  attempt: WorkerLaunchAttempt,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return await withFileLock(lockPathFor(attempt.currentPath), async () => {
      if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)
        || !await isWorkerLaunchAttemptAccepted(attempt)) return { ok: false as const };
      return { ok: true as const, value: await fn() };
    });
  } catch {
    return { ok: false };
  }
}

export async function retireWorkerLaunchAttempt(
  attempt: WorkerLaunchAttempt,
  reason: string,
): Promise<boolean> {
  const retiredPath = `${attempt.decisionPath}.retired`;
  try {
    return await withFileLock(lockPathFor(attempt.currentPath), async () => {
      const existing = await readJson(retiredPath);
      if (existing.kind === 'value') {
        if (!identityMatches(existing.value as Partial<WorkerLaunchIdentity>, attempt)) return false;
      } else if (existing.kind === 'malformed') {
        return false;
      } else {
        await writeExclusiveAtomic(retiredPath, {
          ...identityOf(attempt),
          kind: 'worker_launch_retired',
          reason,
          written_at: new Date().toISOString(),
        });
      }
      if (!await cleanupWorkerLaunchTransportUnlocked(attempt, reason)) return false;
      if (await isCurrentLaunchIdentity(attempt.currentPath, attempt)) {
        await unlink(attempt.currentPath).catch(() => {});
      }
      return true;
    }, { timeoutMs: 5_000, retryDelayMs: 10 });
  } catch {
    return false;
  }
}

export async function retireAndCleanupCurrentWorkerLaunchAttempt(
  attempt: WorkerLaunchAttempt,
  reason: string,
  cleanup: () => Promise<boolean>,
): Promise<boolean> {
  const retiredPath = `${attempt.decisionPath}.retired`;
  const cleanupCompletePath = `${retiredPath}.cleanup-complete`;
  const cleanupIsComplete = async (): Promise<boolean> => {
    const completed = await readJson(cleanupCompletePath);
    return completed.kind === 'value'
      && identityMatches(completed.value as Partial<WorkerLaunchIdentity>, attempt)
      && (completed.value as { kind?: unknown }).kind === 'worker_launch_cleanup_complete';
  };
  if (await cleanupIsComplete()) return true;
  try {
    return await withFileLock(lockPathFor(attempt.currentPath), async () => {
      if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)) return cleanupIsComplete();
      if (!await isWorkerLaunchAttemptAccepted(attempt)) return false;
      const existing = await readJson(retiredPath);
      if (existing.kind === 'value') {
        if (!identityMatches(existing.value as Partial<WorkerLaunchIdentity>, attempt)) return false;
      } else if (existing.kind === 'malformed') {
        return false;
      } else {
        await writeExclusiveAtomic(retiredPath, {
          ...identityOf(attempt), kind: 'worker_launch_retired', reason, written_at: new Date().toISOString(),
        });
      }
      if (!await terminateWorkerLaunchProvider(attempt)) return false;
      if (!await cleanup()) return false;
      if (!await cleanupWorkerLaunchTransportUnlocked(attempt, reason)) return false;
      const completed = await readJson(cleanupCompletePath);
      if (completed.kind === 'absent') {
        await writeExclusiveAtomic(cleanupCompletePath, {
          ...identityOf(attempt), kind: 'worker_launch_cleanup_complete', reason, written_at: new Date().toISOString(),
        });
      } else if (completed.kind !== 'value'
        || !identityMatches(completed.value as Partial<WorkerLaunchIdentity>, attempt)
        || (completed.value as { kind?: unknown }).kind !== 'worker_launch_cleanup_complete') return false;
      if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)) return false;
      await unlink(attempt.currentPath);
      return true;
    }, { timeoutMs: 10_000, retryDelayMs: 10 });
  } catch {
    return false;
  }
}

function isValidProcessStartIdentity(value: unknown): value is string {
  return typeof value === 'string' && (/^\d+$/.test(value) || /^ticks:\d+$/.test(value)
    || /^dmtf:\d{14}\.\d{6}[+-]\d{3}$/.test(value));
}

async function readWorkerLaunchCleanupProof(
  attempt: WorkerLaunchAttempt,
  started?: Partial<WorkerLaunchProviderStarted>,
): Promise<boolean> {
  const terminal = await readJson(`${attempt.startedPath}.terminal`);
  if (terminal.kind === 'value') {
    const value = terminal.value as Partial<WorkerLaunchIdentity> & Record<string, unknown>;
    const matchesStarted = !started || (value.pid === started.pid
      && value.process_start_identity === started.process_start_identity);
    if (matchesStarted && identityMatches(value, attempt) && value.kind === 'worker_launch_provider_terminal'
      && value.outcome === 'exit' && value.cleanup_verified === true
      && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && isValidProcessStartIdentity(value.process_start_identity)) return true;
  }
  const completed = await readJson(`${attempt.startedPath}.termination-complete`);
  if (completed.kind === 'value') {
    const value = completed.value as Partial<WorkerLaunchIdentity> & Record<string, unknown>;
    const matchesStarted = !started || (value.pid === started.pid
      && value.process_start_identity === started.process_start_identity);
    if (matchesStarted && identityMatches(value, attempt) && value.kind === 'worker_launch_termination_complete'
      && value.cleanup_verified === true && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && isValidProcessStartIdentity(value.process_start_identity)) return true;
  }
  return false;
}

export async function terminateWorkerLaunchProvider(
  attempt: WorkerLaunchAttempt,
  timeoutMs: number = 2_000,
): Promise<boolean> {
  const started = await readJson(attempt.startedPath);
  const terminalCleanupVerified = await readWorkerLaunchCleanupProof(
    attempt,
    started.kind === 'value' ? started.value as Partial<WorkerLaunchProviderStarted> : undefined,
  );
  if (started.kind === 'absent') return terminalCleanupVerified;
  if (started.kind !== 'value') return false;
  const record = started.value as Partial<WorkerLaunchProviderStarted>;
  if (!identityMatches(record, attempt)
    || record.kind !== 'worker_launch_provider_started'
    || !Number.isSafeInteger(record.pid)
    || Number(record.pid) <= 0
    || !isValidProcessStartIdentity(record.process_start_identity)) return false;
  const terminationRequestPath = `${attempt.startedPath}.termination-request`;
  const terminationCompletePath = `${attempt.startedPath}.termination-complete`;
  const existingRequest = await readJson(terminationRequestPath);
  if (existingRequest.kind === 'absent') {
    try {
      await writeExclusiveAtomic(terminationRequestPath, {
        ...identityOf(attempt), kind: 'worker_launch_termination_request', pid: record.pid,
        process_start_identity: record.process_start_identity, written_at: new Date().toISOString(),
      });
    } catch {
      return false;
    }
  } else {
    const value = existingRequest.kind === 'value'
      ? existingRequest.value as Partial<WorkerLaunchIdentity> & Record<string, unknown>
      : null;
    if (!value || !identityMatches(value, attempt) || value.kind !== 'worker_launch_termination_request'
      || value.pid !== record.pid || value.process_start_identity !== record.process_start_identity) return false;
  }
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const result = await terminateOwnedProcessTree({
    pid: record.pid!, expectedStartIdentity: record.process_start_identity, deadlineAt, force: true,
  });
  if (result === 'already-dead' || result === 'identity-mismatch') return terminalCleanupVerified;
  if (result !== 'terminated') return false;
  const existingComplete = await readJson(terminationCompletePath);
  if (existingComplete.kind === 'absent') {
    try {
      await writeExclusiveAtomic(terminationCompletePath, {
        ...identityOf(attempt), kind: 'worker_launch_termination_complete', cleanup_verified: true,
        pid: record.pid, process_start_identity: record.process_start_identity, written_at: new Date().toISOString(),
      });
    } catch {
      // The completion-record write failed after a successful termination.
      // Retry: verify the process is dead, then re-attempt the write so a
      // later retry can safely resume from the termination-request + proven
      // process absence. Never infer from PID absence without request identity.
      const deadline = Date.parse(deadlineAt);
      const liveness = await isProcessIdentityLive(record.pid!, record.process_start_identity, deadline);
      if (liveness === 'dead' || liveness === 'mismatch') {
        try {
          await writeExclusiveAtomic(terminationCompletePath, {
            ...identityOf(attempt), kind: 'worker_launch_termination_complete', cleanup_verified: true,
            pid: record.pid, process_start_identity: record.process_start_identity, written_at: new Date().toISOString(),
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  } else {
    const value = existingComplete.kind === 'value'
      ? existingComplete.value as Partial<WorkerLaunchIdentity> & Record<string, unknown>
      : null;
    if (!value || !identityMatches(value, attempt) || value.kind !== 'worker_launch_termination_complete'
      || value.cleanup_verified !== true || value.pid !== record.pid
      || value.process_start_identity !== record.process_start_identity) return false;
  }
  const deadline = Date.parse(deadlineAt);
  while (Date.now() < deadline) {
    const liveness = await isProcessIdentityLive(record.pid!, record.process_start_identity, deadline);
    if (liveness === 'dead' || liveness === 'mismatch') return true;
    if (liveness === 'unknown') return false;
    await sleep(20);
  }
  return false;
}

async function readValidProviderStarted(
  attempt: WorkerLaunchAttempt,
): Promise<WorkerLaunchProviderStarted | null> {
  const started = await readJson(attempt.startedPath);
  if ((await readJson(`${attempt.startedPath}.terminal`)).kind !== 'absent') return null;
  if (started.kind !== 'value') return null;
  const record = started.value as Partial<WorkerLaunchProviderStarted>;
  if (record.supervisor_completion_path !== undefined
    && (typeof record.supervisor_completion_path !== 'string'
      || record.supervisor_completion_path.trim().length === 0
      || existsSync(record.supervisor_completion_path))) return null;
  return identityMatches(record, attempt)
    && record.kind === 'worker_launch_provider_started'
    && Number.isSafeInteger(record.pid)
    && record.pid! > 0
    && typeof record.process_start_identity === 'string'
    && record.process_start_identity.trim().length > 0
    && typeof record.written_at === 'string'
    && Number.isFinite(Date.parse(record.written_at))
    ? record as WorkerLaunchProviderStarted
    : null;
}

export async function awaitWorkerLaunchProviderStarted(
  attempt: WorkerLaunchAttempt,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? resolvePositiveInteger(process.env.OMC_TEAM_START_ACK_TIMEOUT_MS, DEFAULT_ACK_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const published = await readValidProviderStarted(attempt);
    if (published) try {
      const handedOff = await withFileLock(lockPathFor(attempt.currentPath), async () => {
        if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)
          || !await isWorkerLaunchAttemptAccepted(attempt)) return false;
        const started = await readValidProviderStarted(attempt);
        if (!started) return false;
        return await isProcessIdentityLive(
          started.pid!,
          started.process_start_identity,
          deadline,
        ) === 'live';
      });
      if (handedOff) return true;
    } catch {
      // Bootstrap still owns the launch fence; retry within the bounded window.
    }
    if ((await readJson(`${attempt.decisionPath}.retired`)).kind !== 'absent') return false;
    await sleep(pollIntervalMs);
  }
  return false;
}

export async function isWorkerLaunchProviderStarted(attempt: WorkerLaunchAttempt): Promise<boolean> {
  return (await readValidProviderStarted(attempt)) !== null;
}

function isDeterministicTransportPath(expectedPath: string, candidate: unknown, fileName: string): candidate is string {
  return isExactText(candidate)
    && resolve(candidate) === resolve(join(dirname(expectedPath), fileName));
}

function isValidBootstrapSpec(value: unknown): value is WorkerLaunchBootstrapSpec {
  if (!isValidIdentity(value)) return false;
  const spec = value as Partial<WorkerLaunchBootstrapSpec>;
  return isExactText(spec.current_path)
    && isExactText(spec.expected_path)
    && isExactText(spec.ack_path)
    && isExactText(spec.decision_path)
    && isExactText(spec.started_path)
    && isDeterministicTransportPath(spec.expected_path, spec.transport_owner_path, 'transport-owner.json')
    && isDeterministicTransportPath(spec.expected_path, spec.bootstrap_descriptor_path, WORKER_LAUNCH_BOOTSTRAP_DESCRIPTOR_FILE)
    && isDeterministicTransportPath(spec.expected_path, spec.wrapper_path, 'launch.cmd')
    && isDeterministicTransportPath(spec.expected_path, spec.transport_cleanup_complete_path, 'transport-cleanup-complete.json')
    && Array.isArray(spec.provider_argv)
    && spec.provider_argv.length > 0
    && isExactText(spec.provider_argv[0])
    && spec.provider_argv.slice(1).every(argument => typeof argument === 'string')
    && isValidProviderEnvironment(spec.provider_env)
    && typeof spec.cwd === 'string'
    && spec.cwd.length > 0
    && Number.isSafeInteger(spec.decision_timeout_ms)
    && typeof spec.release_after_spawn === 'boolean'
    && Number(spec.decision_timeout_ms) > 0;
}

async function publishAcknowledgement(spec: WorkerLaunchBootstrapSpec): Promise<boolean> {
  const acknowledgement: WorkerLaunchAcknowledgement = {
    schema_version: spec.schema_version,
    attempt_id: spec.attempt_id,
    nonce: spec.nonce,
    team_name: spec.team_name,
    worker_name: spec.worker_name,
    pane_id: spec.pane_id,
    provider: spec.provider,
    created_at: spec.created_at,
    kind: 'worker_launch_ack',
    written_at: new Date().toISOString(),
  };
  try {
    await writeExclusiveAtomic(spec.ack_path, acknowledgement);
    return true;
  } catch {
    return false;
  }
}

async function waitForBootstrapDecision(spec: WorkerLaunchBootstrapSpec): Promise<'accepted' | 'revoked' | 'timeout'> {
  const deadline = Date.now() + spec.decision_timeout_ms;
  while (Date.now() < deadline) {
    const read = await readJson(spec.decision_path);
    if (read.kind === 'value' && identityMatches(read.value, spec)
      && (read.value as Partial<WorkerLaunchDecision>).kind === 'worker_launch_decision') {
      const decision = (read.value as Partial<WorkerLaunchDecision>).decision;
      if (decision === 'accepted' || decision === 'revoked') return decision;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  return 'timeout';
}

function quoteWindowsCmdArgument(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('worker_launch_provider_argv_invalid');
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

export function buildProviderSpawnInvocation(
  providerArgv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSpawnInvocation {
  const [command, ...args] = providerArgv;
  if (!command) throw new Error('worker_launch_provider_argv_missing');
  if (platform === 'win32') {
    const renderedProvider = providerArgv.map(quoteWindowsCmdArgument).join(' ');
    const waitsForBatchProvider = ['.cmd', '.bat'].includes(extname(command).toLowerCase());
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c'],
      batchScript: `@echo off\r\n${waitsForBatchProvider ? 'start "" /b /wait ' : ''}${renderedProvider}\r\n`,
    };
  }
  return { command, args };
}

async function awaitExternalTerminationCompletion(
  spec: WorkerLaunchBootstrapSpec,
  timeoutMs: number = 2_000,
): Promise<boolean> {
  const request = await readJson(`${spec.started_path}.termination-request`);
  if (request.kind !== 'value' || !identityMatches(request.value as Partial<WorkerLaunchIdentity>, spec)) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed = await readJson(`${spec.started_path}.termination-complete`);
    if (completed.kind === 'value'
      && identityMatches(completed.value as Partial<WorkerLaunchIdentity>, spec)
      && (completed.value as { cleanup_verified?: unknown }).cleanup_verified === true) return true;
    if (completed.kind === 'malformed') return false;
    await sleep(10);
  }
  return false;
}

export async function materializeProviderSpawnInvocation(
  invocation: ProviderSpawnInvocation,
  options: { superviseWindowsTree?: boolean; superviseProcessTree?: boolean } = {},
): Promise<MaterializedProviderSpawnInvocation> {
  const superviseProcessTree = options.superviseProcessTree ?? options.superviseWindowsTree ?? false;
  if (!invocation.batchScript && !superviseProcessTree) {
    return { command: invocation.command, args: invocation.args, cleanup: async () => {} };
  }
  const wrapperDir = await mkdtemp(join(tmpdir(), 'omc-provider-'));
  const completionPath = superviseProcessTree ? join(wrapperDir, 'provider-exit.txt') : undefined;
  try {
    if (!invocation.batchScript) {
      const wrapperPath = join(wrapperDir, 'launch.sh');
      const quotedCompletion = `'${completionPath!.replace(/'/g, `'"'"'`)}'`;
      await writeFile(wrapperPath,
        `#!/bin/sh\n"$@"\n_omc_exit=$?\nprintf '%s\\n' "$_omc_exit" > ${quotedCompletion}\nwhile :; do sleep 3600; done\n`,
        { encoding: 'utf8', mode: 0o700 });
      return {
        command: '/bin/sh', args: [wrapperPath, invocation.command, ...invocation.args], completionPath,
        cleanup: async () => { await rm(wrapperDir, { recursive: true, force: true }); },
      };
    }
    const wrapperPath = join(wrapperDir, 'launch.cmd');
    const completionScript = completionPath
      ? `set "_OMC_EXIT=%ERRORLEVEL%"\r\n> ${quoteWindowsCmdArgument(completionPath)} echo %_OMC_EXIT%\r\n:omc_hold\r\nping -n 3600 127.0.0.1 >nul\r\ngoto omc_hold\r\n`
      : '';
    await writeFile(wrapperPath, `${invocation.batchScript}${completionScript}`, { encoding: 'utf8', mode: 0o600 });
    return {
      command: invocation.command,
      args: [...invocation.args, `"${wrapperPath}"`],
      ...(completionPath ? { completionPath } : {}),
      cleanup: async () => { await rm(wrapperDir, { recursive: true, force: true }); },
    };
  } catch (writeError) {
    await rm(wrapperDir, { recursive: true, force: true }).catch(() => undefined);
    throw writeError;
  }
}

async function publishProviderStarted(
  spec: WorkerLaunchBootstrapSpec,
  pid: number | undefined,
  processStartIdentity: string,
  supervisorCompletionPath?: string,
): Promise<boolean> {
  const record: WorkerLaunchProviderStarted = {
    schema_version: spec.schema_version,
    attempt_id: spec.attempt_id,
    nonce: spec.nonce,
    team_name: spec.team_name,
    worker_name: spec.worker_name,
    pane_id: spec.pane_id,
    provider: spec.provider,
    created_at: spec.created_at,
    kind: 'worker_launch_provider_started',
    pid: Number.isSafeInteger(pid) ? pid! : null,
    process_start_identity: processStartIdentity,
    ...(supervisorCompletionPath ? { supervisor_completion_path: supervisorCompletionPath } : {}),
    written_at: new Date().toISOString(),
  };
  try {
    await writeExclusiveAtomic(spec.started_path, record);
    return true;
  } catch {
    return false;
  }
}

export async function runWorkerLaunchBootstrap(value: unknown): Promise<WorkerLaunchBootstrapResult> {
  if (!isValidBootstrapSpec(value)) return { outcome: 'invalid_spec' };
  const spec = value;
  const expected = await readJson(spec.expected_path);
  if (expected.kind !== 'value' || !identityMatches(expected.value, spec)) return { outcome: 'expected_record_invalid' };
  if (!await publishAcknowledgement(spec)) return { outcome: 'ack_conflict' };
  const decision = await waitForBootstrapDecision(spec);
  if (decision === 'timeout') return { outcome: 'decision_timeout' };
  if (decision === 'revoked') return { outcome: 'revoked' };
  const providerEnv: NodeJS.ProcessEnv = { ...process.env, ...spec.provider_env };
  for (const key of WORKER_LAUNCH_INTERNAL_ENV_KEYS) delete providerEnv[key];
  try {
    const launched = await withFileLock(lockPathFor(spec.current_path), async () => {
      if (!await isCurrentLaunchIdentity(spec.current_path, spec)
        || (await readJson(`${spec.decision_path}.retired`)).kind !== 'absent') {
        return { outcome: 'superseded' as const };
      }
      const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(spec.provider_argv), {
        superviseProcessTree: true,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd,
        env: providerEnv,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      let settled = false;
      let providerStartIdentity: string | null = null;
      let supervisedExitCode: number | null = null;
      let supervisorTimer: NodeJS.Timeout | undefined;
      let terminationResult: Promise<Awaited<ReturnType<typeof terminateOwnedProcessTree>>> | null = null;
      let resolveCompletion!: (result: WorkerLaunchBootstrapResult) => void;
      const completion = new Promise<WorkerLaunchBootstrapResult>(resolve => {
        resolveCompletion = resolve;
        child.once('exit', async (exitCode, signal) => {
          if (settled) return;
          settled = true;
          if (supervisorTimer) clearInterval(supervisorTimer);
          const effectiveExitCode = supervisedExitCode ?? exitCode;
          const effectiveSignal = supervisedExitCode === null ? signal : null;
          const cleanupVerified = terminationResult
            ? await terminationResult === 'terminated'
            : await awaitExternalTerminationCompletion(spec);
          await atomicWriteJson(`${spec.started_path}.terminal`, {
            ...identityOf(spec), kind: 'worker_launch_provider_terminal',
            outcome: cleanupVerified ? 'exit' : 'cleanup_unverified', cleanup_verified: cleanupVerified,
            pid: child.pid ?? null, process_start_identity: providerStartIdentity, exit_code: effectiveExitCode, signal: effectiveSignal, written_at: new Date().toISOString(),
          }).catch(() => undefined);
          await invocation.cleanup().catch(() => undefined);
          resolve(cleanupVerified
            ? { outcome: 'ran', exitCode: effectiveExitCode, signal: effectiveSignal }
            : { outcome: 'provider_cleanup_unverified' });
        });
        child.once('error', async () => {
          if (settled) return;
          settled = true;
          if (supervisorTimer) clearInterval(supervisorTimer);
          await atomicWriteJson(`${spec.started_path}.terminal`, {
            ...identityOf(spec), kind: 'worker_launch_provider_terminal', outcome: 'error', cleanup_verified: false,
            pid: child.pid ?? null, process_start_identity: providerStartIdentity, written_at: new Date().toISOString(),
          }).catch(() => undefined);
          await invocation.cleanup().catch(() => undefined);
          resolve({ outcome: 'provider_spawn_failed' });
        });
      });
      /**
       * Creation-bound containment: can reap the exact ChildProcess even before a
       * durable process-start identity exists. Never promotes raw PID to later authority.
       */
      const terminateProvider = async (): Promise<boolean> => {
        if (settled) return true;
        if (child.pid && providerStartIdentity) {
          terminationResult ??= terminateOwnedProcessTree({
            pid: child.pid,
            expectedStartIdentity: providerStartIdentity,
            deadlineAt: new Date(Date.now() + 2_000).toISOString(),
            force: true,
          });
          const terminated = await terminationResult === 'terminated';
          const completed = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), 2_000);
            void completion.then(result => {
              clearTimeout(timer);
              resolve(result.outcome !== 'provider_cleanup_unverified');
            });
          });
          return terminated && completed;
        }
        // Pre-identity path: kill only via the spawn handle (and its process group
        // when detached). This is creation-bound containment, not durable ownership.
        try {
          if (child.pid && process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* already dead */ }
        const completed = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 2_000);
          void completion.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
          // If already settled between kill and wait
          if (settled) { clearTimeout(timer); resolve(true); }
        });
        return completed;
      };
      const cleanupSignals: NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];
      const onBootstrapSignal = () => { void terminateProvider(); };
      const ownsSignalLifecycle = Boolean(process.env.OMC_WORKER_LAUNCH_SPEC || process.env.OMC_WORKER_LAUNCH_SPEC_B64);
      if (ownsSignalLifecycle) {
        for (const signal of cleanupSignals) process.once(signal, onBootstrapSignal);
        void completion.finally(() => {
          for (const signal of cleanupSignals) process.removeListener(signal, onBootstrapSignal);
        });
      }
      const spawned = await new Promise<boolean>(resolve => {
        child.once('spawn', () => resolve(true));
        child.once('error', () => resolve(false));
      });
      if (!spawned) {
        await completion;
        return { outcome: 'provider_spawn_failed' as const };
      }
      // Bind identity IMMEDIATELY after spawn, before any await/yield that could
      // race with child exit + PID reuse. Fail closed if sync identity unavailable.
      providerStartIdentity = child.pid ? getProcessStartIdentitySync(child.pid) : null;
      if (!child.pid || !providerStartIdentity || settled || !isProcessAlive(child.pid)) {
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        return { outcome: 'provider_spawn_failed' as const };
      }
      if (!spec.release_after_spawn) await new Promise(resolve => setTimeout(resolve, 75));
      if (settled) {
        // Child settled during delay — do not publish; cleanup may already be in flight.
        return { completion };
      }
      // Rebind after the delay await before any durable publication.
      const reboundIdentity = getProcessStartIdentitySync(child.pid);
      if (!reboundIdentity || reboundIdentity !== providerStartIdentity || !isProcessAlive(child.pid)) {
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        return { outcome: 'provider_spawn_failed' as const };
      }
      if (invocation.completionPath && existsSync(invocation.completionPath)) {
        const exitCode = Number(await readFile(invocation.completionPath, 'utf8').catch(() => ''));
        if (Number.isSafeInteger(exitCode)) supervisedExitCode = exitCode;
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        return { outcome: 'provider_spawn_failed' as const };
      }
      if (!await isCurrentLaunchIdentity(spec.current_path, spec)
        || (await readJson(`${spec.decision_path}.retired`)).kind !== 'absent') {
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        return { outcome: 'superseded' as const };
      }
      try {
        if (!await publishProviderStarted(spec, child.pid, providerStartIdentity, invocation.completionPath)) {
          if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
          return { outcome: 'provider_spawn_failed' as const };
        }
      } catch {
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        return { outcome: 'provider_spawn_failed' as const };
      }
      if (invocation.completionPath && existsSync(invocation.completionPath)) {
        const exitCode = Number(await readFile(invocation.completionPath, 'utf8').catch(() => ''));
        if (Number.isSafeInteger(exitCode)) supervisedExitCode = exitCode;
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        await unlink(spec.started_path).catch(() => {});
        return { outcome: 'provider_spawn_failed' as const };
      }
      if (!await isCurrentLaunchIdentity(spec.current_path, spec)
        || (await readJson(`${spec.decision_path}.retired`)).kind !== 'absent') {
        if (!await terminateProvider()) return { outcome: 'provider_cleanup_unverified' as const };
        await unlink(spec.started_path).catch(() => {});
        return { outcome: 'superseded' as const };
      }
      if (invocation.completionPath) {
        let pollingCompletion = false;
        supervisorTimer = setInterval(() => {
          if (pollingCompletion || settled || !providerStartIdentity || !child.pid) return;
          pollingCompletion = true;
          void readFile(invocation.completionPath!, 'utf8').then(async raw => {
            const exitCode = Number(raw.trim());
            if (!Number.isSafeInteger(exitCode)) return;
            supervisedExitCode = exitCode;
            const cleaned = await terminateProvider();
            if (!cleaned && !settled) {
              settled = true;
              if (supervisorTimer) clearInterval(supervisorTimer);
              await atomicWriteJson(`${spec.started_path}.terminal`, {
                ...identityOf(spec), kind: 'worker_launch_provider_terminal', outcome: 'cleanup_unverified', cleanup_verified: false,
                pid: child.pid ?? null, process_start_identity: providerStartIdentity, exit_code: exitCode, signal: null, written_at: new Date().toISOString(),
              }).catch(() => undefined);
              await invocation.cleanup().catch(() => undefined);
              resolveCompletion({ outcome: 'provider_cleanup_unverified' });
            }
          }).catch(() => undefined).finally(() => { pollingCompletion = false; });
        }, DEFAULT_POLL_INTERVAL_MS);
        supervisorTimer.unref();
      }
      return { completion };
    });
    if ('completion' in launched) {
      if (!launched.completion) return { outcome: 'provider_spawn_failed' };
      return await launched.completion;
    }
    return launched;
  } catch {
    return { outcome: 'provider_spawn_failed' };
  }
}
