import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readFile, readdir, rm } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { executeTeamApiOperation as executeCanonicalTeamApiOperation, resolveTeamApiOperation } from '../team/api-interop.js';
import { cleanupTeamWorktrees } from '../team/git-worktree.js';
import { killWorkerPanes, killTeamSession } from '../team/tmux-session.js';
import { validateTeamName } from '../team/team-name.js';
import { monitorTeam, resumeTeam, shutdownTeam } from '../team/runtime.js';
import { readTeamConfig } from '../team/monitor.js';

const JOB_ID_PATTERN = /^omc-[a-z0-9]{1,12}$/;
const VALID_CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini']);
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
  | 'get-summary';

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
}

export interface TeamStartResult {
  jobId: string;
  status: 'running';
  pid?: number;
}

export interface TeamJobStatus {
  jobId: string;
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
  pid?: number;
  result?: string;
  stderr?: string;
  cleanedUpAt?: string;
}

interface TeamPanesFile {
  paneIds: string[];
  leaderPaneId: string;
  sessionName?: string;
  ownsWindow?: boolean;
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
  return env.OMC_JOBS_DIR || join(homedir(), '.omc', 'team-jobs');
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

function teamStateRoot(cwd: string, teamName: string): string {
  return join(cwd, '.omc', 'state', 'team', teamName);
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

function readJobFromDisk(jobId: string, jobsDir: string): TeamJobRecord | null {
  try {
    const content = readFileSync(jobPath(jobsDir, jobId), 'utf-8');
    return parseJsonSafe<TeamJobRecord>(content);
  } catch {
    return null;
  }
}

function writeJobToDisk(jobId: string, job: TeamJobRecord, jobsDir: string): void {
  ensureJobsDir(jobsDir);
  writeFileSync(jobPath(jobsDir, jobId), JSON.stringify(job), 'utf-8');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseJobResult(raw?: string): unknown {
  if (!raw) return undefined;
  const parsed = parseJsonSafe<unknown>(raw);
  return parsed ?? raw;
}

function buildStatus(jobId: string, job: TeamJobRecord): TeamJobStatus {
  return {
    jobId,
    status: job.status,
    elapsedSeconds: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    result: parseJobResult(job.result),
    stderr: job.stderr,
  };
}

function generateJobId(now = Date.now()): string {
  return `omc-${now.toString(36)}`;
}

function convergeWithResultArtifact(jobId: string, job: TeamJobRecord, jobsDir: string): TeamJobRecord {
  try {
    const artifactRaw = readFileSync(resultArtifactPath(jobsDir, jobId), 'utf-8');
    const artifactParsed = parseJsonSafe<{ status?: string }>(artifactRaw);
    if (artifactParsed?.status === 'completed' || artifactParsed?.status === 'failed') {
      return {
        ...job,
        status: artifactParsed.status,
        result: artifactRaw,
      };
    }
  } catch {
    // no artifact yet
  }

  if (job.status === 'running' && job.pid != null && !isPidAlive(job.pid)) {
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

function readInputString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

async function readTaskFiles(cwd: string, teamName: string): Promise<Array<Record<string, unknown>>> {
  const tasksDir = join(teamStateRoot(cwd, teamName), 'tasks');
  let files: string[] = [];
  try {
    files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = await readFile(join(tasksDir, file), 'utf-8');
        const parsed = parseJsonSafe<Record<string, unknown>>(raw);
        return parsed ?? null;
      } catch {
        return null;
      }
    }),
  );

  return loaded.filter((v): v is Record<string, unknown> => v !== null);
}

export async function startTeamJob(input: TeamStartInput): Promise<TeamStartResult> {
  await assertTeamSpawnAllowed(input.cwd);
  validateTeamName(input.teamName);
  if (!Array.isArray(input.agentTypes) || input.agentTypes.length === 0) {
    throw new Error('agentTypes must be a non-empty array');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('tasks must be a non-empty array');
  }

  const jobsDir = resolveJobsDir();
  const runtimeCliPath = resolveRuntimeCliPath();
  const jobId = generateJobId();

  const job: TeamJobRecord = {
    status: 'running',
    startedAt: Date.now(),
    teamName: input.teamName,
    cwd: input.cwd,
  };

  const child = spawn('node', [runtimeCliPath], {
    env: {
      ...process.env,
      OMC_JOB_ID: jobId,
      OMC_JOBS_DIR: jobsDir,
    },
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const payload = {
    teamName: input.teamName,
    workerCount: input.workerCount,
    agentTypes: input.agentTypes,
    tasks: input.tasks,
    cwd: input.cwd,
    newWindow: input.newWindow,
    pollIntervalMs: input.pollIntervalMs,
    sentinelGateTimeoutMs: input.sentinelGateTimeoutMs,
    sentinelGatePollIntervalMs: input.sentinelGatePollIntervalMs,
  };

  if (child.stdin && typeof child.stdin.on === 'function') {
    child.stdin.on('error', () => {});
  }
  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
  child.unref();

  if (child.pid != null) {
    job.pid = child.pid;
  }
  writeJobToDisk(jobId, job, jobsDir);

  return {
    jobId,
    status: 'running',
    pid: child.pid,
  };
}

export async function getTeamJobStatus(jobId: string): Promise<TeamJobStatus> {
  validateJobId(jobId);

  const jobsDir = resolveJobsDir();
  const job = readJobFromDisk(jobId, jobsDir);
  if (!job) {
    throw new Error(`No job found: ${jobId}`);
  }

  const converged = convergeWithResultArtifact(jobId, job, jobsDir);
  if (JSON.stringify(converged) !== JSON.stringify(job)) {
    writeJobToDisk(jobId, converged, jobsDir);
  }

  return buildStatus(jobId, converged);
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
  const job = readJobFromDisk(jobId, jobsDir);
  if (!job) {
    throw new Error(`No job found: ${jobId}`);
  }

  const paneArtifact = await readFile(panesArtifactPath(jobsDir, jobId), 'utf-8')
    .then((content) => parseJsonSafe<TeamPanesFile>(content))
    .catch(() => null);

  if (paneArtifact?.sessionName && (paneArtifact.ownsWindow === true || !paneArtifact.sessionName.includes(':'))) {
    const sessionMode = paneArtifact.ownsWindow === true
      ? (paneArtifact.sessionName.includes(':') ? 'dedicated-window' : 'detached-session')
      : 'detached-session';
    await killTeamSession(
      paneArtifact.sessionName,
      paneArtifact.paneIds,
      paneArtifact.leaderPaneId,
      { sessionMode },
    );
  } else if (paneArtifact?.paneIds?.length) {
    await killWorkerPanes({
      paneIds: paneArtifact.paneIds,
      leaderPaneId: paneArtifact.leaderPaneId,
      teamName: job.teamName,
      cwd: job.cwd,
      graceMs,
    });
  }

  await rm(teamStateRoot(job.cwd, job.teamName), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  try {
    cleanupTeamWorktrees(job.teamName, job.cwd);
  } catch {
    // best-effort for dormant team-owned worktree infrastructure
  }

  writeJobToDisk(jobId, {
    ...job,
    cleanedUpAt: new Date().toISOString(),
  }, jobsDir);

  return {
    jobId,
    message: paneArtifact?.ownsWindow
      ? 'Cleaned up team tmux window'
      : paneArtifact?.paneIds?.length
        ? `Cleaned up ${paneArtifact.paneIds.length} worker pane(s)`
        : 'No worker pane ids found for this job',
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
      sessionName: config?.tmux_session,
      leaderPaneId: config?.leader_pane_id,
      workerPaneIds: (config?.workers ?? []).map((worker) => worker.pane_id).filter((paneId): paneId is string => typeof paneId === 'string'),
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
  if (runtimeV2.isRuntimeV2Enabled()) {
    const config = await readTeamConfig(teamName, cwd);
    await runtimeV2.shutdownTeamV2(teamName, cwd, { force: Boolean(options.force) });
    return {
      teamName,
      shutdown: true,
      forced: Boolean(options.force),
      sessionFound: Boolean(config),
    };
  }

  const runtime = await resumeTeam(teamName, cwd);

  if (!runtime) {
    if (options.force) {
      await rm(teamStateRoot(cwd, teamName), { recursive: true, force: true }).catch(() => undefined);
      return {
        teamName,
        shutdown: true,
        forced: true,
        sessionFound: false,
      };
    }

    throw new Error(`Team ${teamName} is not running. Use --force to clear stale state.`);
  }

  await shutdownTeam(
    runtime.teamName,
    runtime.sessionName,
    runtime.cwd,
    options.force ? 0 : 30_000,
    runtime.workerPaneIds,
    runtime.leaderPaneId,
    runtime.ownsWindow,
  );

  return {
    teamName,
    shutdown: true,
    forced: Boolean(options.force),
    sessionFound: true,
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

  const normalizedInput = {
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
  };

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
  omc team start --agent <claude|codex|gemini>[,<agent>...] --task "<task>" [--count N] [--name TEAM] [--cwd DIR] [--new-window] [--json]
  omc team status <job_id|team_name> [--json] [--cwd DIR]
  omc team wait <job_id> [--timeout-ms MS] [--json]
  omc team cleanup <job_id> [--grace-ms MS] [--json]
  omc team resume <team_name> [--json] [--cwd DIR]
  omc team shutdown <team_name> [--force] [--json] [--cwd DIR]
  omc team api <operation> [--input '<json>'] [--json] [--cwd DIR]
  omc team [ralph] <N:agent-type[:role]> "task" [--json] [--cwd DIR] [--new-window]

Examples:
  omc team start --agent codex --count 2 --task "review auth flow" --new-window
  omc team status omc-abc123
  omc team status auth-review
  omc team resume auth-review
  omc team shutdown auth-review --force
  omc team api list-tasks --input '{"teamName":"auth-review"}' --json
  omc team 3:codex "refactor launch command"
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

  const workerCount = toInt(match[1], 'worker-count');
  if (workerCount < 1) throw new Error('worker-count must be >= 1');

  const agentType = normalizeAgentType(match[2]);
  const role = match[3] || undefined;
  index += 1;

  let json = false;
  let cwd = process.cwd();
  let newWindow = false;
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

  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('Legacy start alias requires a task string');

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
