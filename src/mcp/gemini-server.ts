/**
 * Gemini MCP Server - In-process MCP server for Google Gemini CLI integration
 *
 * Exposes `ask_gemini` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__g__ask_gemini
 *
 * Note: The standalone version (gemini-standalone-server.ts) is used for the
 * external-process .mcp.json registration with proper stdio transport.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_RECOMMENDED_ROLES,
  handleAskGemini
} from './gemini-core.js';
import { GEMINI_MODEL_FALLBACKS } from '../features/model-routing/external-model-policy.js';
import { handleWaitForJob, handleCheckJobStatus, handleKillJob, handleListJobs } from './job-management.js';

// Define the ask_gemini tool using the SDK tool() helper
const askGeminiTool = tool(
  "ask_gemini",
  `Send a prompt to Google Gemini CLI for design/implementation tasks. Gemini excels at frontend design review and implementation with its 1M token context window. Recommended roles: ${GEMINI_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted. Fallback chain: ${GEMINI_MODEL_FALLBACKS.join(' → ')}. Requires Gemini CLI (npm install -g @google/gemini-cli).`,
  {
    agent_role: { type: "string", description: `Required. Agent perspective for Gemini. Recommended: ${GEMINI_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted.` },
    prompt: { type: "string", description: "Inline prompt string. Alternative to prompt_file -- the prompt is auto-persisted to a file for audit trail. When used, output_file is optional (auto-generated if omitted) and the response is returned inline in the MCP result." },
    prompt_file: { type: "string", description: "Path to file containing the prompt. Takes precedence over inline prompt if both provided." },
    output_file: { type: "string", description: "Required. Path to write response. Response content is NOT returned inline - read from this file. Optional when using inline prompt (auto-generated if omitted)." },
    files: { type: "array", items: { type: "string" }, description: "File paths to include as context (contents will be prepended to prompt)" },
    model: { type: "string", description: `Gemini model to use (default: ${GEMINI_DEFAULT_MODEL}). Set OMC_GEMINI_DEFAULT_MODEL env var to change default. Auto-fallback chain: ${GEMINI_MODEL_FALLBACKS.join(' → ')}.` },
    background: { type: "boolean", description: "Run in background (non-blocking). Returns immediately with job metadata and file paths. Check response file for completion. Not available with inline prompt." },
    working_directory: { type: "string", description: "Working directory for path resolution and CLI execution. Defaults to process.cwd()." },
  } as any,
  async (args: any) => {
    const { prompt, prompt_file, output_file, agent_role, model, files, background, working_directory } = args as {
      prompt?: string;
      prompt_file?: string;
      output_file?: string;
      agent_role: string;
      model?: string;
      files?: string[];
      background?: boolean;
      working_directory?: string;
    };
    return handleAskGemini({ prompt, prompt_file, output_file, agent_role, model, files, background, working_directory });
  }
);

const waitForJobTool = tool(
  "wait_for_job",
  "Block (poll) until a background job reaches a terminal state (completed, failed, or timeout). Uses exponential backoff. Returns the response preview on success.",
  {
    job_id: { type: "string", description: "The job ID returned when the background job was dispatched." },
    timeout_ms: { type: "number", description: "Maximum time to wait in milliseconds (default: 3600000, max: 3600000)." },
  } as any,
  async (args: any) => {
    const { job_id, timeout_ms } = args as { job_id: string; timeout_ms?: number };
    return handleWaitForJob('gemini', job_id, timeout_ms);
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
    return handleCheckJobStatus('gemini', job_id);
  }
);

const killJobTool = tool(
  "kill_job",
  "Send a signal to a running background job. Marks the job as failed. Only works on jobs in spawned or running state.",
  {
    job_id: { type: "string", description: "The job ID of the running job to kill." },
    signal: { type: "string", description: "The signal to send (default: SIGTERM)." },
  } as any,
  async (args: any) => {
    const { job_id, signal } = args as { job_id: string; signal?: string };
    return handleKillJob('gemini', job_id, (signal as NodeJS.Signals) || undefined);
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
    return handleListJobs('gemini', (status_filter as 'active' | 'completed' | 'failed' | 'all') || undefined, limit);
  }
);

/**
 * In-process MCP server exposing Gemini CLI integration
 *
 * Tools will be available as mcp__g__ask_gemini
 */
export const geminiMcpServer = createSdkMcpServer({
  name: "g",
  version: "1.0.0",
  tools: [askGeminiTool, waitForJobTool, checkJobStatusTool, killJobTool, listJobsTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const geminiToolNames = ['ask_gemini', 'wait_for_job', 'check_job_status', 'kill_job', 'list_jobs'];
