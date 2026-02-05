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
  GEMINI_MODEL_FALLBACKS,
  GEMINI_VALID_ROLES,
  handleAskGemini
} from './gemini-core.js';

// Define the ask_gemini tool using the SDK tool() helper
const askGeminiTool = tool(
  "ask_gemini",
  "Send a prompt to Google Gemini CLI for design/implementation tasks. Gemini excels at frontend design review and implementation with its 1M token context window. Requires agent_role (designer, writer, vision). Fallback chain: gemini-3-pro-preview → gemini-3-flash-preview → gemini-2.5-pro → gemini-2.5-flash. Requires Gemini CLI (npm install -g @google/gemini-cli).",
  {
    agent_role: { type: "string", description: `Required. Agent perspective for Gemini: ${GEMINI_VALID_ROLES.join(', ')}. Gemini is optimized for design/implementation tasks with large context.` },
    prompt_file: { type: "string", description: "Path to file containing the prompt" },
    output_file: { type: "string", description: "Required. Path to write response. Response content is NOT returned inline - read from this file." },
    files: { type: "array", items: { type: "string" }, description: "File paths to include as context (contents will be prepended to prompt)" },
    model: { type: "string", description: `Gemini model to use (default: ${GEMINI_DEFAULT_MODEL}). Set OMC_GEMINI_DEFAULT_MODEL env var to change default. Auto-fallback chain: ${GEMINI_MODEL_FALLBACKS.join(' → ')}.` },
    background: { type: "boolean", description: "Run in background (non-blocking). Returns immediately with job metadata and file paths. Check response file for completion." },
    working_directory: { type: "string", description: "Working directory for path resolution and CLI execution. Defaults to process.cwd()." },
  } as any,
  async (args: any) => {
    const { prompt_file, output_file, agent_role, model, files, background, working_directory } = args as {
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
);

/**
 * In-process MCP server exposing Gemini CLI integration
 *
 * Tools will be available as mcp__g__ask_gemini
 */
export const geminiMcpServer = createSdkMcpServer({
  name: "g",
  version: "1.0.0",
  tools: [askGeminiTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const geminiToolNames = ['ask_gemini'];
