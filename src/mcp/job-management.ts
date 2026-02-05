/**
 * Job Management - MCP tool handlers for background job lifecycle
 *
 * Provides four tools for managing background Codex/Gemini jobs:
 * - wait_for_job: Poll-wait until a background job completes (or times out)
 * - check_job_status: Non-blocking status check for a background job
 * - kill_job: Send a signal to a running background job
 * - list_jobs: List background jobs filtered by status
 *
 * All handlers are provider-scoped: each server hardcodes its provider and
 * passes it as the first argument. Schemas omit provider since it's implicit.
 */

import {
  readJobStatus,
  readCompletedResponse,
  listActiveJobs,
  writeJobStatus,
  getPromptsDir,
} from './prompt-persistence.js';
import type { JobStatus } from './prompt-persistence.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { isSpawnedPid as isCodexSpawnedPid } from './codex-core.js';
import { isSpawnedPid as isGeminiSpawnedPid } from './gemini-core.js';

/** Signals allowed for kill_job. SIGKILL excluded - too dangerous for process groups. */
const ALLOWED_SIGNALS: ReadonlySet<string> = new Set(['SIGTERM', 'SIGINT']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in a RegExp
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Standard MCP text result wrapper */
function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError && { isError: true }),
  };
}

/**
 * Find the status file for a job by provider and jobId.
 * Scans .omc/prompts/ for files matching the naming convention.
 *
 * Handles 0/1/many matches:
 * - 0 matches: returns undefined
 * - 1 match: returns { statusPath, slug }
 * - Many matches: prefers non-terminal (active) status, then newest spawnedAt
 */
