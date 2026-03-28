#!/usr/bin/env node
/**
 * Team MCP Server - tmux CLI worker runtime tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { killWorkerPanes, killTeamSession } from '../team/tmux-session.js';
import { validateTeamName } from '../team/team-name.js';
import { NudgeTracker } from '../team/idle-nudge.js';
import {
  clearScopedTeamState,
  convergeJobWithResultArtifact,
  isJobTerminal,
} from './team-job-convergence.js';
import { isProcessAlive } from '../platform/index.js';
import type { OmcTeamJob } from './team-job-convergence.js';
import { getGlobalOmcStatePath } from '../utils/paths.js';

const omcTeamJobs = new Map<string, OmcTeamJob>();
const OMC_JOBS_DIR = process.env.OMC_JOBS_DIR || getGlobalOmcStatePath('team-jobs');
const DEPRECATION_CODE = 'deprecated_cli_only' as const;

type DeprecatedTeamToolName =
  | 'omc_run_team_start'
  | 'omc_run_team_status'
  | 'omc_run_team_wait'
  | 'omc_run_team_cleanup';

const TEAM_CLI_REPLACEMENT_HINTS: Record<DeprecatedTeamToolName, string> = {
  omc_run_team_start: 'omc team start',
  omc_run_team_status: 'omc team status <job_id>',
  omc_run_team_wait: 'omc team wait <job_id>',
  omc_run_team_cleanup: 'omc team cleanup <job_id>',
};

function isDeprecatedTeamToolName(name: string): name is DeprecatedTeamToolName {
  return Object.prototype.hasOwnProperty.call(TEAM_CLI_REPLACEMENT_HINTS, name);
}

export function createDeprecatedCliOnlyEnvelope(toolName: DeprecatedTeamToolName): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return createDeprecatedCliOnlyEnvelopeWithArgs(toolName);
}

function quoteCliValue(value: string): string {
  return JSON.stringify(value);
}

function buildCliReplacement(toolName: DeprecatedTeamToolName, args: unknown): string {
  const hasArgsObject = typeof args === 'object' && args !== null;
  if (!hasArgsObject) {
    return TEAM_CLI_REPLACEMENT_HINTS[toolName];
  }

  const parsed = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};

  if (toolName === 'omc_run_team_start') {
    const teamName = typeof parsed.teamName === 'string' ? parsed.teamName.trim() : '';
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.trim() : '';
    const newWindow = parsed.newWindow === true;
    const agentTypes = Array.isArray(parsed.agentTypes)
      ? parsed.agentTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
        .map((task) => (typeof task === 'object' && task !== null && typeof (task as { description?: unknown }).description === 'string')
          ? (task as { description: string }).description.trim()
          : '',
        )
        .filter(Boolean)
      : [];

    const flags: string[] = ['omc', 'team', 'start'];
    if (teamName) flags.push('--name', quoteCliValue(teamName));
    if (cwd) flags.push('--cwd', quoteCliValue(cwd));
    if (newWindow) flags.push('--new-window');

    if (agentTypes.length > 0) {
      const uniqueAgentTypes = new Set(agentTypes);
      if (uniqueAgentTypes.size === 1) {
        flags.push('--agent', quoteCliValue(agentTypes[0]), '--count', String(agentTypes.length));
      } else {
        flags.push('--agent', quoteCliValue(agentTypes.join(',')));
      }
    } else {
      flags.push('--agent', '"claude"');
    }

    if (tasks.length > 0) {
      for (const task of tasks) {
        flags.push('--task', quoteCliValue(task));
      }
    } else {
      flags.push('--task', '"<task>"');
    }

    return flags.join(' ');
  }

  const jobId = typeof parsed.job_id === 'string' ? parsed.job_id.trim() : '<job_id>';
  if (toolName === 'omc_run_team_status') {
    return `omc team status --job-id ${quoteCliValue(jobId)}`;
  }

  if (toolName === 'omc_run_team_wait') {
    const timeoutMs = typeof parsed.timeout_ms === 'number' && Number.isFinite(parsed.timeout_ms)
      ? ` --timeout-ms ${Math.floor(parsed.timeout_ms)}`
      : '';
    return `omc team wait --job-id ${quoteCliValue(jobId)}${timeoutMs}`;
  }

  if (toolName === 'omc_run_team_cleanup') {
    const graceMs = typeof parsed.grace_ms === 'number' && Number.isFinite(parsed.grace_ms)
      ? ` --grace-ms ${Math.floor(parsed.grace_ms)}`
      : '';
    return `omc team cleanup --job-id ${quoteCliValue(jobId)}${graceMs}`;
  }

  return TEAM_CLI_REPLACEMENT_HINTS[toolName];
}

export function createDeprecatedCliOnlyEnvelopeWithArgs(
  toolName: DeprecatedTeamToolName,
  args?: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const cliReplacement = buildCliReplacement(toolName, args);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        code: DEPRECATION_CODE,
        tool: toolName,
        message: 'Legacy team MCP runtime tools are deprecated. Use the omc team CLI instead.',
        cli_replacement: cliReplacement,
      }),
    }],
    isError: true,
  };
}

function persistJob(jobId: string, job: OmcTeamJob): void {
  try {
    if (!existsSync(OMC_JOBS_DIR)) mkdirSync(OMC_JOBS_DIR, { recursive: true });
    writeFileSync(join(OMC_JOBS_DIR, `${jobId}.json`), JSON.stringify(job), 'utf-8');
  } catch { /* best-effort */ }
}

