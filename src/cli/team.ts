import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { executeTeamApiOperation as executeCanonicalTeamApiOperation, resolveTeamApiOperation } from '../team/api-interop.js';
import { validateTeamName } from '../team/team-name.js';
import { monitorTeam, resumeTeam } from '../team/runtime.js';
import { readTeamConfig } from '../team/monitor.js';
import { isProcessAlive } from '../platform/index.js';
import { getGlobalOmcStatePath } from '../utils/paths.js';
import { readApprovedExecutionLaunchHintOutcome } from '../planning/artifacts.js';
import { isValidTeamInstanceId } from '../team/types.js';
import { withProcessIdentityFileLockSync } from '../team/process-identity-lock.js';

const JOB_ID_PATTERN = /^omc-[a-z0-9]{1,16}$/;
const VALID_CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini', 'cursor', 'grok', 'antigravity']);
const SUBCOMMANDS = new Set(['start', 'status', 'wait', 'cleanup', 'resume', 'shutdown', 'api', 'help', '--help', '-h']);

const SUPPORTED_API_OPERATIONS = new Set([
  'send-message',
  'broadcast',
  'mailbox-list',
  'mailbox-mark-delivered',
  'mailbox-mark-notified',
  'list-tasks',
  'read-task',
  'read-config',
  'get-summary',
  'orphan-cleanup',
  'recover-worker',
  'write-task-checkpoint',
  'read-recovery-result',
] as const);
const TEAM_API_USAGE = `
Usage:
  omc team api <operation> --input '<json>' [--json] [--cwd DIR]

Supported operations:
  ${Array.from(SUPPORTED_API_OPERATIONS).join(', ')}
`.trim();

type SupportedApiOperation =
  | 'send-message'
  | 'broadcast'
  | 'mailbox-list'
  | 'mailbox-mark-delivered'
  | 'mailbox-mark-notified'
  | 'list-tasks'
  | 'read-task'
  | 'read-config'
  | 'get-summary'
  | 'orphan-cleanup'
  | 'recover-worker'
  | 'write-task-checkpoint'
  | 'read-recovery-result';

interface TeamApiEnvelope {
  ok: boolean;
  operation: string;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

interface TeamLegacyStartArgs {
  workerCount: number;
  agentType: string;
  role?: string;
  task: string;
  teamName: string;
  ralph: boolean;
  json: boolean;
  cwd: string;
  newWindow?: boolean;
  autoMerge?: boolean;
}

export interface TeamTaskInput {
  subject: string;
  description: string;
}

export interface TeamStartInput {
  teamName: string;
  agentTypes: string[];
  tasks: TeamTaskInput[];
  cwd: string;
  newWindow?: boolean;
  workerCount?: number;
  pollIntervalMs?: number;
  sentinelGateTimeoutMs?: number;
  sentinelGatePollIntervalMs?: number;
  /**
   * When true, the v2 runtime starts the merge orchestrator: per-commit
   * auto-merge to the leader branch and auto-rebase fanout to other workers.
   * Equivalent to setting OMC_TEAMS_AUTO_MERGE=1. Requires OMC_RUNTIME_V2=1.
   */
  autoMerge?: boolean;
}

export interface TeamStartResult {
  jobId: string;
  instanceId: string;
  status: 'running';
  pid?: number;
}

export interface TeamJobStatus {
  jobId: string;
  instanceId?: string;
  status: 'running' | 'completed' | 'failed';
  elapsedSeconds: string;
  result?: unknown;
  stderr?: string;
}

export interface TeamWaitOptions {
  timeoutMs?: number;
}

export interface TeamWaitResult extends TeamJobStatus {
  timedOut?: boolean;
  error?: string;
}

export interface TeamCleanupResult {
  jobId: string;
  message: string;
}

interface TeamJobRecord {
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  teamName: string;
  cwd: string;
  instanceId: string;
  pid?: number;
  result?: string;
  stderr?: string;
  cleanedUpAt?: string;
  cleanupBlockedAt?: string;
  cleanupBlockedReason?: string;
}

interface TeamPanesFile {
  instanceId: string;
  paneIds: string[];
  leaderPaneId: string;
  sessionName?: string;
  ownsWindow?: boolean;
  workers: Array<{
    workerName: string;
    paneId: string;
    launchAttemptId: string;
  }>;
}

function getTeamWorkerIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const omc = typeof env.OMC_TEAM_WORKER === 'string' ? env.OMC_TEAM_WORKER.trim() : '';
  if (omc) return omc;
  const omx = typeof env.OMX_TEAM_WORKER === 'string' ? env.OMX_TEAM_WORKER.trim() : '';
  return omx || null;
}

async function assertTeamSpawnAllowed(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const workerIdentity = getTeamWorkerIdentityFromEnv(env);
  const { teamReadManifest } = await import('../team/team-ops.js');
  const { findActiveTeamsV2 } = await import('../team/runtime-v2.js');
  const { DEFAULT_TEAM_GOVERNANCE, normalizeTeamGovernance } = await import('../team/governance.js');

  if (workerIdentity) {
    const [parentTeamName] = workerIdentity.split('/');
    const parentManifest = parentTeamName ? await teamReadManifest(parentTeamName, cwd) : null;
    const governance = normalizeTeamGovernance(parentManifest?.governance, parentManifest?.policy);
    if (!governance.nested_teams_allowed) {
      throw new Error(
        `Worker context (${workerIdentity}) cannot start nested teams because nested_teams_allowed is false.`,
      );
    }
    if (!governance.delegation_only) {
      throw new Error(
        `Worker context (${workerIdentity}) cannot start nested teams because delegation_only is false.`,
      );
    }
    return;
  }

  const activeTeams = await findActiveTeamsV2(cwd);
  for (const activeTeam of activeTeams) {
    const manifest = await teamReadManifest(activeTeam, cwd);
    const governance = normalizeTeamGovernance(manifest?.governance, manifest?.policy);
    if (governance.one_team_per_leader_session ?? DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session) {
      throw new Error(
        `Leader session already owns active team "${activeTeam}" and one_team_per_leader_session is enabled.`,
      );
    }
  }
}

function resolveJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMC_JOBS_DIR || getGlobalOmcStatePath('team-jobs');
}

function resolveRuntimeCliPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMC_RUNTIME_CLI_PATH) {
    return env.OMC_RUNTIME_CLI_PATH;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, '../../bridge/runtime-cli.cjs');
}

function ensureJobsDir(jobsDir: string): void {
  if (!existsSync(jobsDir)) {
    mkdirSync(jobsDir, { recursive: true });
  }
}

function jobPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, `${jobId}.json`);
}

function resultArtifactPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, `${jobId}-result.json`);
}

function panesArtifactPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, `${jobId}-panes.json`);
}

function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}

function parseJsonSafe<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

type JobReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; job: TeamJobRecord }
  | { kind: 'malformed'; reason: 'invalid_json' }
  | { kind: 'invalid_schema'; reason: 'invalid_schema' }
  | { kind: 'unreadable'; reason: string };

function isValidTeamJobRecord(value: unknown): value is TeamJobRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    (record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed')
    || typeof record.startedAt !== 'number'
    || !Number.isFinite(record.startedAt)
    || typeof record.teamName !== 'string'
    || record.teamName.trim().length === 0
    || typeof record.cwd !== 'string'
    || record.cwd.trim().length === 0
    || !isValidTeamInstanceId(record.instanceId)
  ) return false;
  try {
    validateTeamName(record.teamName);
  } catch {
    return false;
  }
  if (record.pid !== undefined && (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0)) return false;
  if (record.result !== undefined && typeof record.result !== 'string') return false;
  if (record.stderr !== undefined && typeof record.stderr !== 'string') return false;
  if (record.cleanedUpAt !== undefined && typeof record.cleanedUpAt !== 'string') return false;
  if (record.cleanupBlockedAt !== undefined && typeof record.cleanupBlockedAt !== 'string') return false;
  if (record.cleanupBlockedReason !== undefined && typeof record.cleanupBlockedReason !== 'string') return false;
  return true;
}

function isValidPaneArtifact(value: unknown, instanceId: string): value is TeamPanesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.instanceId !== instanceId
    || !isValidTeamInstanceId(record.instanceId)
    || !Array.isArray(record.paneIds)
    || !record.paneIds.every((paneId) => typeof paneId === 'string' && paneId.trim().length > 0)
    || new Set(record.paneIds as string[]).size !== (record.paneIds as string[]).length
    || typeof record.leaderPaneId !== 'string'
    || record.leaderPaneId.trim().length === 0
    || (record.sessionName !== undefined && (typeof record.sessionName !== 'string' || record.sessionName.trim().length === 0))
    || (record.ownsWindow !== undefined && typeof record.ownsWindow !== 'boolean')
    || !Array.isArray(record.workers)
  ) return false;
  const paneIds = new Set(record.paneIds as string[]);
  const workerNames = new Set<string>();
  const workerPaneIds = new Set<string>();
  for (const worker of record.workers) {
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) return false;
    const entry = worker as Record<string, unknown>;
    if (
      typeof entry.workerName !== 'string'
      || entry.workerName.trim().length === 0
      || workerNames.has(entry.workerName)
      || typeof entry.paneId !== 'string'
      || !paneIds.has(entry.paneId)
      || workerPaneIds.has(entry.paneId)
      || typeof entry.launchAttemptId !== 'string'
      || entry.launchAttemptId.trim().length === 0
    ) return false;
    workerNames.add(entry.workerName);
    workerPaneIds.add(entry.paneId);
  }
  return workerPaneIds.size === paneIds.size;
}

