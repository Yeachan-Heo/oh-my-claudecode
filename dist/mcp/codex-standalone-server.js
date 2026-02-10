/**
 * Standalone Codex MCP Server
 *
 * Thin wrapper around codex-core that provides stdio MCP transport.
 * Built into bridge/codex-server.cjs for .mcp.json registration.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { CODEX_RECOMMENDED_ROLES, CODEX_DEFAULT_MODEL, handleAskCodex, } from './codex-core.js';
import { handleWaitForJob, handleCheckJobStatus, handleKillJob, handleListJobs, getJobManagementToolSchemas, } from './job-management.js';
const askCodexTool = {
    name: 'ask_codex',
    description: `Send a prompt to OpenAI Codex CLI for analytical/planning tasks. Codex excels at architecture review, planning validation, critical analysis, and code/security review validation. Recommended roles: ${CODEX_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted. Requires Codex CLI (npm install -g @openai/codex).`,
    inputSchema: {
        type: 'object',
        properties: {
            agent_role: {
                type: 'string',
                description: `Required. Agent perspective for Codex. Recommended: ${CODEX_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted.`
            },
            prompt_file: { type: 'string', description: 'Path to file containing the prompt' },
            output_file: { type: 'string', description: 'Required. Path to write response. Response content is NOT returned inline - read from this file.' },
            context_files: { type: 'array', items: { type: 'string' }, description: 'File paths to include as context (contents will be prepended to prompt)' },
            model: { type: 'string', description: `Codex model to use (default: ${CODEX_DEFAULT_MODEL}). Set OMC_CODEX_DEFAULT_MODEL env var to change default.` },
            background: { type: 'boolean', description: 'Run in background (non-blocking). Returns immediately with job metadata and file paths. Check response file for completion.' },
            working_directory: { type: 'string', description: 'Working directory for path resolution and CLI execution. Defaults to process.cwd().' },
        },
        required: ['agent_role', 'prompt_file', 'output_file'],
    },
};
const jobTools = getJobManagementToolSchemas('codex');
const server = new Server({ name: 'x', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [askCodexTool, ...jobTools],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'ask_codex') {
        const { prompt_file, output_file, agent_role, model, context_files, background, working_directory } = (args ?? {});
        return handleAskCodex({ prompt_file, output_file, agent_role, model, context_files, background, working_directory });
    }
    if (name === 'wait_for_job') {
        const { job_id, timeout_ms } = (args ?? {});
        return handleWaitForJob('codex', job_id, timeout_ms);
    }
    if (name === 'check_job_status') {
        const { job_id } = (args ?? {});
        return handleCheckJobStatus('codex', job_id);
    }
    if (name === 'kill_job') {
        const { job_id, signal } = (args ?? {});
        return handleKillJob('codex', job_id, signal || undefined);
    }
    if (name === 'list_jobs') {
        const { status_filter, limit } = (args ?? {});
        return handleListJobs('codex', status_filter || undefined, limit);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Codex MCP Server running on stdio');
}
main().catch((error) => {
    console.error('Failed to start Codex server:', error);
    process.exit(1);
});
//# sourceMappingURL=codex-standalone-server.js.map