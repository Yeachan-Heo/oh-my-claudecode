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
  checkResponseReady,
  readCompletedResponse,
  listActiveJobs,
  writeJobStatus,
  getPromptsDir,
} from './prompt-persistence.js';
import type { JobStatus } from './prompt-persistence.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in a RegExp
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 */
export async function handleWaitForJob(
  provider: 'codex' | 'gemini',
  jobId: string,
  timeoutMs: number = 3600000,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return {
      content: [{ type: 'text' as const, text: 'job_id is required.' }],
      isError: true,
    };
  }

  const deadline = Date.now() + Math.min(timeoutMs, 3_600_000);
  let pollDelay = 500;

  while (Date.now() < deadline) {
    const found = findJobStatusFile(provider, jobId);

    if (!found) {
      return {
        content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
        isError: true,
      };
    }

    const status = readJobStatus(provider, found.slug, jobId);

    if (!status) {
      return {
        content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
        isError: true,
      };
    }

    if (status.status === 'completed' || status.status === 'failed' || status.status === 'timeout') {
      // Terminal state reached
      if (status.status === 'completed') {
        const completed = readCompletedResponse(status.provider, status.slug, status.jobId);
        const responseSnippet = completed
          ? completed.response.substring(0, 500) + (completed.response.length > 500 ? '...' : '')
          : '(response file not found)';

        return {
          content: [{
            type: 'text' as const,
            text: [
              `**Job ${jobId} completed.**`,
              `**Provider:** ${status.provider}`,
              `**Model:** ${status.model}`,
              `**Agent Role:** ${status.agentRole}`,
              `**Response File:** ${status.responseFile}`,
              status.usedFallback ? `**Fallback Model:** ${status.fallbackModel}` : null,
              ``,
              `**Response preview:**`,
              responseSnippet,
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      // failed or timeout
      return {
        content: [{
          type: 'text' as const,
          text: [
            `**Job ${jobId} ${status.status}.**`,
            `**Provider:** ${status.provider}`,
            `**Model:** ${status.model}`,
            `**Agent Role:** ${status.agentRole}`,
            status.error ? `**Error:** ${status.error}` : null,
          ].filter(Boolean).join('\n'),
        }],
        isError: true,
      };
    }

    // Still running - wait with exponential backoff and poll again
    await new Promise(resolve => setTimeout(resolve, pollDelay));
    pollDelay = Math.min(pollDelay * 1.5, 2000);
  }

  // Timed out waiting
  return {
    content: [{
      type: 'text' as const,
      text: `Timed out waiting for job ${jobId} after ${timeoutMs}ms. The job is still running; use check_job_status to poll later.`,
    }],
    isError: true,
  };
}

/**
 * check_job_status - non-blocking status check
 */
export async function handleCheckJobStatus(
  provider: 'codex' | 'gemini',
  jobId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return {
      content: [{ type: 'text' as const, text: 'job_id is required.' }],
      isError: true,
    };
  }

  const found = findJobStatusFile(provider, jobId);

  if (!found) {
    return {
      content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
      isError: true,
    };
  }

  const status = readJobStatus(provider, found.slug, jobId);

  if (!status) {
    return {
      content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
      isError: true,
    };
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

  return {
    content: [{
      type: 'text' as const,
      text: lines.filter(Boolean).join('\n'),
    }],
  };
}

/**
 * kill_job - send a signal to a running background job
 */
export async function handleKillJob(
  provider: 'codex' | 'gemini',
  jobId: string,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!jobId || typeof jobId !== 'string') {
    return {
      content: [{ type: 'text' as const, text: 'job_id is required.' }],
      isError: true,
    };
  }

  const found = findJobStatusFile(provider, jobId);

  if (!found) {
    return {
      content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
      isError: true,
    };
  }

  const status = readJobStatus(provider, found.slug, jobId);

  if (!status) {
    return {
      content: [{ type: 'text' as const, text: `No job found with ID: ${jobId}` }],
      isError: true,
    };
  }

  if (status.status !== 'spawned' && status.status !== 'running') {
    return {
      content: [{
        type: 'text' as const,
        text: `Job ${jobId} is already in terminal state: ${status.status}. Cannot kill.`,
      }],
      isError: true,
    };
  }

  if (!status.pid) {
    return {
      content: [{
        type: 'text' as const,
        text: `Job ${jobId} has no PID recorded. Cannot send signal.`,
      }],
      isError: true,
    };
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
      process.kill(-status.pid, signal);
    } else {
      process.kill(status.pid, signal);
    }

    // Update status to failed
    writeJobStatus({
      ...updated,
      status: 'failed',
      killedByUser: true,
      completedAt: new Date().toISOString(),
      error: `Killed by user (signal: ${signal})`,
    });

    // Wait 50ms then re-check - background handler may have overwritten
    await new Promise(resolve => setTimeout(resolve, 50));
    const recheckStatus = readJobStatus(provider, found.slug, jobId);
    if (recheckStatus && recheckStatus.status !== 'failed') {
      // Background handler overwrote - write again
      writeJobStatus({
        ...recheckStatus,
        status: 'failed',
        killedByUser: true,
        completedAt: new Date().toISOString(),
        error: `Killed by user (signal: ${signal})`,
      });
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Sent ${signal} to job ${jobId} (PID ${status.pid}). Job marked as failed.`,
      }],
    };
  } catch (err) {
    // Process may have already exited
    const message = (err as NodeJS.ErrnoException).code === 'ESRCH'
      ? `Process ${status.pid} already exited.`
      : `Failed to kill process ${status.pid}: ${(err as Error).message}`;

    // Still mark as failed if the process is gone
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      writeJobStatus({
        ...updated,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: `Killed by user (process already exited, signal: ${signal})`,
      });
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      isError: (err as NodeJS.ErrnoException).code !== 'ESRCH',
    };
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
      return {
        content: [{
          type: 'text' as const,
          text: `No active ${provider} jobs found.`,
        }],
      };
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

    return {
      content: [{
        type: 'text' as const,
        text: `**${limited.length} active ${provider} job(s):**\n\n${lines.join('\n\n')}`,
      }],
    };
  }

  // For 'all', 'completed', 'failed': scan all status files for this provider
  const promptsDir = getPromptsDir();
  if (!existsSync(promptsDir)) {
    return {
      content: [{ type: 'text' as const, text: `No ${provider} jobs found.` }],
    };
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
      return {
        content: [{
          type: 'text' as const,
          text: `No ${provider} jobs found${filterDesc}.`,
        }],
      };
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

    return {
      content: [{
        type: 'text' as const,
        text: `**${limited.length} ${provider} job(s) found:**\n\n${lines.join('\n\n')}`,
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error listing jobs: ${(err as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool Schema Definitions (for both SDK and standalone servers)
// ---------------------------------------------------------------------------

/**
 * Returns tool definitions for the four job management tools.
 *
 * Each entry has { name, description, inputSchema }.
 * Servers wire handlers themselves - no handler property included.
 * Provider parameter accepted for future extensibility.
 */
export function getJobManagementToolSchemas(_provider?: 'codex' | 'gemini') {
  return [
    {
      name: 'wait_for_job',
      description:
        'Block (poll) until a background job reaches a terminal state (completed, failed, or timeout). Uses exponential backoff. Returns the response preview on success.',
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
            description: 'The signal to send (default: SIGTERM).',
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