async function readPaneArtifact(
  jobsDir: string,
  jobId: string,
  instanceId: string,
): Promise<{ kind: 'missing' } | { kind: 'invalid'; reason: string } | { kind: 'valid'; artifact: TeamPanesFile }> {
  let raw: string;
  try {
    raw = await readFile(panesArtifactPath(jobsDir, jobId), 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: `cleanup_panes_evidence_unreadable:${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseJsonSafe<unknown>(raw);
  if (!isValidPaneArtifact(parsed, instanceId)) {
    return { kind: 'invalid', reason: 'cleanup_panes_evidence_corrupt' };
  }
  return { kind: 'valid', artifact: parsed };
}

function resultArtifactIdentityError(
  jobsDir: string,
  jobId: string,
  instanceId: string,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(resultArtifactPath(jobsDir, jobId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `cleanup_result_evidence_unreadable:${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = parseJsonSafe<Record<string, unknown>>(raw);
  if (
    !parsed
    || (parsed.status !== 'completed' && parsed.status !== 'failed')
    || parsed.instanceId !== instanceId
  ) {
    return 'cleanup_result_evidence_corrupt';
  }
  return null;
}

function readJobFromDisk(jobId: string, jobsDir: string): JobReadResult {
  let content: string;
  try {
    content = readFileSync(jobPath(jobsDir, jobId), 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseJsonSafe<unknown>(content);
  if (parsed === null) return { kind: 'malformed', reason: 'invalid_json' };
  if (!isValidTeamJobRecord(parsed)) return { kind: 'invalid_schema', reason: 'invalid_schema' };
  return { kind: 'valid', job: parsed };
}

function formatJobReadError(jobId: string, result: Exclude<JobReadResult, { kind: 'valid' }>): Error {
  switch (result.kind) {
    case 'missing':
      return new Error(`No job found: ${jobId}`);
    case 'malformed':
      return new Error(`Corrupt job file: ${jobId} (invalid JSON)`);
    case 'invalid_schema':
      return new Error(`Corrupt job file: ${jobId} (invalid schema)`);
    case 'unreadable':
      return new Error(`Unreadable job file: ${jobId} (${result.reason})`);
  }
}

function jobLockPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, `.${jobId}.lock`);
}

function writeJobToDiskUnlocked(jobId: string, job: TeamJobRecord, jobsDir: string): void {
  ensureJobsDir(jobsDir);
  const targetPath = jobPath(jobsDir, jobId);
  const tempPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(job), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempPath, targetPath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* renamed or never created */ }
  }
}

function writeJobToDisk(jobId: string, job: TeamJobRecord, jobsDir: string): void {
  ensureJobsDir(jobsDir);
  withProcessIdentityFileLockSync(jobLockPath(jobsDir, jobId), () =>
    writeJobToDiskUnlocked(jobId, job, jobsDir));
}

type CleanupJobPublication =
  | { kind: 'updated'; job: TeamJobRecord }
  | { kind: 'already_cleaned'; job: TeamJobRecord }
  | { kind: 'superseded'; reason: string }
  | { kind: 'blocked'; reason: string };

interface CleanupFieldSnapshot {
  cleanedUpAt?: string;
  cleanupBlockedAt?: string;
  cleanupBlockedReason?: string;
}

function mergeCleanupFields(
  jobId: string,
  jobsDir: string,
  expectedInstanceId: string,
  initial: CleanupFieldSnapshot,
  fields: {
    cleanedUpAt?: string;
    cleanupBlockedAt?: string;
    cleanupBlockedReason?: string;
    clearBlocked?: boolean;
  },
): CleanupJobPublication {
  try {
    return withProcessIdentityFileLockSync(jobLockPath(jobsDir, jobId), () => {
      const current = readJobFromDisk(jobId, jobsDir);
      if (current.kind !== 'valid') {
        return {
          kind: 'blocked',
          reason: current.kind === 'missing'
            ? 'cleanup_job_missing'
            : `cleanup_job_${current.kind}`,
        };
      }
      if (current.job.instanceId !== expectedInstanceId) {
        return {
          kind: 'blocked',
          reason: `cleanup_instance_mismatch:expected=${expectedInstanceId}:actual=${current.job.instanceId}`,
        };
      }
      if (current.job.cleanedUpAt) return { kind: 'already_cleaned', job: current.job };
      if (
        current.job.cleanupBlockedAt !== initial.cleanupBlockedAt
        || current.job.cleanupBlockedReason !== initial.cleanupBlockedReason
        || current.job.cleanedUpAt !== initial.cleanedUpAt
      ) {
        return {
          kind: 'superseded',
          reason: current.job.cleanupBlockedReason ?? 'cleanup_state_changed',
        };
      }
      const next: TeamJobRecord = { ...current.job };
      if (fields.cleanedUpAt !== undefined) next.cleanedUpAt = fields.cleanedUpAt;
      if (fields.cleanupBlockedAt !== undefined) next.cleanupBlockedAt = fields.cleanupBlockedAt;
      if (fields.cleanupBlockedReason !== undefined) next.cleanupBlockedReason = fields.cleanupBlockedReason;
      if (fields.clearBlocked) {
        delete next.cleanupBlockedAt;
        delete next.cleanupBlockedReason;
      }
      writeJobToDiskUnlocked(jobId, next, jobsDir);
      return { kind: 'updated', job: next };
    });
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `cleanup_job_lock_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function updateJobFailureIfRunning(
  jobId: string,
  jobsDir: string,
  expectedInstanceId: string,
  reason: string,
  result?: string,
): void {
  withProcessIdentityFileLockSync(jobLockPath(jobsDir, jobId), () => {
    const current = readJobFromDisk(jobId, jobsDir);
    if (
      current.kind !== 'valid'
      || current.job.instanceId !== expectedInstanceId
      || current.job.cleanedUpAt
      || current.job.status !== 'running'
    ) return;
    writeJobToDiskUnlocked(jobId, {
      ...current.job,
      status: 'failed',
      stderr: current.job.stderr ?? reason,
      ...(result !== undefined ? { result: current.job.result ?? result } : {}),
    }, jobsDir);
  });
}

function readConvergedJob(jobId: string, jobsDir: string): TeamJobRecord {
  return withProcessIdentityFileLockSync(jobLockPath(jobsDir, jobId), () => {
    const current = readJobFromDisk(jobId, jobsDir);
    if (current.kind !== 'valid') throw formatJobReadError(jobId, current);
    const converged = convergeWithResultArtifact(jobId, current.job, jobsDir);
    if (JSON.stringify(converged) !== JSON.stringify(current.job)) {
      // Artifact convergence is an authoritative status operation. It is
      // intentionally allowed to repair a terminal record; only child-close
      // callbacks freeze terminal records against late output.
      writeJobToDiskUnlocked(jobId, converged, jobsDir);
    }
    return converged;
  });
}

function blockCleanupPublication(
  jobId: string,
  jobsDir: string,
  instanceId: string,
  initial: CleanupFieldSnapshot,
  reason: string,
): TeamCleanupResult {
  const publication = mergeCleanupFields(jobId, jobsDir, instanceId, initial, {
    cleanupBlockedAt: new Date().toISOString(),
    cleanupBlockedReason: reason,
  });
  if (publication.kind === 'already_cleaned') {
    return {
      jobId,
      message: `Already cleaned up job ${jobId}; preserved any current team state`,
    };
  }
  if (publication.kind === 'blocked') {
    return {
      jobId,
      message: `Preserved team state because cleanup publication was blocked (${publication.reason})`,
    };
  }
  if (publication.kind === 'superseded') {
    return {
      jobId,
      message: `Preserved team state because a newer cleanup state superseded this attempt (${publication.reason}; attempted ${reason})`,
    };
  }
  return {
    jobId,
    message: `Preserved team state because cleanup evidence was unavailable (${reason})`,
  };
}

function parseJobResult(raw?: string): unknown {
  if (!raw) return undefined;
  const parsed = parseJsonSafe<unknown>(raw);
  return parsed ?? raw;
}

function buildStatus(jobId: string, job: TeamJobRecord): TeamJobStatus {
  return {
    jobId,
    instanceId: job.instanceId,
    status: job.status,
    elapsedSeconds: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    result: parseJobResult(job.result),
    stderr: job.stderr,
  };
}

export function generateJobId(now = Date.now()): string {
  return `omc-${now.toString(36)}${randomUUID().slice(0, 8)}`;
}

function convergeWithResultArtifact(jobId: string, job: TeamJobRecord, jobsDir: string): TeamJobRecord {
  try {
    const artifactRaw = readFileSync(resultArtifactPath(jobsDir, jobId), 'utf-8');
    const artifactParsed = parseJsonSafe<Record<string, unknown>>(artifactRaw);
    if (!artifactParsed) throw new Error('result_artifact_parse_failed');
    if (artifactParsed.status !== 'completed' && artifactParsed.status !== 'failed') {
      return job;
    }
    if (artifactParsed.instanceId !== job.instanceId) {
      throw new Error('result_artifact_identity_mismatch');
    }
    return {
      ...job,
      status: artifactParsed.status as 'completed' | 'failed',
      result: artifactRaw,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // no artifact yet
    } else {
      // A malformed or foreign result artifact is not lifecycle authority.
      // Preserve the job and surface a terminal diagnostic to status callers.
      return {
        ...job,
        status: 'failed',
        stderr: `Corrupt result artifact for ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        result: job.result ?? JSON.stringify({ error: 'result_artifact_identity_mismatch' }),
      };
    }
  }

  if (job.status === 'running' && job.pid != null && !isProcessAlive(job.pid)) {
    return {
      ...job,
      status: 'failed',
      result: job.result ?? JSON.stringify({ error: 'Process no longer alive' }),
    };
  }

  return job;
}

function output(value: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

function toInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function normalizeAgentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error('Agent type cannot be empty');
  if (!VALID_CLI_AGENT_TYPES.has(normalized)) {
    throw new Error(`Unsupported agent type: ${value}`);
  }
  return normalized;
}

