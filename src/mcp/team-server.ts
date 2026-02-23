#!/usr/bin/env node
/**
 * Team MCP Server - tmux CLI worker runtime tools
 *
 * Exposes three tools for running tmux-based teams (claude/codex/gemini workers):
 *   omc_run_team_start  - spawn workers in background, return jobId immediately
 *   omc_run_team_status - non-blocking poll for job completion
 *   omc_run_team_wait   - blocking wait: polls internally, returns when done (one call instead of N)
 *
 * __dirname in the CJS bundle (bridge/team-mcp.cjs) points to the bridge/
 * directory, where runtime-cli.cjs is co-located — works for all install paths.
 *
 * Built by: scripts/build-team-server.mjs → bridge/team-mcp.cjs
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
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { killWorkerPanes } from '../team/tmux-session.js';

// ---------------------------------------------------------------------------
// Job state: in-memory Map (primary) + /tmp backup (survives MCP restart)
// ---------------------------------------------------------------------------

interface OmcTeamJob {
  status: 'running' | 'completed' | 'failed' | 'timeout';
  result?: string;
  stderr?: string;
  startedAt: number;
  pid?: number;
  paneIds?: string[];
  leaderPaneId?: string;
  teamName?: string;
  cwd?: string;
  cleanedUpAt?: string;
}

const omcTeamJobs = new Map<string, OmcTeamJob>();
const OMC_JOBS_DIR = join(homedir(), '.omc', 'team-jobs');

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

async function loadPaneIds(jobId: string): Promise<{ paneIds: string[]; leaderPaneId: string } | null> {
  const p = join(OMC_JOBS_DIR, `${jobId}-panes.json`);
  try { return JSON.parse(await readFile(p, 'utf-8')); }
  catch { return null; }
}

function validateJobId(job_id: string): void {
  if (!/^omc-[a-z0-9]{1,12}$/.test(job_id)) {
    throw new Error(`Invalid job_id: "${job_id}". Must match /^omc-[a-z0-9]{1,12}$/`);
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const startSchema = z.object({
  teamName: z.string().describe('Slug name for the team (e.g. "auth-review")'),
  agentTypes: z.array(z.string()).describe('Agent type per worker: "claude", "codex", or "gemini"'),
  tasks: z.array(z.object({
    subject: z.string().describe('Brief task title'),
    description: z.string().describe('Full task description'),
  })).describe('Tasks to distribute to workers'),
  cwd: z.string().describe('Working directory (absolute path)'),
  timeoutSeconds: z.number().optional().describe('Timeout in seconds (default: 300)'),
});

const statusSchema = z.object({
  job_id: z.string().describe('Job ID returned by omc_run_team_start'),
});

const waitSchema = z.object({
  job_id: z.string().describe('Job ID returned by omc_run_team_start'),
  timeout_ms: z.number().optional().describe('Maximum wait time in ms (default: 300000, max: 3600000)'),
});

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleStart(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const input = startSchema.parse(args);
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
          job.status = (s === 'completed' || s === 'failed' || s === 'timeout') ? s : 'failed';
        }
      } catch {
        if (job.status === 'running') job.status = 'failed';
      }
      job.result = stdout;
    }
    // Only fall back to exit-code when stdout parsing did not set a status
    if (job.status === 'running') {
      if (code === 0) job.status = 'completed';
      else if (code === 2) job.status = 'timeout';
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

async function handleStatus(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id } = statusSchema.parse(args);
  const job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
  if (!job) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
  }
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
  const out: Record<string, unknown> = { jobId: job_id, status: job.status, elapsedSeconds: elapsed };
  if (job.result) { try { out.result = JSON.parse(job.result) as unknown; } catch { out.result = job.result; } }
  if (job.stderr) out.stderr = job.stderr;
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

async function handleWait(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id, timeout_ms = 300_000 } = waitSchema.parse(args);
  // Cap at 1 hour — matches Codex/Gemini wait_for_job behaviour
  const deadline = Date.now() + Math.min(timeout_ms, 3_600_000);
  let pollDelay = 500; // ms; grows to 2000ms via 1.5× backoff

  while (Date.now() < deadline) {
    const job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
    if (!job) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
    }
    // FIX 2: Detect orphan PIDs (e.g. after MCP restart) — if job is 'running' but
    // the process is dead, mark it failed immediately rather than polling forever.
    if (job.status === 'running' && job.pid != null) {
      try {
        process.kill(job.pid, 0);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          job.status = 'failed';
          if (!job.result) job.result = JSON.stringify({ error: 'Process no longer alive (MCP restart?)' });
          persistJob(job_id, job);
          const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job_id, status: 'failed', elapsedSeconds: elapsed, error: 'Process no longer alive (MCP restart?)' }) }] };
        }
      }
    }
    if (job.status !== 'running') {
      const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
      const out: Record<string, unknown> = { jobId: job_id, status: job.status, elapsedSeconds: elapsed };
      if (job.result) { try { out.result = JSON.parse(job.result) as unknown; } catch { out.result = job.result; } }
      if (job.stderr) out.stderr = job.stderr;
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
    // Yield to Node.js event loop — lets child.on('close', ...) fire between polls.
    // No deadlock: runtime-cli.cjs is an independent child process and never calls
    // back into this MCP server.
    await new Promise<void>(r => setTimeout(r, pollDelay));
    pollDelay = Math.min(Math.floor(pollDelay * 1.5), 2000);
  }

  // Timeout: leave workers running — caller must use omc_run_team_cleanup to stop them explicitly.
  // Do NOT kill the process or panes here; the user may call omc_run_team_wait again to keep
  // waiting, or omc_run_team_status to check progress.
  const elapsed = ((Date.now() - (omcTeamJobs.get(job_id)?.startedAt ?? Date.now())) / 1000).toFixed(1);
  return { content: [{ type: 'text', text: JSON.stringify({ error: `Timed out waiting for job ${job_id} after ${(timeout_ms / 1000).toFixed(0)}s — workers are still running; call omc_run_team_wait again to keep waiting or omc_run_team_cleanup to stop them`, jobId: job_id, status: 'running', elapsedSeconds: elapsed }) }] };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'omc_run_team_start',
    description: 'Spawn tmux CLI workers (claude/codex/gemini) in the background. Returns jobId immediately. Poll with omc_run_team_status.',
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
        timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['teamName', 'agentTypes', 'tasks', 'cwd'],
    },
  },
  {
    name: 'omc_run_team_status',
    description: 'Non-blocking status check for a background omc_run_team job. Returns status and result when done.',
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
    description: 'Block (poll internally) until a background omc_run_team job reaches a terminal state (completed, failed, timeout). Returns the result when done. One call instead of N polling calls. Uses exponential backoff (500ms → 2000ms). On timeout, workers are left running — call omc_run_team_wait again to keep waiting, or omc_run_team_cleanup to stop them explicitly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
        timeout_ms: { type: 'number', description: 'Maximum wait time in ms (default: 300000, max: 3600000)' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'omc_run_team_cleanup',
    description: 'Explicitly clean up worker panes for a completed or timed-out team job. Kills all worker panes recorded for the job without touching the leader pane or the user session.',
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
  try {
    if (name === 'omc_run_team_start') return await handleStart(args ?? {});
    if (name === 'omc_run_team_status') return await handleStatus(args ?? {});
    if (name === 'omc_run_team_wait') return await handleWait(args ?? {});
    if (name === 'omc_run_team_cleanup') {
      const { job_id, grace_ms } = (args ?? {}) as { job_id: string; grace_ms?: number };
      validateJobId(job_id);
      const job = omcTeamJobs.get(job_id) ?? loadJobFromDisk(job_id);
      if (!job) return { content: [{ type: 'text', text: `Job ${job_id} not found` }] };
      const panes = await loadPaneIds(job_id);
      if (!panes?.paneIds?.length) {
        return { content: [{ type: 'text', text: 'No pane IDs recorded for this job — nothing to clean up.' }] };
      }
      await killWorkerPanes({
        paneIds: panes.paneIds,
        leaderPaneId: panes.leaderPaneId,
        teamName: job.teamName ?? '',
        cwd: job.cwd ?? '',
        graceMs: grace_ms ?? 10_000,
      });
      job.cleanedUpAt = new Date().toISOString();
      persistJob(job_id, job);
      return { content: [{ type: 'text', text: `Cleaned up ${panes.paneIds.length} worker pane(s).` }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OMC Team MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
