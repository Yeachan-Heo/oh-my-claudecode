import * as sessionManager from './core/session-manager.js';
import { validateWorkingDirectory } from './utils/validation.js';
import type { User } from './types.js';

// Tool definitions for MCP
export const toolDefinitions = [
  {
    name: 'monkey_session_create',
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
    name: 'monkey_session_list',
    description: 'List all active Claude Code sessions',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'monkey_session_send',
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
    name: 'monkey_session_output',
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
    name: 'monkey_session_kill',
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
    name: 'monkey_status',
    description: 'Get the status of the monkey server',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'monkey_session_recover',
    description: 'Recover sessions after gateway restart (re-syncs with tmux)',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// SECURITY: MCP tools use a system user with admin role.
// This is intentional: MCP communicates over stdio, which is inherently
// local-only. The parent process (Claude Code) is already authenticated
// by the user who started it. Adding auth here would add no security value
// since anyone with stdio access already has full system access.
//
// If MCP transport changes to HTTP/SSE in the future, authentication
// MUST be added before that change.
const systemUser: User = {
  id: 'system',
  username: 'mcp-client',
  role: 'admin',
  createdAt: new Date(),
};

// Tool implementations - call session-manager directly (no IPC)
export function createTools(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    monkey_session_create: async (args) => {
      const { name, workingDirectory, initialPrompt } = args as {
        name: string;
        workingDirectory: string;
        initialPrompt?: string;
      };
      const validatedDir = validateWorkingDirectory(workingDirectory);
      const session = await sessionManager.createSession({
        name,
        workingDirectory: validatedDir,
        user: systemUser,
        initialPrompt,
      });
      return { sessionId: session.id, name: session.name, status: session.status };
    },

    monkey_session_list: async () => {
      const sessions = sessionManager.listActiveSessions();
      return sessions.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        workingDirectory: s.workingDirectory,
        createdAt: s.createdAt,
      }));
    },

    monkey_session_send: async (args) => {
      const { sessionId, prompt } = args as { sessionId: string; prompt: string };
      await sessionManager.sendPrompt(sessionId, prompt, systemUser);
      return { success: true, sessionId };
    },

    monkey_session_output: async (args) => {
      const { sessionId, lines = 100 } = args as { sessionId: string; lines?: number };
      const output = sessionManager.getOutput(sessionId, lines);
      return { sessionId, output };
    },

    monkey_session_kill: async (args) => {
      const { sessionId } = args as { sessionId: string };
      sessionManager.killSession(sessionId, systemUser);
      return { success: true, sessionId };
    },

    monkey_status: async () => {
      return sessionManager.getStatus();
    },

    monkey_session_recover: async () => {
      sessionManager.recoverSessions();
      const active = sessionManager.listActiveSessions();
      return { recovered: active.length, sessions: active.map(s => s.name) };
    },
  };
}