function autoTeamName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
  return `omc-${slug}-${Date.now().toString(36).slice(-4)}`;
}

function parseJsonInput(inputRaw: string | undefined): Record<string, unknown> {
  if (!inputRaw || !inputRaw.trim()) return {};
  const parsed = parseJsonSafe<Record<string, unknown>>(inputRaw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid --input JSON payload');
  }
  return parsed;
}

export async function startTeamJob(input: TeamStartInput): Promise<TeamStartResult> {
  validateTeamName(input.teamName);
  if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
    throw new Error('cwd must be a non-empty path');
  }
  const cwd = resolve(input.cwd);
  await assertTeamSpawnAllowed(cwd);
  if (!Array.isArray(input.agentTypes) || input.agentTypes.length === 0) {
    throw new Error('agentTypes must be a non-empty array');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('tasks must be a non-empty array');
  }
  const runtimeV2 = await import('../team/runtime-v2.js');
  if (!runtimeV2.isRuntimeV2Enabled()) {
    throw new Error(
      'team_start_unsafe_runtime_v1: instance-bound provider cleanup requires runtime v2; set OMC_RUNTIME_V2=1',
    );
  }

  const jobsDir = resolveJobsDir();
  const runtimeCliPath = resolveRuntimeCliPath();
  const jobId = generateJobId();
  const instanceId = randomUUID();

  const job: TeamJobRecord = {
    status: 'running',
    startedAt: Date.now(),
    teamName: input.teamName,
    cwd,
    instanceId,
  };
  // Publish the immutable job identity before the runtime child can create
  // any team effects. Cleanup must never need to infer it from a team name.
  writeJobToDisk(jobId, job, jobsDir);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [runtimeCliPath], {
      env: {
        ...process.env,
        OMC_JOB_ID: jobId,
        OMC_JOBS_DIR: jobsDir,
      },
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (error) {
    try {
      updateJobFailureIfRunning(
        jobId,
        jobsDir,
        instanceId,
        `spawn error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Preserve the initial identity-bound record when its failure update
      // cannot be acquired; never overwrite a concurrent job publication.
    }
    throw error;
  }

  const persistBoundFailure = (reason: string): void => {
    try {
      updateJobFailureIfRunning(jobId, jobsDir, instanceId, reason);
    } catch {
      // A failed diagnostic write must not replace or weaken the original
      // identity-bound job record.
    }
  };

  if (typeof child.on === 'function') {
    child.on('error', (error: Error) => {
      persistBoundFailure(`spawn error: ${error.message}`);
    });
  }

  const payload = {
    teamName: input.teamName,
    instanceId,
    workerCount: input.workerCount,
    agentTypes: input.agentTypes,
    tasks: input.tasks,
    cwd,
    newWindow: input.newWindow,
    pollIntervalMs: input.pollIntervalMs,
    sentinelGateTimeoutMs: input.sentinelGateTimeoutMs,
    sentinelGatePollIntervalMs: input.sentinelGatePollIntervalMs,
    autoMerge: input.autoMerge,
  };

  if (!child.stdin || typeof child.stdin.write !== 'function' || typeof child.stdin.end !== 'function') {
    persistBoundFailure('runtime_cli_stdin_unavailable');
    if (typeof child.kill === 'function') child.kill();
    throw new Error('runtime_cli_stdin_unavailable');
  }
  if (typeof child.stdin.on === 'function') {
    child.stdin.on('error', (error: Error) => {
      persistBoundFailure(`runtime_cli_stdin_error:${error.message}`);
      try { child.kill(); } catch { /* child may have exited already */ }
    });
  }
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch (error) {
    persistBoundFailure(`runtime_cli_stdin_error:${error instanceof Error ? error.message : String(error)}`);
    if (typeof child.kill === 'function') child.kill();
    throw error;
  }
  try {
    child.unref();
  } catch (error) {
    persistBoundFailure(`runtime_cli_detach_error:${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  withProcessIdentityFileLockSync(jobLockPath(jobsDir, jobId), () => {
    const current = readJobFromDisk(jobId, jobsDir);
    if (
      current.kind !== 'valid'
      || current.job.instanceId !== instanceId
      || current.job.cleanedUpAt
      || current.job.status !== 'running'
    ) return;
    if (child.pid != null) job.pid = child.pid;
    writeJobToDiskUnlocked(jobId, {
      ...current.job,
      ...(job.pid != null ? { pid: job.pid } : {}),
    }, jobsDir);
  });

  return {
    jobId,
    instanceId,
    status: 'running',
    pid: child.pid,
  };
}

export async function getTeamJobStatus(jobId: string): Promise<TeamJobStatus> {
  validateJobId(jobId);

  const jobsDir = resolveJobsDir();
  const job = readConvergedJob(jobId, jobsDir);
  return buildStatus(jobId, job);
}

export async function waitForTeamJob(jobId: string, options: TeamWaitOptions = {}): Promise<TeamWaitResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? 300_000, 3_600_000);
  const deadline = Date.now() + timeoutMs;
  let delayMs = 500;

  while (Date.now() < deadline) {
    const status = await getTeamJobStatus(jobId);
    if (status.status !== 'running') {
      return status;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(Math.floor(delayMs * 1.5), 2000);
  }

  const status = await getTeamJobStatus(jobId);
  return {
    ...status,
    timedOut: true,
    error: `Timed out waiting for job ${jobId} after ${(timeoutMs / 1000).toFixed(0)}s`,
  };
}

export async function cleanupTeamJob(jobId: string, graceMs = 10_000): Promise<TeamCleanupResult> {
  validateJobId(jobId);

  const jobsDir = resolveJobsDir();
  const readResult = readJobFromDisk(jobId, jobsDir);
  if (readResult.kind !== 'valid') throw formatJobReadError(jobId, readResult);
  const job = readResult.job;
  const initialCleanupFields: CleanupFieldSnapshot = {
    cleanedUpAt: job.cleanedUpAt,
    cleanupBlockedAt: job.cleanupBlockedAt,
    cleanupBlockedReason: job.cleanupBlockedReason,
  };

  // A completed cleanup is terminal for this job. Never re-read current
  // same-name state on a retry: it may belong to a newer incarnation.
  if (job.cleanedUpAt) {
    return {
      jobId,
      message: `Already cleaned up job ${jobId}; preserved any current team state`,
    };
  }

  const resultEvidenceError = resultArtifactIdentityError(jobsDir, jobId, job.instanceId);
  if (resultEvidenceError) {
    return blockCleanupPublication(jobId, jobsDir, job.instanceId, initialCleanupFields, resultEvidenceError);
  }

  const paneEvidence = await readPaneArtifact(jobsDir, jobId, job.instanceId);
  if (paneEvidence.kind !== 'valid') {
    const reason = paneEvidence.kind === 'missing'
      ? 'cleanup_panes_evidence_missing'
      : paneEvidence.reason;
    return blockCleanupPublication(jobId, jobsDir, job.instanceId, initialCleanupFields, reason);
  }

  const runtimeV2 = await import('../team/runtime-v2.js');
  try {
    const shutdown = await runtimeV2.shutdownTeamV2(job.teamName, job.cwd, {
      instanceId: job.instanceId,
      force: true,
      timeoutMs: Math.max(0, graceMs),
    });
    if (shutdown.outcome !== 'cleaned') {
      const reason = shutdown.outcome === 'preserved'
        ? `${shutdown.reason}:${shutdown.workers.join(',')}`
        : `${shutdown.reason}:${shutdown.detail}`;
      return blockCleanupPublication(jobId, jobsDir, job.instanceId, initialCleanupFields, reason);
    }
  } catch (error) {
    const reason = `team_shutdown_failed:${error instanceof Error ? error.message : String(error)}`;
    return blockCleanupPublication(jobId, jobsDir, job.instanceId, initialCleanupFields, reason);
  }

  const publication = mergeCleanupFields(jobId, jobsDir, job.instanceId, initialCleanupFields, {
    cleanedUpAt: new Date().toISOString(),
    clearBlocked: true,
  });
  if (publication.kind === 'already_cleaned') {
    return {
      jobId,
      message: `Already cleaned up job ${jobId}; preserved any current team state`,
    };
  }
  if (publication.kind === 'blocked') {
    return {
      jobId,
      message: `Preserved team state because cleanup publication was blocked (${publication.reason})`,
    };
  }
  if (publication.kind === 'superseded') {
    return {
      jobId,
      message: `Preserved team state because newer cleanup state superseded this attempt (${publication.reason})`,
    };
  }
  return {
    jobId,
    message: `Cleaned up team instance ${job.instanceId}`,
  };
}

export async function teamStatusByTeamName(teamName: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  validateTeamName(teamName);

  const runtimeV2 = await import('../team/runtime-v2.js');
  if (runtimeV2.isRuntimeV2Enabled()) {
    const snapshot = await runtimeV2.monitorTeamV2(teamName, cwd);
    if (!snapshot) {
      return {
        teamName,
        running: false,
        error: 'Team state not found',
      };
    }

    const config = await readTeamConfig(teamName, cwd);
    return {
      teamName,
      running: true,
      instanceId: config?.instance_id,
      sessionName: config?.tmux_session,
      leaderPaneId: config?.leader_pane_id,
      workspace_mode: config?.workspace_mode,
      worktree_mode: config?.worktree_mode,
      team_state_root: config?.team_state_root,
      workerPaneIds: Array.from(new Set(
        (config?.workers ?? [])
          .map((worker) => worker.pane_id)
          .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0),
      )),
      workers: (config?.workers ?? []).map((worker) => ({
        name: worker.name,
        working_dir: worker.working_dir,
        worktree_repo_root: worker.worktree_repo_root,
        worktree_path: worker.worktree_path,
        worktree_branch: worker.worktree_branch,
        worktree_detached: worker.worktree_detached,
        worktree_created: worker.worktree_created,
        team_state_root: worker.team_state_root,
      })),
      snapshot,
    };
  }

  const runtime = await resumeTeam(teamName, cwd);
  if (!runtime) {
    return {
      teamName,
      running: false,
      error: 'Team session is not currently resumable',
    };
  }

  const snapshot = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
  return {
    teamName,
    running: true,
    instanceId: runtime.config.instance_id,
    sessionName: runtime.sessionName,
    leaderPaneId: runtime.leaderPaneId,
    workerPaneIds: runtime.workerPaneIds,
    snapshot,
  };
}

export async function teamResumeByName(teamName: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  validateTeamName(teamName);
  const runtime = await resumeTeam(teamName, cwd);
  if (!runtime) {
    return {
      teamName,
      resumed: false,
      error: 'Team session is not currently resumable',
    };
  }

  return {
    teamName,
    resumed: true,
    instanceId: runtime.config.instance_id,
    sessionName: runtime.sessionName,
    leaderPaneId: runtime.leaderPaneId,
    workerPaneIds: runtime.workerPaneIds,
    activeWorkers: runtime.activeWorkers.size,
  };
}

export async function teamShutdownByName(teamName: string, options: { cwd?: string; force?: boolean } = {}): Promise<Record<string, unknown>> {
  validateTeamName(teamName);
  const cwd = options.cwd ?? process.cwd();

  const runtimeV2 = await import('../team/runtime-v2.js');
  const config = await readTeamConfig(teamName, cwd);
  const instanceId = config?.instance_id;
  if (!instanceId || !isValidTeamInstanceId(instanceId)) {
    throw new Error('team_shutdown_instance_identity_missing');
  }
  const shutdown = await runtimeV2.shutdownTeamV2(teamName, cwd, {
    instanceId,
    force: Boolean(options.force),
    timeoutMs: options.force ? 0 : 30_000,
  });
  if (shutdown.outcome !== 'cleaned') {
    const reason = shutdown.outcome === 'preserved'
      ? `${shutdown.reason}:${shutdown.workers.join(',')}`
      : `${shutdown.reason}:${shutdown.detail}`;
    throw new Error(`Team shutdown ${shutdown.outcome}: ${reason}`);
  }
  return {
    teamName,
    shutdown: true,
    forced: Boolean(options.force),
    sessionFound: Boolean(config),
  };
}

export async function executeTeamApiOperation(
  operation: string,
  input: Record<string, unknown>,
  cwd = process.cwd(),
): Promise<TeamApiEnvelope> {
  const canonicalOperation = resolveTeamApiOperation(operation);
  if (!canonicalOperation || !SUPPORTED_API_OPERATIONS.has(canonicalOperation as SupportedApiOperation)) {
    return {
      ok: false,
      operation,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: `Unsupported omc team api operation: ${operation}`,
      },
    };
  }

  const normalizedInput: Record<string, unknown> = {
    ...input,
    ...(typeof input.teamName === 'string' && input.teamName.trim() !== '' && typeof input.team_name !== 'string'
      ? { team_name: input.teamName }
      : {}),
    ...(typeof input.taskId === 'string' && input.taskId.trim() !== '' && typeof input.task_id !== 'string'
      ? { task_id: input.taskId }
      : {}),
    ...(typeof input.workerName === 'string' && input.workerName.trim() !== '' && typeof input.worker !== 'string'
      ? { worker: input.workerName }
      : {}),
    ...(typeof input.fromWorker === 'string' && input.fromWorker.trim() !== '' && typeof input.from_worker !== 'string'
      ? { from_worker: input.fromWorker }
      : {}),
    ...(typeof input.toWorker === 'string' && input.toWorker.trim() !== '' && typeof input.to_worker !== 'string'
      ? { to_worker: input.toWorker }
      : {}),
    ...(typeof input.messageId === 'string' && input.messageId.trim() !== '' && typeof input.message_id !== 'string'
      ? { message_id: input.messageId }
      : {}),
    ...(typeof input.claimToken === 'string' && input.claimToken.trim() !== '' && typeof input.claim_token !== 'string'
      ? { claim_token: input.claimToken }
      : {}),
    ...(typeof input.taskVersion === 'number' && input.task_version === undefined
      ? { task_version: input.taskVersion }
      : {}),
    ...(typeof input.resumePayload !== 'undefined' && input.resume_payload === undefined
      ? { resume_payload: input.resumePayload }
      : {}),
    ...(typeof input.requestId === 'string' && input.requestId.trim() !== '' && typeof input.request_id !== 'string'
      ? { request_id: input.requestId }
      : {}),
    ...(typeof input.timeoutMs === 'number' && input.timeout_ms === undefined
      ? { timeout_ms: input.timeoutMs }
      : {}),
  };
  for (const alias of ['teamName', 'taskId', 'workerName', 'fromWorker', 'toWorker', 'messageId',
    'claimToken', 'taskVersion', 'resumePayload', 'requestId', 'timeoutMs']) {
    delete normalizedInput[alias];
  }

  const result = await executeCanonicalTeamApiOperation(canonicalOperation, normalizedInput, cwd);
  return result;
}

export async function teamStartCommand(input: TeamStartInput, options: { json?: boolean } = {}): Promise<TeamStartResult> {
  const result = await startTeamJob(input);
  output(result, Boolean(options.json));
  return result;
}

export async function teamStatusCommand(jobId: string, options: { json?: boolean } = {}): Promise<TeamJobStatus> {
  const result = await getTeamJobStatus(jobId);
  output(result, Boolean(options.json));
  return result;
}

export async function teamWaitCommand(
  jobId: string,
  waitOptions: TeamWaitOptions = {},
  options: { json?: boolean } = {},
): Promise<TeamWaitResult> {
  const result = await waitForTeamJob(jobId, waitOptions);
  output(result, Boolean(options.json));
  return result;
}

export async function teamCleanupCommand(
  jobId: string,
  cleanupOptions: { graceMs?: number } = {},
  options: { json?: boolean } = {},
): Promise<TeamCleanupResult> {
  const result = await cleanupTeamJob(jobId, cleanupOptions.graceMs);
  output(result, Boolean(options.json));
  return result;
}

export const TEAM_USAGE = `
Usage:
  omc team start --agent <claude|codex|gemini|cursor|grok|antigravity>[,<agent>...] --task "<task>" [--count N] [--name TEAM] [--cwd DIR] [--new-window] [--auto-merge] [--json]
  omc team status <job_id|team_name> [--json] [--cwd DIR]
  omc team wait <job_id> [--timeout-ms MS] [--json]
  omc team cleanup <job_id> [--grace-ms MS] [--json]
  omc team resume <team_name> [--json] [--cwd DIR]
  omc team shutdown <team_name> [--force] [--json] [--cwd DIR]
  omc team api <operation> [--input '<json>'] [--json] [--cwd DIR]
  omc team [ralph] <N:agent-type[:role]> "task" [--json] [--cwd DIR] [--new-window]

Worktrees:
  Native per-worker git worktree mode is opt-in/config-gated with team.ops.worktreeMode or OMC_TEAM_WORKTREE_MODE=detached|named.
  Status JSON includes workspace_mode, worktree_mode, team_state_root, and per-worker worktree metadata.

Auto-merge (v2-only):
  --auto-merge          Enable per-commit auto-merge to leader and auto-rebase fanout.
                        Each worker runs in a dedicated git worktree on omc-team/{team}/{worker}.
                        Bursts of rapid worker commits coalesce to a single merge of HEAD.
                        Requires OMC_RUNTIME_V2=1. Leader branch must not be 'main' or 'master'.
                        Equivalent to OMC_TEAMS_AUTO_MERGE=1.

Examples:
  omc team start --agent codex --count 2 --task "review auth flow" --new-window
  omc team status omc-abc123
  omc team status auth-review
  omc team resume auth-review
  omc team shutdown auth-review --force
  omc team api list-tasks --input '{"teamName":"auth-review"}' --json
  omc team 3:codex "refactor launch command"

Worktree mode:
  Native worker worktrees are opt-in/config-gated for runtime-v2.
  Status surfaces workspace_mode, worktree_mode, team_state_root, and worker worktree metadata when enabled.
`.trim();

interface StartArgsParsed {
  input: TeamStartInput;
  json: boolean;
}

function parseStartArgs(args: string[]): StartArgsParsed {
  const agentValues: string[] = [];
  const taskValues: string[] = [];
  let teamName: string | undefined;
  let cwd = process.cwd();
  let count = 1;
  let json = false;
  let newWindow = false;
  let subjectPrefix = 'Task';
  let pollIntervalMs: number | undefined;
  let sentinelGateTimeoutMs: number | undefined;
  let sentinelGatePollIntervalMs: number | undefined;
  // --auto-merge / OMC_TEAMS_AUTO_MERGE=1 enables the merge orchestrator (v2-only).
  let autoMerge: boolean = process.env.OMC_TEAMS_AUTO_MERGE === '1';

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--new-window') {
      newWindow = true;
      continue;
    }
    if (token === '--auto-merge') {
      autoMerge = true;
      continue;
    }

    if (token === '--agent') {
      if (!next) throw new Error('Missing value after --agent');
      agentValues.push(...next.split(',').map(normalizeAgentType));
      i += 1;
      continue;
    }
    if (token.startsWith('--agent=')) {
      agentValues.push(...token.slice('--agent='.length).split(',').map(normalizeAgentType));
      continue;
    }

    if (token === '--task') {
      if (!next) throw new Error('Missing value after --task');
      taskValues.push(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--task=')) {
      taskValues.push(token.slice('--task='.length));
      continue;
    }

    if (token === '--count') {
      if (!next) throw new Error('Missing value after --count');
      count = toInt(next, '--count');
      i += 1;
      continue;
    }
    if (token.startsWith('--count=')) {
      count = toInt(token.slice('--count='.length), '--count');
      continue;
    }

    if (token === '--name') {
      if (!next) throw new Error('Missing value after --name');
      teamName = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--name=')) {
      teamName = token.slice('--name='.length);
      continue;
    }

    if (token === '--cwd') {
      if (!next) throw new Error('Missing value after --cwd');
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }

    if (token === '--subject') {
      if (!next) throw new Error('Missing value after --subject');
      subjectPrefix = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--subject=')) {
      subjectPrefix = token.slice('--subject='.length);
      continue;
    }

    if (token === '--poll-interval-ms') {
      if (!next) throw new Error('Missing value after --poll-interval-ms');
      pollIntervalMs = toInt(next, '--poll-interval-ms');
      i += 1;
      continue;
    }
    if (token.startsWith('--poll-interval-ms=')) {
      pollIntervalMs = toInt(token.slice('--poll-interval-ms='.length), '--poll-interval-ms');
      continue;
    }

    if (token === '--sentinel-gate-timeout-ms') {
      if (!next) throw new Error('Missing value after --sentinel-gate-timeout-ms');
      sentinelGateTimeoutMs = toInt(next, '--sentinel-gate-timeout-ms');
      i += 1;
      continue;
    }
    if (token.startsWith('--sentinel-gate-timeout-ms=')) {
      sentinelGateTimeoutMs = toInt(token.slice('--sentinel-gate-timeout-ms='.length), '--sentinel-gate-timeout-ms');
      continue;
    }

    if (token === '--sentinel-gate-poll-interval-ms') {
      if (!next) throw new Error('Missing value after --sentinel-gate-poll-interval-ms');
      sentinelGatePollIntervalMs = toInt(next, '--sentinel-gate-poll-interval-ms');
      i += 1;
      continue;
    }
    if (token.startsWith('--sentinel-gate-poll-interval-ms=')) {
      sentinelGatePollIntervalMs = toInt(token.slice('--sentinel-gate-poll-interval-ms='.length), '--sentinel-gate-poll-interval-ms');
      continue;
    }

    throw new Error(`Unknown argument for "omc team start": ${token}`);
  }

  if (count < 1) throw new Error('--count must be >= 1');
  if (agentValues.length === 0) throw new Error('Missing required --agent');
  if (taskValues.length === 0) throw new Error('Missing required --task');

  const agentTypes = agentValues.length === 1
    ? Array.from({ length: count }, () => agentValues[0])
    : [...agentValues];

  if (agentValues.length > 1 && count !== 1) {
    throw new Error('Do not combine --count with multiple --agent values; either use one agent+count or explicit agent list.');
  }

  const taskDescriptions = taskValues.length === 1
    ? Array.from({ length: agentTypes.length }, () => taskValues[0])
    : [...taskValues];

  if (taskDescriptions.length !== agentTypes.length) {
    throw new Error(`Task count (${taskDescriptions.length}) must match worker count (${agentTypes.length}).`);
  }

  const resolvedTeamName = (teamName && teamName.trim()) ? teamName.trim() : autoTeamName(taskDescriptions[0]);
  const tasks: TeamTaskInput[] = taskDescriptions.map((description, index) => ({
    subject: `${subjectPrefix} ${index + 1}`,
    description,
  }));

  return {
    input: {
      teamName: resolvedTeamName,
      agentTypes,
      tasks,
      cwd,
      ...(newWindow ? { newWindow: true } : {}),
      ...(pollIntervalMs != null ? { pollIntervalMs } : {}),
      ...(sentinelGateTimeoutMs != null ? { sentinelGateTimeoutMs } : {}),
      ...(sentinelGatePollIntervalMs != null ? { sentinelGatePollIntervalMs } : {}),
      ...(autoMerge ? { autoMerge: true } : {}),
    },
    json,
  };
}