export function findJobStatusFile(
  provider: 'codex' | 'gemini',
  jobId: string,
): { statusPath: string; slug: string } | undefined {
  // Validate jobId format: must be 8-char hex (from generatePromptId)
  if (!/^[0-9a-f]{8}$/i.test(jobId)) {
    return undefined;
  }

  const promptsDir = getPromptsDir();
  if (!existsSync(promptsDir)) return undefined;

  try {
    const files = readdirSync(promptsDir);
    const escapedProvider = escapeRegex(provider);
    const escapedJobId = escapeRegex(jobId);
    const pattern = new RegExp(`^${escapedProvider}-status-(.+)-${escapedJobId}\\.json$`);

    const matches: Array<{ file: string; slug: string; statusPath: string }> = [];
    for (const f of files) {
      const m = f.match(pattern);
      if (m) {
        matches.push({
          file: f,
          slug: m[1],
          statusPath: join(promptsDir, f),
        });
      }
    }

    if (matches.length === 0) return undefined;
    if (matches.length === 1) {
      return { statusPath: matches[0].statusPath, slug: matches[0].slug };
    }

    // Multiple matches: prefer non-terminal (active) status, then newest spawnedAt
    let best: { statusPath: string; slug: string; isActive: boolean; spawnedAt: number } | undefined;

    for (const match of matches) {
      try {
        const content = readFileSync(match.statusPath, 'utf-8');
        const status = JSON.parse(content) as JobStatus;
        const isActive = status.status === 'spawned' || status.status === 'running';
        const spawnedAt = new Date(status.spawnedAt).getTime();

        if (
          !best ||
          (isActive && !best.isActive) ||
          (isActive === best.isActive && spawnedAt > best.spawnedAt)
        ) {
          best = { statusPath: match.statusPath, slug: match.slug, isActive, spawnedAt };
        }
      } catch {
        // Skip malformed files
      }
    }

    if (best) {
      return { statusPath: best.statusPath, slug: best.slug };
    }

    // Fallback to first match if all were malformed
    return { statusPath: matches[0].statusPath, slug: matches[0].slug };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

/**
 * wait_for_job - block (poll) until a background job reaches a terminal state.
 * Uses exponential backoff: 500ms base, 1.5x factor, 2000ms cap.
 *
 * WARNING: This function blocks the MCP request handler for the duration of the poll.
 * For non-blocking checks, use handleCheckJobStatus instead.
 */
export async function handleWaitForJob(
  provider: 'codex' | 'gemini',
  jobId: string,
  timeoutMs: number = 3600000,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return textResult('job_id is required.', true);
  }

  const effectiveTimeout = Math.max(1000, Math.min(timeoutMs, 3_600_000));
  const deadline = Date.now() + effectiveTimeout;
  let pollDelay = 500;

  while (Date.now() < deadline) {
    const found = findJobStatusFile(provider, jobId);

    if (!found) {
      return textResult(`No job found with ID: ${jobId}`, true);
    }

    const status = readJobStatus(provider, found.slug, jobId);

    if (!status) {
      return textResult(`No job found with ID: ${jobId}`, true);
    }

    if (status.status === 'completed' || status.status === 'failed' || status.status === 'timeout') {
      // Terminal state reached
      if (status.status === 'completed') {
        const completed = readCompletedResponse(status.provider, status.slug, status.jobId);
        const responseSnippet = completed
          ? completed.response.substring(0, 500) + (completed.response.length > 500 ? '...' : '')
          : '(response file not found)';

        return textResult([
          `**Job ${jobId} completed.**`,
          `**Provider:** ${status.provider}`,
          `**Model:** ${status.model}`,
          `**Agent Role:** ${status.agentRole}`,
          `**Response File:** ${status.responseFile}`,
          status.usedFallback ? `**Fallback Model:** ${status.fallbackModel}` : null,
          ``,
          `**Response preview:**`,
          responseSnippet,
        ].filter(Boolean).join('\n'));
      }

      // failed or timeout
      return textResult([
        `**Job ${jobId} ${status.status}.**`,
        `**Provider:** ${status.provider}`,
        `**Model:** ${status.model}`,
        `**Agent Role:** ${status.agentRole}`,
        status.error ? `**Error:** ${status.error}` : null,
      ].filter(Boolean).join('\n'), true);
    }

    // Still running - wait with exponential backoff and poll again
    await new Promise(resolve => setTimeout(resolve, pollDelay));
    pollDelay = Math.min(pollDelay * 1.5, 2000);
  }

  // Timed out waiting
  return textResult(
    `Timed out waiting for job ${jobId} after ${timeoutMs}ms. The job is still running; use check_job_status to poll later.`,
    true
  );
}

/**
 * check_job_status - non-blocking status check
 */
export async function handleCheckJobStatus(
  provider: 'codex' | 'gemini',
  jobId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return textResult('job_id is required.', true);
  }

  const found = findJobStatusFile(provider, jobId);

  if (!found) {
    return textResult(`No job found with ID: ${jobId}`, true);
  }

  const status = readJobStatus(provider, found.slug, jobId);

  if (!status) {
    return textResult(`No job found with ID: ${jobId}`, true);
  }

  const lines = [
    `**Job ID:** ${status.jobId}`,
    `**Provider:** ${status.provider}`,
    `**Status:** ${status.status}`,
    `**Model:** ${status.model}`,
    `**Agent Role:** ${status.agentRole}`,
    `**Spawned At:** ${status.spawnedAt}`,
    status.completedAt ? `**Completed At:** ${status.completedAt}` : null,
    status.pid ? `**PID:** ${status.pid}` : null,
    `**Prompt File:** ${status.promptFile}`,
    `**Response File:** ${status.responseFile}`,
    status.error ? `**Error:** ${status.error}` : null,
    status.usedFallback ? `**Fallback Model:** ${status.fallbackModel}` : null,
    status.killedByUser ? `**Killed By User:** yes` : null,
  ];

  return textResult(lines.filter(Boolean).join('\n'));
}

/**
 * kill_job - send a signal to a running background job
 */
