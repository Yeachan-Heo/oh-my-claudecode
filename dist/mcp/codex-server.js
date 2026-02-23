/**
 * Codex MCP Server - In-process MCP server for OpenAI Codex CLI integration
 *
 * Exposes `ask_codex` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__x__ask_codex
 *
 * Note: The standalone version (codex-standalone-server.ts) is used for the
 * external-process .mcp.json registration with proper stdio transport.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { handleAskCodex, CODEX_DEFAULT_MODEL, CODEX_RECOMMENDED_ROLES } from './codex-core.js';
import { handleWaitForJob, handleCheckJobStatus, handleKillJob, handleListJobs } from './job-management.js';
import { normalizeCodexAskArgsForCallSite } from './codex-request-normalizer.js';
// Define the ask_codex tool using the SDK tool() helper
const askCodexTool = tool("ask_codex", `Send a prompt to OpenAI Codex CLI for analytical/planning tasks. Codex excels at architecture review, planning validation, critical analysis, and code/security review validation. Requires agent_role to specify the perspective. Recommended roles: ${CODEX_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted. Requires Codex CLI (npm install -g @openai/codex).`, {
    agent_role: { type: "string", description: `Required. Agent perspective for Codex. Recommended: ${CODEX_RECOMMENDED_ROLES.join(', ')}. Any valid OMC agent role is accepted.` },
    prompt: { type: "string", description: "Inline prompt text for foreground runs. Alternative to prompt_file -- the tool auto-persists to a file for audit trail. If both prompt and prompt_file are provided, prompt_file takes precedence." },
    prompt_file: { type: "string", description: "Path to file containing the prompt. Required unless 'prompt' is provided inline. A defined (non-undefined) `prompt_file` value selects file mode; `prompt_file` must be a non-empty string when used. Passing null or non-string values triggers file-mode validation (not inline fallback)." },
    output_file: { type: "string", description: "Required for file-based mode (prompt_file). Auto-generated in inline mode (prompt). Response content is returned inline only when using prompt parameter." },
    context_files: { type: "array", items: { type: "string" }, description: "File paths to pass to Codex for reference (Codex will read them using its own file tools)" },
    model: { type: "string", description: `Codex model to use (default: ${CODEX_DEFAULT_MODEL}). Set OMC_CODEX_DEFAULT_MODEL env var to change default.` },
    reasoning_effort: { type: "string", description: "Codex reasoning effort level: 'minimal', 'low', 'medium' (Codex CLI default), 'high', or 'xhigh' (model-dependent). Maps to Codex CLI -c model_reasoning_effort. If omitted, uses Codex CLI default from ~/.codex/config.toml." },
    background: { type: "boolean", description: "Run in background (non-blocking). Contract: background uses prompt_file mode only. Call-site normalizes inline-only background requests into persisted prompt_file/output_file paths before execution." },
    working_directory: { type: "string", description: "Working directory for path resolution and CLI execution. Defaults to process.cwd()." },
}, async (args) => {
    let normalizedArgs;
    try {
        normalizedArgs = normalizeCodexAskArgsForCallSite(args);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Failed to prepare background prompt_file contract: ${reason}` }],
            isError: true
        };
    }
    const { prompt, prompt_file, output_file, agent_role, model, reasoning_effort, context_files, background, working_directory } = normalizedArgs;
    return handleAskCodex({ prompt, prompt_file, output_file, agent_role, model, reasoning_effort, context_files, background, working_directory });
});
const waitForJobTool = tool("wait_for_job", "Block (poll) until a background job reaches a terminal state (completed, failed, or timeout). Uses exponential backoff. Returns the response preview on success.", {
    job_id: { type: "string", description: "The job ID returned when the background job was dispatched." },
    timeout_ms: { type: "number", description: "Maximum time to wait in milliseconds (default: 3600000, max: 3600000)." },
}, async (args) => {
    const { job_id, timeout_ms } = args;
    return handleWaitForJob('codex', job_id, timeout_ms);
});
const checkJobStatusTool = tool("check_job_status", "Non-blocking status check for a background job. Returns current status, metadata, and error information if available.", {
    job_id: { type: "string", description: "The job ID returned when the background job was dispatched." },
}, async (args) => {
    const { job_id } = args;
    return handleCheckJobStatus('codex', job_id);
});
const killJobTool = tool("kill_job", "Send a signal to a running background job. Marks the job as failed. Only works on jobs in spawned or running state.", {
    job_id: { type: "string", description: "The job ID of the running job to kill." },
    signal: { type: "string", description: "The signal to send (default: SIGTERM)." },
}, async (args) => {
    const { job_id, signal } = args;
    return handleKillJob('codex', job_id, signal || undefined);
});
const listJobsTool = tool("list_jobs", "List background jobs for this provider. Filter by status and limit results. Results sorted newest first.", {
    status_filter: { type: "string", description: "Filter jobs by status (default: active)." },
    limit: { type: "number", description: "Maximum number of jobs to return (default: 50)." },
}, async (args) => {
    const { status_filter, limit } = args;
    return handleListJobs('codex', status_filter || undefined, limit);
});
/**
 * In-process MCP server exposing Codex CLI integration
 *
 * Tools will be available as mcp__x__ask_codex
 */
export const codexMcpServer = createSdkMcpServer({
    name: "x",
    version: "1.0.0",
    tools: [askCodexTool, waitForJobTool, checkJobStatusTool, killJobTool, listJobsTool]
});
/**
 * Tool names for allowedTools configuration
 */
export const codexToolNames = ['ask_codex', 'wait_for_job', 'check_job_status', 'kill_job', 'list_jobs'];
//# sourceMappingURL=codex-server.js.map