function parseCommonJobArgs(args: string[], command: 'status' | 'wait' | 'cleanup'): {
  target: string;
  json: boolean;
  cwd?: string;
  timeoutMs?: number;
  graceMs?: number;
} {
  let json = false;
  let target: string | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  let graceMs: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (!token.startsWith('-') && !target) {
      target = token;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--cwd') {
      if (!next) throw new Error('Missing value after --cwd');
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }

    if (token === '--job-id') {
      if (!next) throw new Error('Missing value after --job-id');
      target = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--job-id=')) {
      target = token.slice('--job-id='.length);
      continue;
    }

    if (command === 'wait') {
      if (token === '--timeout-ms') {
        if (!next) throw new Error('Missing value after --timeout-ms');
        timeoutMs = toInt(next, '--timeout-ms');
        i += 1;
        continue;
      }
      if (token.startsWith('--timeout-ms=')) {
        timeoutMs = toInt(token.slice('--timeout-ms='.length), '--timeout-ms');
        continue;
      }
    }

    if (command === 'cleanup') {
      if (token === '--grace-ms') {
        if (!next) throw new Error('Missing value after --grace-ms');
        graceMs = toInt(next, '--grace-ms');
        i += 1;
        continue;
      }
      if (token.startsWith('--grace-ms=')) {
        graceMs = toInt(token.slice('--grace-ms='.length), '--grace-ms');
        continue;
      }
    }

    throw new Error(`Unknown argument for "omc team ${command}": ${token}`);
  }

  if (!target) {
    throw new Error(`Missing required target for "omc team ${command}".`);
  }

  return {
    target,
    json,
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(graceMs != null ? { graceMs } : {}),
  };
}

