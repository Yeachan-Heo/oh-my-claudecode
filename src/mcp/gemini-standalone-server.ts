/**
 * Standalone Gemini MCP Server
 *
 * Thin wrapper around gemini-core that provides stdio MCP transport.
 * Built into bridge/gemini-server.cjs for .mcp.json registration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  GEMINI_VALID_ROLES,
  GEMINI_DEFAULT_MODEL,
  GEMINI_MODEL_FALLBACKS,
  handleAskGemini,
} from './gemini-core.js';
import {
  handleWaitForJob,
  handleCheckJobStatus,
  handleKillJob,
  handleListJobs,
  getJobManagementToolSchemas,
} from './job-management.js';

const askGeminiTool = {
  name: 'ask_gemini',
  description: `Send a prompt to Google Gemini CLI for design/implementation tasks. Gemini excels at frontend design review and implementation with its 1M token context window. Requires agent_role (${GEMINI_VALID_ROLES.join(', ')}). Fallback chain: ${GEMINI_MODEL_FALLBACKS.join(' → ')}. Requires Gemini CLI (npm install -g @google/gemini-cli).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      agent_role: {
        type: 'string',
        enum: GEMINI_VALID_ROLES,
        description: `Required. Agent perspective for Gemini: ${GEMINI_VALID_ROLES.join(', ')}. Gemini is optimized for design/implementation tasks with large context.`
      },
      prompt_file: { type: 'string', description: 'Path to file containing the prompt' },
      output_file: { type: 'string', description: 'Required. Path to write response. Response content is NOT returned inline - read from this file.' },
      files: { type: 'array', items: { type: 'string' }, description: 'File paths to include as context (contents will be prepended to prompt)' },
      model: { type: 'string', description: `Gemini model to use (default: ${GEMINI_DEFAULT_MODEL}). Set OMC_GEMINI_DEFAULT_MODEL env var to change default. Auto-fallback chain: ${GEMINI_MODEL_FALLBACKS.join(' → ')}.` },
      background: { type: 'boolean', description: 'Run in background (non-blocking). Returns immediately with job metadata and file paths. Check response file for completion.' },
      working_directory: { type: 'string', description: 'Working directory for path resolution and CLI execution. Defaults to process.cwd().' },
    },
    required: ['agent_role', 'prompt_file', 'output_file'],
  },
};

const jobTools = getJobManagementToolSchemas('gemini');

const server = new Server(
  { name: 'g', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [askGeminiTool, ...jobTools],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'ask_gemini') {
    const { prompt_file, output_file, agent_role, model, files, background, working_directory } = (args ?? {}) as {
      prompt_file: string;
      output_file: string;
      agent_role: string;
      model?: string;
      files?: string[];
      background?: boolean;
      working_directory?: string;
    };
    return handleAskGemini({ prompt_file, output_file, agent_role, model, files, background, working_directory });
  }
  if (name === 'wait_for_job') {
    const { job_id, timeout_ms } = (args ?? {}) as { job_id: string; timeout_ms?: number };
    return handleWaitForJob('gemini', job_id, timeout_ms);
  }
  if (name === 'check_job_status') {
    const { job_id } = (args ?? {}) as { job_id: string };
    return handleCheckJobStatus('gemini', job_id);
  }
  if (name === 'kill_job') {
    const { job_id, signal } = (args ?? {}) as { job_id: string; signal?: string };
    return handleKillJob('gemini', job_id, (signal as NodeJS.Signals) || undefined);
  }
  if (name === 'list_jobs') {
    const { status_filter, limit } = (args ?? {}) as { status_filter?: string; limit?: number };
    return handleListJobs('gemini', (status_filter as 'active' | 'completed' | 'failed' | 'all') || undefined, limit);
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gemini MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start Gemini server:', error);
  process.exit(1);
});
