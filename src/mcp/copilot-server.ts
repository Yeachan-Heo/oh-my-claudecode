/**
 * Copilot MCP Server - In-process MCP server for GitHub Copilot CLI integration
 *
 * Exposes `ask_copilot` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__c__ask_copilot
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { handleAskCopilot, COPILOT_DEFAULT_MODEL, COPILOT_VALID_ROLES } from './copilot-core.js';
import { handleWaitForJob, handleCheckJobStatus, handleKillJob, handleListJobs } from './job-management.js';

// Define the ask_copilot tool using the SDK tool() helper
const askCopilotTool = tool(
  "ask_copilot",
  `Send a prompt to GitHub Copilot CLI for analytical/planning tasks. Copilot is a full coding agent with file access and shell execution. Requires agent_role to specify the perspective (${COPILOT_VALID_ROLES.join(', ')}). Requires Copilot CLI (npm install -g @anthropic/copilot-cli or GitHub Copilot CLI).`,
  {
    agent_role: { type: "string", description: `Required. Agent perspective for Copilot: ${COPILOT_VALID_ROLES.join(', ')}. Copilot is optimized for analytical/planning tasks.` },
    prompt_file: { type: "string", description: "Path to file containing the prompt" },
    output_file: { type: "string", description: "Required. Path to write response. Response content is NOT returned inline - read from this file." },
    context_files: { type: "array", items: { type: "string" }, description: "File paths to include as context (contents will be prepended to prompt)" },
    model: { type: "string", description: `Copilot model to use (default: ${COPILOT_DEFAULT_MODEL}). Set OMC_COPILOT_DEFAULT_MODEL env var to change default.` },
    background: { type: "boolean", description: "Run in background (non-blocking). Returns immediately with job metadata and file paths. Check response file for completion." },
    working_directory: { type: "string", description: "Working directory for path resolution and CLI execution. Defaults to process.cwd()." },
  } as any,
  async (args: any) => {
    const { prompt_file, output_file, agent_role, model, context_files, background, working_directory } = args as {
      prompt_file: string;
      output_file: string;
      agent_role: string;
      model?: string;
      context_files?: string[];
      background?: boolean;
      working_directory?: string;
    };
    return handleAskCopilot({ prompt_file, output_file, agent_role, model, context_files, background, working_directory });
  }
);

const waitForJobTool = tool(
  "wait_for_job",
  "Block (poll) until a background job reaches a terminal state (completed, failed, or timeout). Uses exponential backoff. Returns the response preview on success. WARNING: This tool blocks the MCP server for the duration of the poll. Prefer check_job_status for non-blocking status checks.",
  {
    job_id: { type: "string", description: "The job ID returned when the background job was dispatched." },
    timeout_ms: { type: "number", description: "Maximum time to wait in milliseconds (default: 3600000, max: 3600000)." },
  } as any,
  async (args: any) => {
    const { job_id, timeout_ms } = args as { job_id: string; timeout_ms?: number };
    return handleWaitForJob('copilot', job_id, timeout_ms);
  }
);

const checkJobStatusTool = tool(
  "check_job_status",
  "Non-blocking status check for a background job. Returns current status, metadata, and error information if available.",
  {
    job_id: { type: "string", description: "The job ID returned when the background job was dispatched." },
  } as any,
  async (args: any) => {
    const { job_id } = args as { job_id: string };
    return handleCheckJobStatus('copilot', job_id);
  }
);

const killJobTool = tool(
  "kill_job",
  "Send a signal to a running background job. Marks the job as failed. Only works on jobs in spawned or running state.",
  {
    job_id: { type: "string", description: "The job ID of the running job to kill." },
    signal: { type: "string", description: "The signal to send (default: SIGTERM). Only SIGTERM and SIGINT are allowed." },
  } as any,
  async (args: any) => {
    const { job_id, signal } = args as { job_id: string; signal?: string };
    return handleKillJob('copilot', job_id, (signal as NodeJS.Signals) || undefined);
  }
);

const listJobsTool = tool(
  "list_jobs",
  "List background jobs for this provider. Filter by status and limit results. Results sorted newest first.",
  {
    status_filter: { type: "string", description: "Filter jobs by status (default: active)." },
    limit: { type: "number", description: "Maximum number of jobs to return (default: 50)." },
  } as any,
  async (args: any) => {
    const { status_filter, limit } = args as { status_filter?: string; limit?: number };
    return handleListJobs('copilot', (status_filter as 'active' | 'completed' | 'failed' | 'all') || undefined, limit);
  }
);

/**
 * In-process MCP server exposing Copilot CLI integration
 *
 * Tools will be available as mcp__c__ask_copilot
 */
export const copilotMcpServer = createSdkMcpServer({
  name: "c",
  version: "1.0.0",
  tools: [askCopilotTool, waitForJobTool, checkJobStatusTool, killJobTool, listJobsTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const copilotToolNames = ['ask_copilot', 'wait_for_job', 'check_job_status', 'kill_job', 'list_jobs'];