function parseTeamTargetArgs(args: string[], command: 'resume' | 'shutdown'): {
  teamName: string;
  json: boolean;
  cwd?: string;
  force?: boolean;
} {
  let teamName: string | undefined;
  let json = false;
  let cwd: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (!token.startsWith('-') && !teamName) {
      teamName = token;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--cwd') {
      if (!next) throw new Error('Missing value after --cwd');
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }
    if (command === 'shutdown' && token === '--force') {
      force = true;
      continue;
    }

    throw new Error(`Unknown argument for "omc team ${command}": ${token}`);
  }

  if (!teamName) {
    throw new Error(`Missing required <team_name> for "omc team ${command}".`);
  }

  return {
    teamName,
    json,
    ...(cwd ? { cwd } : {}),
    ...(command === 'shutdown' ? { force } : {}),
  };
}

function parseApiArgs(args: string[]): {
  operation: string;
  input: Record<string, unknown>;
  json: boolean;
  cwd?: string;
} {
  let operation: string | undefined;
  let inputRaw: string | undefined;
  let json = false;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (!token.startsWith('-') && !operation) {
      operation = token;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--input') {
      if (!next) throw new Error('Missing value after --input');
      inputRaw = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--input=')) {
      inputRaw = token.slice('--input='.length);
      continue;
    }
    if (token === '--cwd') {
      if (!next) throw new Error('Missing value after --cwd');
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }

    throw new Error(`Unknown argument for "omc team api": ${token}`);
  }

  if (!operation) {
    throw new Error(`Missing required <operation> for "omc team api"\n\n${TEAM_API_USAGE}`);
  }

  return {
    operation,
    input: parseJsonInput(inputRaw),
    json,
    ...(cwd ? { cwd } : {}),
  };
}