export async function handleKillJob(
  provider: 'codex' | 'gemini',
  jobId: string,
  signal: string = 'SIGTERM',
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return textResult('job_id is required.', true);
  }

  if (!ALLOWED_SIGNALS.has(signal)) {
    return textResult(
      `Invalid signal: ${signal}. Allowed signals: ${[...ALLOWED_SIGNALS].join(', ')}`,
      true
    );
  }

  const found = findJobStatusFile(provider, jobId);

  if (!found) {
    return textResult(`No job found with ID: ${jobId}`, true);
  }

  const status = readJobStatus(provider, found.slug, jobId);

  if (!status) {
    return textResult(`No job found with ID: ${jobId}`, true);
  }

  if (status.status !== 'spawned' && status.status !== 'running') {
    return textResult(
      `Job ${jobId} is already in terminal state: ${status.status}. Cannot kill.`,
      true
    );
  }

  if (!status.pid) {
    return textResult(
      `Job ${jobId} has no PID recorded. Cannot send signal.`,
      true
    );
  }

  // Validate PID is a reasonable positive integer
  if (!Number.isInteger(status.pid) || status.pid <= 0 || status.pid > 4194304) {
    return textResult(`Job ${jobId} has invalid PID: ${status.pid}. Refusing to send signal.`, true);
  }

  // Verify this PID was spawned by us
  const isOurPid = provider === 'codex'
    ? isCodexSpawnedPid(status.pid)
    : isGeminiSpawnedPid(status.pid);

  if (!isOurPid) {
    return textResult(
      `Job ${jobId} PID ${status.pid} was not spawned by this process. Refusing to send signal for safety.`,
      true
    );
  }

  // Mark killedByUser before sending signal so the close handler can see it
  const updated: JobStatus = {
    ...status,
    killedByUser: true,
  };
  writeJobStatus(updated);

  try {
    // On POSIX, background jobs are spawned detached as process-group leaders.
    // Kill the whole process group so child processes also terminate.
    if (process.platform !== 'win32') {
      process.kill(-status.pid, signal as NodeJS.Signals);
    } else {
      process.kill(status.pid, signal as NodeJS.Signals);
    }

    // Update status to failed
    writeJobStatus({
      ...updated,
      status: 'failed',
      killedByUser: true,
      completedAt: new Date().toISOString(),
      error: `Killed by user (signal: ${signal})`,
    });

    // Retry loop: background handler may overwrite our 'failed' status
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const recheckStatus = readJobStatus(provider, found.slug, jobId);
      if (!recheckStatus || recheckStatus.status === 'failed') {
        break; // Our write stuck, or status is already what we want
      }
      // Background handler overwrote - write again
      writeJobStatus({
        ...recheckStatus,
        status: 'failed',
        killedByUser: true,
        completedAt: new Date().toISOString(),
        error: `Killed by user (signal: ${signal})`,
      });
    }

    return textResult(
      `Sent ${signal} to job ${jobId} (PID ${status.pid}). Job marked as failed.`
    );
  } catch (err) {
    const currentStatus = readJobStatus(provider, found.slug, jobId);
    const isESRCH = (err as NodeJS.ErrnoException).code === 'ESRCH';

    let message: string;
    if (isESRCH) {
      if (currentStatus?.status === 'completed') {
        message = `Process ${status.pid} already exited. Job ${jobId} completed successfully.`;
      } else {
        message = `Process ${status.pid} already exited.`;
        // Only mark as failed if not already completed
        writeJobStatus({
          ...(currentStatus || updated),
          status: 'failed',
          killedByUser: true,
          completedAt: new Date().toISOString(),
          error: `Killed by user (process already exited, signal: ${signal})`,
        });
      }
    } else {
      message = `Failed to kill process ${status.pid}: ${(err as Error).message}`;
    }

    return textResult(message, !isESRCH || currentStatus?.status !== 'completed');
  }
}

/**
 * list_jobs - list background jobs with status filter and limit.
 * Provider is hardcoded per-server (passed as first arg).
 */
