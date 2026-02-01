/**
 * ClawdCoder Tools
 *
 * MCP tools for controlling ClawdCoder bot sessions via IPC.
 * Allows creating, managing, and interacting with Claude Code sessions
 * that are controlled via Discord/Telegram.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Tool definition type (same as lsp-tools.ts)
export interface ToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

// IPC helpers
function getPidPath(): string {
  return join(homedir(), '.omc', 'state', 'clawdcoder.pid');
}

function getSocketPath(): string {
  return join(homedir(), '.omc', 'state', 'clawdcoder.sock');
}

function isBotRunning(): boolean {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return false;

  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    return false;
  }
}

async function sendIpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();

    if (!existsSync(socketPath)) {
      reject(new Error('ClawdCoder is not running. Start with: omc clawdcoder start'));
      return;
    }

    const client = connect(socketPath);
    let response = '';

    client.on('connect', () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now(),
      });
      client.write(request + '\n');
    });

    client.on('data', (data) => {
      response += data.toString();
      if (response.includes('\n')) {
        try {
          const parsed = JSON.parse(response.trim());
          if (parsed.error) {
            reject(new Error(parsed.error.message));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Invalid response: ${response}`));
        }
        client.end();
      }
    });

    client.on('error', (err) => {
      reject(new Error(`IPC error: ${err.message}`));
    });

    client.on('timeout', () => {
      reject(new Error('IPC timeout'));
      client.destroy();
    });

    client.setTimeout(30000);
  });
}

function notRunningResponse(): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text' as const,
      text: 'ClawdCoder is not running. Start with: omc clawdcoder start\n\nTo configure ClawdCoder, run: /oh-my-claudecode:omc-setup'
    }]
  };
}

// Tool definitions
export const clawdcoderSessionCreate: ToolDefinition<{
  name: z.ZodString;
  project_dir: z.ZodString;
  prompt: z.ZodOptional<z.ZodString>;
}> = {
  name: 'clawdcoder_session_create',
  description: 'Create a new Claude Code session in ClawdCoder. The session runs in a tmux pane and can be controlled via Discord/Telegram.',
  schema: {
    name: z.string().describe('Unique name for the session'),
    project_dir: z.string().describe('Working directory for the session'),
    prompt: z.string().optional().describe('Optional initial prompt to send to Claude'),
  },
  handler: async (args) => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      const result = await sendIpcRequest('session.create', {
        name: args.name,
        projectDir: args.project_dir,
        prompt: args.prompt,
      }) as { sessionId: string; tmuxSession: string };

      return {
        content: [{
          type: 'text' as const,
          text: `Session created successfully!\n\nSession ID: ${result.sessionId}\ntmux session: ${result.tmuxSession}\n\nYou can now send prompts via Discord/Telegram or use clawdcoder_session_send.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error creating session: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

export const clawdcoderSessionList: ToolDefinition<Record<string, never>> = {
  name: 'clawdcoder_session_list',
  description: 'List all active ClawdCoder sessions',
  schema: {},
  handler: async () => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      const result = await sendIpcRequest('session.list') as Array<{
        id: string;
        name: string;
        status: string;
        workingDirectory: string;
        createdAt: string;
      }>;

      if (result.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active sessions.\n\nUse clawdcoder_session_create to start a new session.'
          }]
        };
      }

      const lines = result.map(s =>
        `- ${s.name} (${s.id})\n  Status: ${s.status}\n  Directory: ${s.workingDirectory}\n  Created: ${s.createdAt}`
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Active sessions (${result.length}):\n\n${lines.join('\n\n')}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing sessions: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

export const clawdcoderSessionSend: ToolDefinition<{
  session_id: z.ZodString;
  prompt: z.ZodString;
}> = {
  name: 'clawdcoder_session_send',
  description: 'Send a prompt to an existing ClawdCoder session',
  schema: {
    session_id: z.string().describe('Session ID or name'),
    prompt: z.string().describe('Prompt to send to Claude'),
  },
  handler: async (args) => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      const result = await sendIpcRequest('session.send', {
        sessionId: args.session_id,
        prompt: args.prompt,
      }) as { queuePosition: number };

      return {
        content: [{
          type: 'text' as const,
          text: `Prompt sent to session.\n\nQueue position: ${result.queuePosition}\n\nUse clawdcoder_session_output to see the response.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error sending prompt: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

export const clawdcoderSessionOutput: ToolDefinition<{
  session_id: z.ZodString;
  lines: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'clawdcoder_session_output',
  description: 'Get the current terminal output from a ClawdCoder session',
  schema: {
    session_id: z.string().describe('Session ID or name'),
    lines: z.number().int().optional().describe('Number of lines to capture (default: 100)'),
  },
  handler: async (args) => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      const result = await sendIpcRequest('session.output', {
        sessionId: args.session_id,
        lines: args.lines ?? 100,
      }) as { output: string };

      return {
        content: [{
          type: 'text' as const,
          text: result.output || '(No output captured)'
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting output: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

export const clawdcoderSessionKill: ToolDefinition<{
  session_id: z.ZodString;
}> = {
  name: 'clawdcoder_session_kill',
  description: 'Terminate a ClawdCoder session',
  schema: {
    session_id: z.string().describe('Session ID or name'),
  },
  handler: async (args) => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      await sendIpcRequest('session.kill', {
        sessionId: args.session_id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Session terminated successfully.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error killing session: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

export const clawdcoderStatus: ToolDefinition<Record<string, never>> = {
  name: 'clawdcoder_status',
  description: 'Get ClawdCoder bot status including uptime, active sessions, and platform connections',
  schema: {},
  handler: async () => {
    if (!isBotRunning()) return notRunningResponse();

    try {
      const result = await sendIpcRequest('status') as {
        activeSessions: number;
        maxSessions: number;
        uptime: number;
        discordConnected: boolean;
        telegramConnected: boolean;
      };

      const uptimeSeconds = Math.floor(result.uptime / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

      const discordStatus = result.discordConnected ? '🟢 Connected' : '🔴 Disconnected';
      const telegramStatus = result.telegramConnected ? '🟢 Connected' : '🔴 Disconnected';

      return {
        content: [{
          type: 'text' as const,
          text: `ClawdCoder Status\n\n` +
            `Uptime: ${uptimeStr}\n` +
            `Sessions: ${result.activeSessions}/${result.maxSessions}\n\n` +
            `Platforms:\n` +
            `  Discord: ${discordStatus}\n` +
            `  Telegram: ${telegramStatus}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// Export all tools as array
export const clawdcoderTools = [
  clawdcoderSessionCreate,
  clawdcoderSessionList,
  clawdcoderSessionSend,
  clawdcoderSessionOutput,
  clawdcoderSessionKill,
  clawdcoderStatus,
];