function parseLegacyStartAlias(args: string[]): TeamLegacyStartArgs | null {
  if (args.length < 2) return null;

  let index = 0;
  let ralph = false;
  if (args[index]?.toLowerCase() === 'ralph') {
    ralph = true;
    index += 1;
  }

  const spec = args[index];
  if (!spec) return null;
  const match = spec.match(/^(\d+):([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_-]+))?$/);
  if (!match) return null;

  let workerCount = toInt(match[1], 'worker-count');
  if (workerCount < 1) throw new Error('worker-count must be >= 1');

  let agentType = normalizeAgentType(match[2]);
  const role = match[3] || undefined;
  index += 1;

  let json = false;
  let cwd = process.cwd();
  let newWindow = false;
  let autoMerge: boolean = process.env.OMC_TEAMS_AUTO_MERGE === '1';
  const taskParts: string[] = [];
  for (let i = index; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];

    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--new-window') {
      newWindow = true;
      continue;
    }
    if (token === '--auto-merge') {
      autoMerge = true;
      continue;
    }
    if (token === '--cwd') {
      if (!next) throw new Error('Missing value after --cwd');
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }

    taskParts.push(token);
  }

  let task = taskParts.join(' ').trim();
  if (!task) throw new Error('Legacy start alias requires a task string');

  const shortFollowup = ['team', '/team', 'team please', 'run team', 'start team'].includes(task.toLowerCase());
  if (shortFollowup) {
    const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
      requirePlanningComplete: true,
    });
    if (approvedHintOutcome.status === 'ambiguous') {
      throw new Error('approved_execution_hint_ambiguous:team');
    }
    if (approvedHintOutcome.status === 'incomplete') {
      throw new Error('approved_execution_hint_incomplete:team');
    }
    if (approvedHintOutcome.status === 'resolved') {
      task = approvedHintOutcome.hint.task;
      workerCount = approvedHintOutcome.hint.workerCount ?? workerCount;
      agentType = approvedHintOutcome.hint.agentType
        ? normalizeAgentType(approvedHintOutcome.hint.agentType)
        : agentType;
      ralph = approvedHintOutcome.hint.linkedRalph === true ? true : ralph;
    }
  } else {
    const command = `omc team ${ralph ? 'ralph ' : ''}${spec} ${JSON.stringify(task)}`;
    const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
      task,
      command,
    });
    if (approvedHintOutcome.status === 'ambiguous') {
      throw new Error('approved_execution_hint_ambiguous:team');
    }
  }

  return {
    workerCount,
    agentType,
    role,
    task,
    teamName: autoTeamName(task),
    ralph,
    json,
    cwd,
    ...(newWindow ? { newWindow: true } : {}),
    ...(autoMerge ? { autoMerge: true } : {}),
  };
}

