import * as sessionManager from './core/session-manager.js';
import type { User } from './types.js';

// Tool definitions for MCP
export const toolDefinitions = [
  {
    name: 'clawd_session_create',
    description: 'Create a new Claude Code session in a tmux window',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name' },
        workingDirectory: { type: 'string', description: 'Working directory path' },
        initialPrompt: { type: 'string', description: 'Optional initial prompt to send' },
      },
      required: ['name', 'workingDirectory'],
    },
  },
  {
    name: 'clawd_session_list',
    description: 'List all active Claude Code sessions',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'clawd_session_send',
    description: 'Send a prompt to an active Claude Code session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        prompt: { type: 'string', description: 'Prompt to send' },
      },
      required: ['sessionId', 'prompt'],
    },
  },
  {
    name: 'clawd_session_output',
    description: 'Get the terminal output from a Claude Code session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        lines: { type: 'number', description: 'Number of lines to retrieve (default 100)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'clawd_session_kill',
    description: 'Terminate a Claude Code session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID to terminate' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'clawd_status',
    description: 'Get the status of the clawd server',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// System user for MCP tool calls (no platform authentication)
const systemUser: User = {
  id: 'system',
  username: 'mcp-client',
  role: 'admin',
  createdAt: new Date(),
};

// Tool implementations - call session-manager directly (no IPC)
export function createTools(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    clawd_session_create: async (args) => {
      const { name, workingDirectory, initialPrompt } = args as {
        name: string;
        workingDirectory: string;
        initialPrompt?: string;
      };
      const session = await sessionManager.createSession({
        name,
        workingDirectory,
        user: systemUser,
        initialPrompt,
      });
      return { sessionId: session.id, name: session.name, status: session.status };
    },

    clawd_session_list: async () => {
      const sessions = sessionManager.listActiveSessions();
      return sessions.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        workingDirectory: s.workingDirectory,
        createdAt: s.createdAt,
      }));
    },

    clawd_session_send: async (args) => {
      const { sessionId, prompt } = args as { sessionId: string; prompt: string };
      await sessionManager.sendPrompt(sessionId, prompt, systemUser);
      return { success: true, sessionId };
    },

    clawd_session_output: async (args) => {
      const { sessionId, lines = 100 } = args as { sessionId: string; lines?: number };
      const output = sessionManager.getOutput(sessionId, lines);
      return { sessionId, output };
    },

    clawd_session_kill: async (args) => {
      const { sessionId } = args as { sessionId: string };
      sessionManager.killSession(sessionId);
      return { success: true, sessionId };
    },

    clawd_status: async () => {
      return sessionManager.getStatus();
    },
  };
}