function loadJobFromDisk(jobId: string): OmcTeamJob | undefined {
  try {
    return JSON.parse(readFileSync(join(OMC_JOBS_DIR, `${jobId}.json`), 'utf-8')) as OmcTeamJob;
  } catch {
    return undefined;
  }
}

async function loadPaneIds(jobId: string): Promise<{ paneIds: string[]; leaderPaneId: string; sessionName?: string; ownsWindow?: boolean } | null> {
  const p = join(OMC_JOBS_DIR, `${jobId}-panes.json`);
  try { return JSON.parse(await readFile(p, 'utf-8')); }
  catch { return null; }
}

function validateJobId(job_id: string): void {
  if (!/^omc-[a-z0-9]{1,16}$/.test(job_id)) {
    throw new Error(`Invalid job_id: "${job_id}". Must match /^omc-[a-z0-9]{1,16}$/`);
  }
}

function saveJobState(jobId: string, job: OmcTeamJob): OmcTeamJob {
  omcTeamJobs.set(jobId, job);
  persistJob(jobId, job);
  return job;
}

function makeJobResponse(jobId: string, job: OmcTeamJob, extra: Record<string, unknown> = {}): { content: Array<{ type: 'text'; text: string }> } {
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
  const out: Record<string, unknown> = { jobId, status: job.status, elapsedSeconds: elapsed, ...extra };
  if (job.result) { try { out.result = JSON.parse(job.result) as unknown; } catch { out.result = job.result; } }
  if (job.stderr) out.stderr = job.stderr;
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

const startSchema = z.object({
  teamName: z.string().describe('Slug name for the team (e.g. "auth-review")'),
  agentTypes: z.array(z.string()).describe('Agent type per worker: "claude", "codex", or "gemini"'),
  tasks: z.array(z.object({
    subject: z.string().describe('Brief task title'),
    description: z.string().describe('Full task description'),
  })).describe('Tasks to distribute to workers'),
  cwd: z.string().describe('Working directory (absolute path)'),
  newWindow: z.boolean().optional().describe('Spawn workers in a dedicated tmux window instead of splitting the current window'),
});

const statusSchema = z.object({
  job_id: z.string().describe('Job ID returned by omc_run_team_start'),
});

const waitSchema = z.object({
  job_id: z.string().describe('Job ID returned by omc_run_team_start'),
  timeout_ms: z.number().optional().describe('Maximum wait time in ms (default: 300000, max: 3600000)'),
  nudge_delay_ms: z.number().optional().describe('Milliseconds a pane must be idle before nudging (default: 30000)'),
  nudge_max_count: z.number().optional().describe('Maximum nudges per pane (default: 3)'),
  nudge_message: z.string().optional().describe('Message sent as nudge (default: "Continue working on your assigned task and report concrete progress (not ACK-only).")'),
});

const cleanupSchema = z.object({
  job_id: z.string().describe('Job ID returned by omc_run_team_start'),
  grace_ms: z.number().optional().describe('Grace period in ms before force-killing panes (default: 10000)'),
});

async function handleStart(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (
    typeof args === 'object'
    && args !== null
    && Object.prototype.hasOwnProperty.call(args, 'timeoutSeconds')
  ) {
    throw new Error(
      'omc_run_team_start no longer accepts timeoutSeconds. Remove timeoutSeconds and use omc_run_team_wait timeout_ms to limit the wait call only (workers keep running until completion or explicit omc_run_team_cleanup).',
    );
  }

  const input = startSchema.parse(args);
  validateTeamName(input.teamName);
  const jobId = `omc-${Date.now().toString(36)}`;
  const runtimeCliPath = join(__dirname, 'runtime-cli.cjs');

  const job: OmcTeamJob = { status: 'running', startedAt: Date.now(), teamName: input.teamName, cwd: input.cwd };
  omcTeamJobs.set(jobId, job);

  const child = spawn('node', [runtimeCliPath], {
    env: { ...process.env, OMC_JOB_ID: jobId, OMC_JOBS_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  job.pid = child.pid;
  persistJob(jobId, job);

  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => outChunks.push(c));
  child.stderr.on('data', (c: Buffer) => errChunks.push(c));

  child.on('close', (code) => {
    const stdout = Buffer.concat(outChunks).toString('utf-8').trim();
    const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout) as { status?: string };
        const s = parsed.status;
        if (job.status === 'running') {
          job.status = (s === 'completed' || s === 'failed') ? s : 'failed';
        }
      } catch {
        if (job.status === 'running') job.status = 'failed';
      }
      job.result = stdout;
    }
    if (job.status === 'running') {
      if (code === 0) job.status = 'completed';
      else job.status = 'failed';
    }
    if (stderr) job.stderr = stderr;
    persistJob(jobId, job);
  });

  child.on('error', (err: Error) => {
    job.status = 'failed';
    job.stderr = `spawn error: ${err.message}`;
    persistJob(jobId, job);
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ jobId, pid: job.pid, message: 'Team started. Poll with omc_run_team_status.' }) }],
  };
}