export async function teamCommand(argv: string[]): Promise<void> {
  const [commandRaw, ...rest] = argv;
  const command = (commandRaw || '').toLowerCase();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TEAM_USAGE);
    return;
  }

  if (command === 'start') {
    const parsed = parseStartArgs(rest);
    await teamStartCommand(parsed.input, { json: parsed.json });
    return;
  }

  if (command === 'status') {
    const parsed = parseCommonJobArgs(rest, 'status');
    if (JOB_ID_PATTERN.test(parsed.target)) {
      await teamStatusCommand(parsed.target, { json: parsed.json });
      return;
    }

    const byTeam = await teamStatusByTeamName(parsed.target, parsed.cwd ?? process.cwd());
    output(byTeam, parsed.json);
    return;
  }

  if (command === 'wait') {
    const parsed = parseCommonJobArgs(rest, 'wait');
    await teamWaitCommand(parsed.target, { ...(parsed.timeoutMs != null ? { timeoutMs: parsed.timeoutMs } : {}) }, { json: parsed.json });
    return;
  }

  if (command === 'cleanup') {
    const parsed = parseCommonJobArgs(rest, 'cleanup');
    await teamCleanupCommand(parsed.target, { ...(parsed.graceMs != null ? { graceMs: parsed.graceMs } : {}) }, { json: parsed.json });
    return;
  }

  if (command === 'resume') {
    const parsed = parseTeamTargetArgs(rest, 'resume');
    const result = await teamResumeByName(parsed.teamName, parsed.cwd ?? process.cwd());
    output(result, parsed.json);
    return;
  }

  if (command === 'shutdown') {
    const parsed = parseTeamTargetArgs(rest, 'shutdown');
    const result = await teamShutdownByName(parsed.teamName, {
      cwd: parsed.cwd ?? process.cwd(),
      force: Boolean(parsed.force),
    });
    output(result, parsed.json);
    return;
  }

  if (command === 'api') {
    if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') {
      console.log(TEAM_API_USAGE);
      return;
    }

    const parsed = parseApiArgs(rest);
    const result = await executeTeamApiOperation(parsed.operation, parsed.input, parsed.cwd ?? process.cwd());
    if (!result.ok && !parsed.json) {
      throw new Error(result.error?.message ?? 'Team API operation failed');
    }
    output(result, parsed.json);
    return;
  }

  if (!SUBCOMMANDS.has(command)) {
    const legacy = parseLegacyStartAlias(argv);
    if (legacy) {
      const tasks = Array.from({ length: legacy.workerCount }, (_, idx) => ({
        subject: legacy.ralph ? `Ralph Task ${idx + 1}` : `Task ${idx + 1}`,
        description: legacy.task,
      }));

      const result = await startTeamJob({
        teamName: legacy.teamName,
        workerCount: legacy.workerCount,
        agentTypes: Array.from({ length: legacy.workerCount }, () => legacy.agentType),
        tasks,
        cwd: legacy.cwd,
        ...(legacy.newWindow ? { newWindow: true } : {}),
        ...(legacy.autoMerge ? { autoMerge: true } : {}),
      });

      output(result, legacy.json);
      return;
    }
  }

  throw new Error(`Unknown team command: ${command}\n\n${TEAM_USAGE}`);
}

export async function main(argv: string[]): Promise<void> {
  await teamCommand(argv);
}
