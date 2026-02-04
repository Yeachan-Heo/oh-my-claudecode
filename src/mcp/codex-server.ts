/**
 * Codex MCP Server - In-process MCP server for OpenAI Codex CLI integration
 *
 * Exposes `ask_codex` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__x__ask_codex
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { detectCodexCli } from './cli-detection.js';

// Default model can be overridden via environment variable
const CODEX_DEFAULT_MODEL = process.env.OMC_CODEX_DEFAULT_MODEL || 'gpt-5.2';
const CODEX_TIMEOUT = parseInt(process.env.OMC_CODEX_TIMEOUT || '60000', 10);

/**
 * Parse Codex JSONL output to extract the final text response
 */
function parseCodexOutput(output: string): string {
  const lines = output.trim().split('\n').filter(l => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Look for message events with text content
      if (event.type === 'message' && event.content) {
        if (typeof event.content === 'string') {
          messages.push(event.content);
        } else if (Array.isArray(event.content)) {
          for (const part of event.content) {
            if (part.type === 'text' && part.text) {
              messages.push(part.text);
            }
          }
        }
      }
      // Also handle output_text events
      if (event.type === 'output_text' && event.text) {
        messages.push(event.text);
      }
    } catch {
      // Skip non-JSON lines (progress indicators, etc.)
    }
  }

  return messages.join('\n') || output; // Fallback to raw output
}

/**
 * Execute Codex CLI command and return the response
 */
function executeCodex(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-m', model, '--json', prompt];
    const child = spawn('codex', args, {
      timeout: CODEX_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 || stdout.trim()) {
        resolve(parseCodexOutput(stdout));
      } else {
        reject(new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
    });
  });
}

// Define the ask_codex tool using the SDK tool() helper
const askCodexTool = tool(
  "ask_codex",
  "Send a prompt to OpenAI Codex CLI for a second-opinion analysis, code generation, or debugging perspective. Returns Codex's text response. Requires Codex CLI to be installed (npm install -g @openai/codex).",
  {
    prompt: { type: "string", description: "The prompt to send to Codex" },
    model: { type: "string", description: `Codex model to use (default: ${CODEX_DEFAULT_MODEL}). Set OMC_CODEX_DEFAULT_MODEL env var to change default. Options include: gpt-4o, gpt-4o-mini, o3-mini, o4-mini` },
    context_files: { type: "array", items: { type: "string" }, description: "File paths to include as context (contents will be prepended to prompt)" },
  } as any,
  async (args: any) => {
    const { prompt, model = CODEX_DEFAULT_MODEL, context_files } = args as {
      prompt: string;
      model?: string;
      context_files?: string[];
    };

    // Check CLI availability
    const detection = detectCodexCli();
    if (!detection.available) {
      return {
        content: [{
          type: 'text' as const,
          text: `Codex CLI is not available: ${detection.error}\n\n${detection.installHint}`
        }]
      };
    }

    // Build prompt with file context
    let fullPrompt = prompt;
    if (context_files && context_files.length > 0) {
      const fileContents = context_files.map(f => {
        try {
          return `--- File: ${f} ---\n${readFileSync(f, 'utf-8')}`;
        } catch (err) {
          return `--- File: ${f} --- (Error reading: ${(err as Error).message})`;
        }
      }).join('\n\n');
      fullPrompt = `${fileContents}\n\n${prompt}`;
    }

    try {
      const response = await executeCodex(fullPrompt, model);
      return {
        content: [{
          type: 'text' as const,
          text: response
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Codex CLI error: ${(err as Error).message}`
        }]
      };
    }
  }
);

/**
 * In-process MCP server exposing Codex CLI integration
 *
 * Tools will be available as mcp__x__ask_codex
 */
export const codexMcpServer = createSdkMcpServer({
  name: "x",
  version: "1.0.0",
  tools: [askCodexTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const codexToolNames = ['ask_codex'];