export async function handleListJobs(
  provider: 'codex' | 'gemini',
  statusFilter: 'active' | 'completed' | 'failed' | 'all' = 'active',
  limit: number = 50,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // For 'active' filter, use the optimized listActiveJobs helper
  if (statusFilter === 'active') {
    const activeJobs = listActiveJobs(provider);

    if (activeJobs.length === 0) {
      return textResult(`No active ${provider} jobs found.`);
    }

    // Sort by spawnedAt descending (newest first), apply limit
    activeJobs.sort((a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime());
    const limited = activeJobs.slice(0, limit);

    const lines = limited.map((job) => {
      const parts = [
        `- **${job.jobId}** [${job.status}] ${job.provider}/${job.model} (${job.agentRole})`,
        `  Spawned: ${job.spawnedAt}`,
      ];
      if (job.pid) parts.push(`  PID: ${job.pid}`);
      return parts.join('\n');
    });

    return textResult(`**${limited.length} active ${provider} job(s):**\n\n${lines.join('\n\n')}`);
  }

  // For 'all', 'completed', 'failed': scan all status files for this provider
  const promptsDir = getPromptsDir();
  if (!existsSync(promptsDir)) {
    return textResult(`No ${provider} jobs found.`);
  }

  try {
    const files = readdirSync(promptsDir);
    const statusFiles = files.filter(
      (f: string) => f.startsWith(`${provider}-status-`) && f.endsWith('.json'),
    );

    const jobs: JobStatus[] = [];
    for (const file of statusFiles) {
      try {
        const content = readFileSync(join(promptsDir, file), 'utf-8');
        const job = JSON.parse(content) as JobStatus;

        // Apply status filter
        if (statusFilter === 'completed' && job.status !== 'completed') continue;
        if (statusFilter === 'failed' && job.status !== 'failed' && job.status !== 'timeout') continue;
        // 'all' has no filter

        jobs.push(job);
      } catch {
        // Skip malformed files
      }
    }

    if (jobs.length === 0) {
      const filterDesc = statusFilter !== 'all' ? ` with status=${statusFilter}` : '';
      return textResult(`No ${provider} jobs found${filterDesc}.`);
    }

    // Sort by spawnedAt descending (newest first), apply limit
    jobs.sort((a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime());
    const limited = jobs.slice(0, limit);

    const lines = limited.map((job) => {
      const parts = [
        `- **${job.jobId}** [${job.status}] ${job.provider}/${job.model} (${job.agentRole})`,
        `  Spawned: ${job.spawnedAt}`,
      ];
      if (job.completedAt) parts.push(`  Completed: ${job.completedAt}`);
      if (job.error) parts.push(`  Error: ${job.error}`);
      if (job.pid) parts.push(`  PID: ${job.pid}`);
      return parts.join('\n');
    });

    return textResult(`**${limited.length} ${provider} job(s) found:**\n\n${lines.join('\n\n')}`);
  } catch (err) {
    return textResult(`Error listing jobs: ${(err as Error).message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Tool Schema Definitions (for both SDK and standalone servers)
// ---------------------------------------------------------------------------

// TODO: _provider parameter reserved for future per-provider schema customization
export function getJobManagementToolSchemas(_provider?: 'codex' | 'gemini') {
  return [
    {
      name: 'wait_for_job',
      description:
        'Block (poll) until a background job reaches a terminal state (completed, failed, or timeout). Uses exponential backoff. Returns the response preview on success. WARNING: This tool blocks the MCP server for the duration of the poll. Prefer check_job_status for non-blocking status checks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'string',
            description: 'The job ID returned when the background job was dispatched.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Maximum time to wait in milliseconds (default: 3600000, max: 3600000).',
          },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'check_job_status',
      description:
        'Non-blocking status check for a background job. Returns current status, metadata, and error information if available.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'string',
            description: 'The job ID returned when the background job was dispatched.',
          },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'kill_job',
      description:
        'Send a signal to a running background job. Marks the job as failed. Only works on jobs in spawned or running state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'string',
            description: 'The job ID of the running job to kill.',
          },
          signal: {
            type: 'string',
            enum: ['SIGTERM', 'SIGINT'],
            description: 'The signal to send (default: SIGTERM). Only SIGTERM and SIGINT are allowed.',
          },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'list_jobs',
      description:
        'List background jobs for this provider. Filter by status and limit results. Results sorted newest first.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status_filter: {
            type: 'string',
            enum: ['active', 'completed', 'failed', 'all'],
            description: 'Filter jobs by status (default: active).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of jobs to return (default: 50).',
          },
        },
        required: [] as string[],
      },
    },
  ];
}