export async function handleStatus(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id } = statusSchema.parse(args);
  validateJobId(job_id);

  let job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
  if (!job) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
  }

  // Precedence: artifact terminal > job.status/result > pid liveness.
  const artifactConvergence = convergeJobWithResultArtifact(job, job_id, OMC_JOBS_DIR);
  if (artifactConvergence.changed) {
    job = saveJobState(job_id, artifactConvergence.job);
    return makeJobResponse(job_id, job);
  }

  if (isJobTerminal(job)) {
    return makeJobResponse(job_id, job);
  }

  if (job.pid != null && !isProcessAlive(job.pid)) {
    job = saveJobState(job_id, {
      ...job,
      status: 'failed',
      result: job.result ?? JSON.stringify({ error: 'Process no longer alive (MCP restart?)' }),
    });
  }

  return makeJobResponse(job_id, job);
}

export async function handleWait(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id, timeout_ms = 300_000, nudge_delay_ms, nudge_max_count, nudge_message } = waitSchema.parse(args);
  validateJobId(job_id);

  const deadline = Date.now() + Math.min(timeout_ms, 3_600_000);
  let pollDelay = 500;

  const nudgeTracker = new NudgeTracker({
    ...(nudge_delay_ms != null ? { delayMs: nudge_delay_ms } : {}),
    ...(nudge_max_count != null ? { maxCount: nudge_max_count } : {}),
    ...(nudge_message != null ? { message: nudge_message } : {}),
  });

  while (Date.now() < deadline) {
    let job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
    if (!job) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
    }

    // Precedence: artifact terminal > job.status/result > pid liveness > timeout.
    const artifactConvergence = convergeJobWithResultArtifact(job, job_id, OMC_JOBS_DIR);
    if (artifactConvergence.changed) {
      job = saveJobState(job_id, artifactConvergence.job);
      const out = makeJobResponse(job_id, job);
      if (nudgeTracker.totalNudges > 0) {
        const payload = JSON.parse(out.content[0].text) as Record<string, unknown>;
        payload.nudges = nudgeTracker.getSummary();
        out.content[0].text = JSON.stringify(payload);
      }
      return out;
    }

    if (isJobTerminal(job)) {
      const out = makeJobResponse(job_id, job);
      if (nudgeTracker.totalNudges > 0) {
        const payload = JSON.parse(out.content[0].text) as Record<string, unknown>;
        payload.nudges = nudgeTracker.getSummary();
        out.content[0].text = JSON.stringify(payload);
      }
      return out;
    }

    if (job.pid != null && !isProcessAlive(job.pid)) {
      job = saveJobState(job_id, {
        ...job,
        status: 'failed',
        result: job.result ?? JSON.stringify({ error: 'Process no longer alive (MCP restart?)' }),
      });
      const out = makeJobResponse(job_id, job, { error: 'Process no longer alive (MCP restart?)' });
      if (nudgeTracker.totalNudges > 0) {
        const payload = JSON.parse(out.content[0].text) as Record<string, unknown>;
        payload.nudges = nudgeTracker.getSummary();
        out.content[0].text = JSON.stringify(payload);
      }
      return out;
    }

    await new Promise<void>(r => setTimeout(r, pollDelay));
    pollDelay = Math.min(Math.floor(pollDelay * 1.5), 2000);

    try {
      const panes = await loadPaneIds(job_id);
      if (panes?.paneIds?.length) {
        await nudgeTracker.checkAndNudge(
          panes.paneIds,
          panes.leaderPaneId,
          job.teamName ?? '',
        );
      }
    } catch { /* best-effort */ }
  }

  const startedAt = omcTeamJobs.get(job_id)?.startedAt ?? Date.now();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const timeoutOut: Record<string, unknown> = {
    error: `Timed out waiting for job ${job_id} after ${(timeout_ms / 1000).toFixed(0)}s — workers are still running; call omc_run_team_wait again to keep waiting or omc_run_team_cleanup to stop them`,
    jobId: job_id,
    status: 'running',
    elapsedSeconds: elapsed,
  };
  if (nudgeTracker.totalNudges > 0) timeoutOut.nudges = nudgeTracker.getSummary();
  return { content: [{ type: 'text', text: JSON.stringify(timeoutOut) }] };
}

export async function handleCleanup(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id, grace_ms } = cleanupSchema.parse(args);
  validateJobId(job_id);

  const job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
  if (!job) return { content: [{ type: 'text', text: `Job ${job_id} not found` }] };

  const panes = await loadPaneIds(job_id);
  let paneCleanupMessage = 'No pane IDs recorded for this job — pane cleanup skipped.';
  if (panes?.sessionName && (panes.ownsWindow === true || !panes.sessionName.includes(':'))) {
    const sessionMode = panes.ownsWindow === true
      ? (panes.sessionName.includes(':') ? 'dedicated-window' : 'detached-session')
      : 'detached-session';
    await killTeamSession(
      panes.sessionName,
      panes.paneIds,
      panes.leaderPaneId,
      { sessionMode },
    );
    paneCleanupMessage = panes.ownsWindow
      ? 'Cleaned up team tmux window.'
      : `Cleaned up ${panes.paneIds.length} worker pane(s).`;
  } else if (panes?.paneIds?.length) {
    await killWorkerPanes({
      paneIds: panes.paneIds,
      leaderPaneId: panes.leaderPaneId,
      teamName: job.teamName ?? '',
      cwd: job.cwd ?? '',
      graceMs: grace_ms ?? 10_000,
    });
    paneCleanupMessage = `Cleaned up ${panes.paneIds.length} worker pane(s).`;
  }

  job.cleanedUpAt = new Date().toISOString();
  persistJob(job_id, job);

  const cleanupOutcome = clearScopedTeamState(job);
  return { content: [{ type: 'text', text: `${paneCleanupMessage} ${cleanupOutcome}` }] };
}

const TOOLS = [
  {
    name: 'omc_run_team_start',
    description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team start`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        teamName: { type: 'string', description: 'Slug name for the team' },
        agentTypes: { type: 'array', items: { type: 'string' }, description: '"claude", "codex", or "gemini" per worker' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['subject', 'description'],
          },
          description: 'Tasks to distribute to workers',
        },
        cwd: { type: 'string', description: 'Working directory (absolute path)' },
        newWindow: { type: 'boolean', description: 'Spawn workers in a dedicated tmux window instead of splitting the current window' },
      },
      required: ['teamName', 'agentTypes', 'tasks', 'cwd'],
    },
  },
  {
    name: 'omc_run_team_status',
    description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team status <job_id>`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'omc_run_team_wait',
    description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team wait <job_id>`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
        timeout_ms: { type: 'number', description: 'Maximum wait time in ms (default: 300000, max: 3600000)' },
        nudge_delay_ms: { type: 'number', description: 'Milliseconds a pane must be idle before nudging (default: 30000)' },
        nudge_max_count: { type: 'number', description: 'Maximum nudges per pane (default: 3)' },
        nudge_message: { type: 'string', description: 'Message sent as nudge (default: "Continue working on your assigned task and report concrete progress (not ACK-only).")' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'omc_run_team_cleanup',
    description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team cleanup <job_id>`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
        grace_ms: { type: 'number', description: 'Grace period in ms before force-killing panes (default: 10000)' },
      },
      required: ['job_id'],
    },
  },
];

const server = new Server(
  { name: 'team', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Dispatch live handlers first. The deprecation guard below currently overlaps
  // with these same tool names but is kept as a safety net for future tool
  // renames — if a tool name is removed from this dispatch block, the
  // deprecation guard will catch stale callers and return a migration hint.
  try {
    if (name === 'omc_run_team_start') return await handleStart(args ?? {});
    if (name === 'omc_run_team_status') return await handleStatus(args ?? {});
    if (name === 'omc_run_team_wait') return await handleWait(args ?? {});
    if (name === 'omc_run_team_cleanup') return await handleCleanup(args ?? {});
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }

  if (isDeprecatedTeamToolName(name)) {
    return createDeprecatedCliOnlyEnvelopeWithArgs(name, args);
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OMC Team MCP Server running on stdio');
}

if (process.env.OMC_TEAM_SERVER_DISABLE_AUTOSTART !== '1' && process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
